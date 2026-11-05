/**
 * Public SDK entry point. The SDK has no extensions of its own: pass them in.
 *
 *   const PieLive = Pie.layer({ storage: Storage.sqlite(".data/pie.db"), plugins: [opencodeGo, codingTools] })
 *   const pie = yield* Pie.Pie
 *   const session = yield* pie.create({ cwd, model: "opencode-go/deepseek-v4.1-flash" })
 *   yield* session.prompt("...")
 *   const outcome = yield* session.awaitIdle
 */
import * as Package from "./core/Package.ts"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Stream } from "effect"
import { AbortSignals } from "./core/AbortSignals.ts"
import type * as Agent from "./core/Agent.ts"
import * as Core from "./core/Core.ts"
import { Events, type PieEvent } from "./core/Events.ts"
import { type Blob, EventLog, type LogEvent, type SessionInfo, type SessionNotFound } from "./core/Log.ts"
import * as LogWorkflowEngine from "./core/LogWorkflowEngine.ts"
import * as Plugin from "./core/Plugin.ts"
import { foldProjection, PluginHost } from "./core/PluginHost.ts"
import { Registries } from "./core/Registry.ts"
import { type AttachmentInput, type PromptOptions, Runtime, type SessionBusy } from "./core/Runtime.ts"
import * as Storage from "./core/Storage.ts"

export type { AttachmentInput, PromptOptions } from "./core/Runtime.ts"

export type Outcome = Agent.CoreEvents["run/ended"]

/** A message waiting to be delivered to the model while a run is active. */
export type QueuedInput = Agent.CoreEvents["input/queued"]

/** A session as listed: its info plus what a list of threads shows. */
export interface SessionSummary extends SessionInfo {
  /** The first thing the user said in it, if anything. */
  readonly title: string | undefined
  /** When something last happened in it. */
  readonly updatedAt: number
  /** Whether a run is active now. */
  readonly status: "running" | "idle"
  /** How the last run ended, if one did. */
  readonly lastOutcome: Agent.RunStatus | undefined
}

export interface Session {
  readonly id: string
  readonly info: Effect.Effect<SessionInfo>
  /** Starts a run. Fails with SessionBusy if one is active and no streamingBehavior is given. */
  readonly prompt: (text: string, options?: PromptOptions) => Effect.Effect<void, SessionBusy>
  /** Delivered after the current tool calls finish; starts a run if idle. */
  readonly steer: (text: string, options?: { readonly attachments?: ReadonlyArray<AttachmentInput> }) => Effect.Effect<void>
  /** Delivered when the agent would otherwise stop; starts a run if idle. */
  readonly followUp: (text: string, options?: { readonly attachments?: ReadonlyArray<AttachmentInput> }) => Effect.Effect<void>
  /** Messages waiting to be delivered, in order. */
  readonly queued: Effect.Effect<ReadonlyArray<QueuedInput>>
  /** Delivers a queued message at the next step (it becomes a steer) instead of when the run would stop. */
  readonly deliverNow: (inputId: string) => Effect.Effect<void>
  /** Withdraws a queued message that has not been delivered yet. */
  readonly cancelQueued: (inputId: string) => Effect.Effect<void>
  /** The data of a file attached to a message (`attachments[].blob` of a `user` or `input/queued` event). */
  readonly attachment: (blob: string) => Effect.Effect<Blob | undefined>
  readonly abort: Effect.Effect<void>
  /** Waits until no run is active; returns the last run's outcome. */
  readonly awaitIdle: Effect.Effect<Outcome | undefined>
  /** Events of the current branch, root first: the whole truth of the session. */
  readonly events: Effect.Effect<ReadonlyArray<LogEvent>>
  /** The current value of an extension's projection on this session's branch (undefined if no such projection). */
  readonly projection: <S = unknown>(projectionId: string) => Effect.Effect<S | undefined>
  /** Moves the session to an earlier event; the next prompt branches from there. */
  readonly navigate: (eventId: string | null) => Effect.Effect<void, SessionBusy>
  readonly setModel: (model: string) => Effect.Effect<void>
  readonly state: Effect.Effect<Agent.AgentState>
  /** Live: every appended event plus streaming deltas. */
  readonly live: Stream.Stream<PieEvent>
}

export class Pie extends Context.Service<Pie, {
  readonly create: (options: { readonly cwd: string; readonly model: string; readonly id?: string }) => Effect.Effect<Session>
  readonly open: (id: string) => Effect.Effect<Session, SessionNotFound>
  /** Every session with its title, last activity and status, most recent first. */
  readonly list: Effect.Effect<ReadonlyArray<SessionSummary>>
  readonly live: Stream.Stream<PieEvent>
}>()("pie/Pie") {}

const make = Effect.gen(function*() {
  const log = yield* EventLog
  const runtime = yield* Runtime
  const events = yield* Events
  const registries = yield* Registries

  const handle = (id: string): Session => ({
    id,
    info: Effect.orDie(log.getSession(id)),
    prompt: (text, options) => runtime.prompt(id, text, options).pipe(Effect.catchTag("SessionNotFound", Effect.die)),
    steer: (text, options) => Effect.orDie(runtime.enqueue(id, "steer", text, options?.attachments)),
    followUp: (text, options) => Effect.orDie(runtime.enqueue(id, "followUp", text, options?.attachments)),
    queued: Effect.map(Effect.orDie(runtime.state(id)), (state) => state.queued),
    deliverNow: (inputId) => Effect.orDie(runtime.requeue(id, inputId, "steer")),
    cancelQueued: (inputId) => Effect.orDie(runtime.cancelQueued(id, inputId)),
    attachment: (blob) => log.getBlob(blob),
    abort: Effect.orDie(runtime.abort(id)),
    awaitIdle: Effect.orDie(runtime.awaitIdle(id)),
    events: log.branch(id),
    projection: <S>(projectionId: string) =>
      Effect.gen(function*() {
        const definition = (yield* registries.projections.get).get(projectionId)
        if (!definition) return undefined
        return foldProjection(definition, yield* log.branch(id)) as S
      }),
    navigate: (eventId) => runtime.navigate(id, eventId).pipe(Effect.catchTag("SessionNotFound", Effect.die)),
    setModel: (model) => Effect.orDie(runtime.setModel(id, model)),
    state: Effect.orDie(runtime.state(id)),
    live: events.stream(id)
  })

  return Pie.of({
    create: ({ cwd, id, model }) => Effect.map(log.createSession({ id: id ?? randomUUID(), cwd, model }), (info) => handle(info.id)),
    open: (id) => Effect.map(log.getSession(id), (info) => handle(info.id)),
    list: Effect.gen(function*() {
      const sessions = yield* log.listSessions
      const activity = yield* log.activity
      const rows: Array<SessionSummary> = []
      for (const info of sessions) {
        const state = yield* Effect.orDie(runtime.state(info.id))
        const seen = activity.get(info.id)
        rows.push({
          ...info,
          title: seen?.title,
          updatedAt: seen?.updatedAt ?? info.createdAt,
          status: state.run ? "running" : "idle",
          lastOutcome: state.lastOutcome?.status
        })
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt)
    }),
    live: events.stream()
  })
})

/** An extension, or an extension with the options it reads from `ctx.options`. */
export type PluginEntry = Plugin.Plugin | { readonly plugin: Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> | undefined }

export interface LayerOptions {
  /**
   * The extensions, loaded in order: models, tools, prompt parts, hooks,
   * events... The SDK brings none; the official ones are in @pie-agent/plugins.
   * A failing extension fails the boot.
   */
  readonly plugins?: ReadonlyArray<PluginEntry>
  /** Where sessions are stored. Default Storage.memory: nothing survives the process. */
  readonly storage?: Storage.Storage
}

/** Root of the SDK package. */
export const SDK_ROOT = Package.ROOT

/** What the agent may read but not write: the SDK's code, its docs and its manifest. */
export const SDK_PROTECTED = ["src", "dist", "docs", "package.json"].map((p) => path.join(SDK_ROOT, p))

/**
 * Always loaded first: `write` and `edit` inside the installed SDK are denied,
 * so an agent that changes the program it runs in edits that program, not
 * Pie. (A shell command can still write anywhere the user can; this stops the
 * normal path, not a determined one.)
 */
const sdkGuard = Plugin.define({
  id: "sdk-guard",
  setup: (ctx) =>
    ctx.hook("tool.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== "write" && event.tool !== "edit") return
        const target = (event.params as { path?: unknown }).path
        if (typeof target !== "string") return
        const resolved = path.resolve(event.cwd, target)
        if (SDK_PROTECTED.some((p) => resolved === p || resolved.startsWith(p + path.sep))) {
          event.decision = { _tag: "Deny", reason: `${resolved} is part of the installed Pie SDK and is read-only.` }
        }
      }))
})

export const layer = (options: LayerOptions = {}) => {
  const entries = [sdkGuard, ...(options.plugins ?? [])].map((p) => ("plugin" in p ? p : { plugin: p }))

  // Extensions load in order, then the runtime starts (resuming open runs and catching up reactions).
  const startup = Layer.effectDiscard(Effect.gen(function*() {
    const host = yield* PluginHost
    for (const [i, entry] of entries.entries()) {
      yield* host.load(entry.plugin, { options: entry.options, order: 100 * (i + 1) }).pipe(
        Effect.catchTag("PluginLoadError", (e) => Effect.die(new Error(`extension "${e.id}" failed to load: ${e.message}`)))
      )
    }
    yield* (yield* Runtime).start
  }))

  const base = Layer.mergeAll(
    Layer.effect(EventLog, EventLog.make),
    Layer.effect(Events, Events.make),
    Layer.effect(AbortSignals, AbortSignals.make)
  )

  return Layer.effect(Pie, make).pipe(
    Layer.provideMerge(startup),
    Layer.provideMerge(LogWorkflowEngine.layer),
    Layer.provideMerge(Layer.effect(Runtime, Runtime.make)),
    Layer.provideMerge(Core.layer),
    Layer.provideMerge(base),
    Layer.provideMerge(options.storage ?? Storage.memory),
    Layer.provideMerge(NodeServices.layer)
  )
}

export { Runtime }
