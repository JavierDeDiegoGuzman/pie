/**
 * Public SDK entry point.
 *
 *   const PieLive = Pie.layer({ storage: Storage.sqlite("pie.db"), plugins: [OpenCodeGoPlugin] })
 *   const pie = yield* Pie
 *   const session = yield* pie.create({ cwd, model: "opencode-go/deepseek-v4.1-flash" })
 *   yield* session.prompt("...")
 *   yield* session.awaitIdle
 */
import { randomUUID } from "node:crypto"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Schedule, type Stream } from "effect"
import type { WorkflowEngine } from "effect/workflow"
import type { SqlClient } from "effect/sql"
import { AbortSignals } from "./core/AbortSignals.ts"
import * as ModuleResolution from "./core/ModuleResolution.ts"
import CodingToolsPlugin from "./plugins/coding-tools.ts"
import ContextFilesPlugin from "./plugins/context-files.ts"
import OpenCodeGoPlugin from "./plugins/opencode-go.ts"
import * as SelfPlugin from "./plugins/self.ts"
import SystemPromptPlugin from "./plugins/system-prompt.ts"
import { AgentRun, AgentRunLive } from "./core/AgentRun.ts"
import * as Core from "./core/Core.ts"
import { Events, type PieEvent } from "./core/Events.ts"
import type { Plugin } from "./core/Plugin.ts"
import { PluginHost, type PluginLoadError } from "./core/PluginHost.ts"
import { PluginLoader } from "./core/PluginLoader.ts"
import {
  type Entry,
  type RunOutcome,
  SessionBusy,
  type SessionInfo,
  type SessionNotFound,
  SessionStore
} from "./core/Session.ts"

export interface PromptOptions {
  /** Required while a run is active: queue the text instead of failing. */
  readonly streamingBehavior?: "steer" | "followUp" | undefined
}

export interface Session {
  readonly id: string
  readonly info: Effect.Effect<SessionInfo>
  /** Starts a run. Fails with SessionBusy if one is active and no streamingBehavior is given. */
  readonly prompt: (text: string, options?: PromptOptions) => Effect.Effect<void, SessionBusy>
  /** Delivered after the current tool calls finish; starts a run if idle. */
  readonly steer: (text: string) => Effect.Effect<void>
  /** Delivered when the agent would otherwise stop; starts a run if idle. */
  readonly followUp: (text: string) => Effect.Effect<void>
  readonly abort: Effect.Effect<void>
  /** Waits until no run is active and returns the last run's outcome. */
  readonly awaitIdle: Effect.Effect<RunOutcome | undefined>
  /** Entries of the current branch, root first. */
  readonly entries: Effect.Effect<ReadonlyArray<Entry>>
  /** Live events of this session (not replayed: read `entries` for history). */
  readonly events: Stream.Stream<PieEvent>
}

export class Pie extends Context.Service<Pie, {
  readonly create: (options: { readonly cwd: string; readonly model: string; readonly id?: string }) => Effect.Effect<Session>
  readonly open: (id: string) => Effect.Effect<Session, SessionNotFound>
  readonly list: Effect.Effect<ReadonlyArray<SessionInfo>>
  readonly events: Stream.Stream<PieEvent>
}>()("pie/Pie") {}

const make = Effect.gen(function*() {
  const store = yield* SessionStore
  const events = yield* Events
  const signals = yield* AbortSignals
  const engine = yield* Effect.context<WorkflowEngine.WorkflowEngine>()

  const start = (sessionId: string, runId: string) =>
    events.publish({ type: "agent_start", sessionId, runId }).pipe(
      Effect.andThen(AgentRun.execute({ sessionId, runId }, { discard: true })),
      Effect.provideContext(engine)
    )

  const handle = (id: string): Session => {
    const queue = (kind: "steer" | "followUp", text: string) =>
      Effect.gen(function*() {
        const runId = randomUUID()
        const result = yield* store.enqueue(id, { id: randomUUID(), kind, text, runId }).pipe(Effect.orDie)
        if (result === "started") yield* start(id, runId)
      })
    return {
      id,
      info: Effect.orDie(store.get(id)),
      prompt: (text, options) =>
        Effect.gen(function*() {
          const runId = randomUUID()
          const begun = yield* store.beginRun(id, runId, text).pipe(
            Effect.catchTag("SessionNotFound", Effect.die),
            Effect.as(true),
            Effect.catchTag("SessionBusy", (busy) =>
              options?.streamingBehavior ? Effect.succeed(false) : Effect.fail(busy))
          )
          if (begun) return yield* start(id, runId)
          yield* queue(options!.streamingBehavior!, text)
        }),
      steer: (text) => queue("steer", text),
      followUp: (text) => queue("followUp", text),
      abort: Effect.gen(function*() {
        const { activeRun } = yield* Effect.orDie(store.get(id))
        if (activeRun === null) return
        yield* store.requestAbort(activeRun)
        yield* signals.fire(activeRun)
      }),
      awaitIdle: Effect.gen(function*() {
        yield* Effect.orDie(store.get(id)).pipe(
          Effect.repeat({ until: (s) => s.activeRun === null, schedule: Schedule.spaced("25 millis") })
        )
        const branch = yield* store.branch(id)
        const last = [...branch].reverse().find((e) => e.kind === "runEnd")
        return last?.kind === "runEnd" ? { status: last.data.status, ...(last.data.message ? { message: last.data.message } : {}) } : undefined
      }),
      entries: store.branch(id),
      events: events.stream(id)
    }
  }

  // Resume: re-attach every run that was active when the process stopped.
  // execute is idempotent by runId: a finished run returns its stored result,
  // an unfinished one continues from its last completed activity.
  for (const session of yield* store.listActive) {
    const runId = session.activeRun!
    yield* AgentRun.execute({ sessionId: session.id, runId }).pipe(
      Effect.flatMap((outcome) => store.endRun(session.id, runId, outcome)),
      Effect.catchCause(() => Effect.void),
      Effect.provideContext(engine),
      Effect.forkDetach
    )
  }

  return Pie.of({
    create: ({ cwd, model, id }) => Effect.map(store.create({ id: id ?? randomUUID(), cwd, model }), (info) => handle(info.id)),
    open: (id) => Effect.map(store.get(id), (info) => handle(info.id)),
    list: store.list,
    events: events.stream()
  })
})

export interface LayerOptions {
  /** Storage.sqlite(file) or Storage.memory. */
  readonly storage: Layer.Layer<SqlClient.SqlClient | WorkflowEngine.WorkflowEngine>
  /** Plugins loaded at startup, in order (built-ins first, typically). */
  readonly plugins?: ReadonlyArray<Plugin | { readonly plugin: Plugin; readonly options: Record<string, unknown> }>
  /**
   * Directories synced and watched for plugin files. The first one is where
   * the agent writes plugins (self-modification).
   */
  readonly pluginDirectories?: ReadonlyArray<string>
  /** Give the agent the plugin_* tools. Default: true when pluginDirectories is set. */
  readonly selfModify?: boolean
}

/** The plugins Pie ships with, in their default order. */
export const builtins: ReadonlyArray<Plugin> = [OpenCodeGoPlugin, SystemPromptPlugin, ContextFilesPlugin, CodingToolsPlugin]

export const layer = (options: LayerOptions) => {
  const loadPlugins = Layer.effectDiscard(Effect.gen(function*() {
    const host = yield* PluginHost
    const loader = yield* PluginLoader
    for (const entry of options.plugins ?? []) {
      const [plugin, pluginOptions] = "plugin" in entry ? [entry.plugin, entry.options] : [entry, {}]
      yield* host.load(plugin, { options: pluginOptions, source: `builtin:${plugin.id}` }).pipe(
        Effect.catchTag("PluginLoadError", (e: PluginLoadError) => Effect.logWarning(`plugin ${e.id} failed: ${e.message}`))
      )
    }
    const directories = options.pluginDirectories ?? []
    if (directories.length > 0) {
      ModuleResolution.register()
      if (options.selfModify ?? true) {
        yield* host.load(SelfPlugin.make({ host, loader, directory: directories[0]! }), { source: "builtin:self" }).pipe(Effect.orDie)
      }
    }
    for (const directory of directories) yield* loader.watch(directory)
  }))

  const runtime = Layer.mergeAll(
    Layer.effect(SessionStore, SessionStore.make),
    Layer.effect(Events, Events.make),
    Layer.effect(AbortSignals, AbortSignals.make)
  )

  return Layer.effect(Pie, make).pipe(
    Layer.provideMerge(AgentRunLive),
    Layer.provideMerge(loadPlugins),
    Layer.provideMerge(runtime),
    Layer.provideMerge(Core.layer),
    Layer.provideMerge(options.storage),
    Layer.provideMerge(NodeServices.layer)
  )
}

export { SessionBusy }
