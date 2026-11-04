/**
 * Public SDK entry point.
 *
 *   const PieLive = Pie.layer({ storage: Storage.sqlite("pie.db") })
 *   const pie = yield* Pie.Pie
 *   const session = yield* pie.create({ cwd, model: "opencode-go/deepseek-v4.1-flash" })
 *   yield* session.prompt("...")
 *   const outcome = yield* session.awaitIdle
 */
import * as Package from "./core/Package.ts"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, type Scope, Stream } from "effect"
import { AbortSignals } from "./core/AbortSignals.ts"
import type * as Agent from "./core/Agent.ts"
import { ConfigLog } from "./core/ConfigLog.ts"
import * as Core from "./core/Core.ts"
import { Events, type PieEvent } from "./core/Events.ts"
import { EventLog, type LogEvent, type SessionInfo, type SessionNotFound } from "./core/Log.ts"
import * as LogWorkflowEngine from "./core/LogWorkflowEngine.ts"
import * as ModuleResolution from "./core/ModuleResolution.ts"
import * as Plugin from "./core/Plugin.ts"
type Plugin = Plugin.Plugin
import { foldProjection, PluginHost } from "./core/PluginHost.ts"
import { Registries } from "./core/Registry.ts"
import { type HostEntry, Plugins } from "./core/Plugins.ts"
import { Runtime, type SessionBusy } from "./core/Runtime.ts"
import * as Storage from "./core/Storage.ts"
import { RESTART_EXIT_CODE } from "./Supervisor.ts"

export interface PromptOptions {
  /** Required while a run is active: queue the text instead of failing. */
  readonly streamingBehavior?: "steer" | "followUp" | undefined
}

export type Outcome = Agent.CoreEvents["run/ended"]

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
  /** Waits until no run is active; returns the last run's outcome. */
  readonly awaitIdle: Effect.Effect<Outcome | undefined>
  /** Events of the current branch, root first: the whole truth of the session. */
  readonly events: Effect.Effect<ReadonlyArray<LogEvent>>
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
  readonly list: Effect.Effect<ReadonlyArray<SessionInfo>>
  readonly live: Stream.Stream<PieEvent>
}>()("pie/Pie") {}

const make = Effect.gen(function*() {
  const log = yield* EventLog
  const runtime = yield* Runtime
  const events = yield* Events

  const handle = (id: string): Session => ({
    id,
    info: Effect.orDie(log.getSession(id)),
    prompt: (text, options) => runtime.prompt(id, text, options).pipe(Effect.catchTag("SessionNotFound", Effect.die)),
    steer: (text) => Effect.orDie(runtime.enqueue(id, "steer", text)),
    followUp: (text) => Effect.orDie(runtime.enqueue(id, "followUp", text)),
    abort: Effect.orDie(runtime.abort(id)),
    awaitIdle: Effect.orDie(runtime.awaitIdle(id)),
    events: log.branch(id),
    navigate: (eventId) => runtime.navigate(id, eventId).pipe(Effect.catchTag("SessionNotFound", Effect.die)),
    setModel: (model) => Effect.orDie(runtime.setModel(id, model)),
    state: Effect.orDie(runtime.state(id)),
    live: events.stream(id)
  })

  return Pie.of({
    create: ({ cwd, id, model }) => Effect.map(log.createSession({ id: id ?? randomUUID(), cwd, model }), (info) => handle(info.id)),
    open: (id) => Effect.map(log.getSession(id), (info) => handle(info.id)),
    list: log.listSessions,
    live: events.stream()
  })
})

export interface LayerOptions {
  /**
   * Pie's home (e.g. ".pie"): `pie.db` (sessions, configuration log) and
   * `plugins/` (every plugin, editable by the agent, seeded from the SDK
   * templates on first run). Without a home only host plugins load.
   */
  readonly home?: string
  /** Default: Storage.sqlite(<home>/pie.db), or Storage.memory without a home. */
  readonly storage?: Storage.Storage
  /** Templates copied into a new home, in load order. Default: DEFAULT_SEED. */
  readonly seed?: ReadonlyArray<string>
  /** Options for folder plugins, by id (e.g. { web: { port: 4100, cwd } }). */
  readonly pluginOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Host plugins: loaded from memory before the folder, not editable by the agent (tests, embedding apps). */
  readonly plugins?: ReadonlyArray<Plugin | HostEntry>
  /** Plugin ids that must load, or the boot fails (the supervisor then rolls back). */
  readonly required?: ReadonlyArray<string>
  /** Load the SDK templates instead of the plugins folder. Default: PIE_SAFE=1. */
  readonly safe?: boolean
  /** Mark the plugins snapshot good after this long running (ms), and after each completed run. Default 3000. */
  readonly goodAfter?: number
  /**
   * How the restart tool applies changes. "hot": in this process. "restart":
   * drain to a safe point and exit with RESTART_EXIT_CODE (use with
   * Supervisor.run / `pie serve` and Pie.exitOnRestart).
   */
  readonly reload?: "hot" | "restart"
}

/** Templates seeded into a new home by default, in load order. */
export const DEFAULT_SEED: ReadonlyArray<string> = ["opencode-go", "system-prompt", "context-files", "coding-tools", "self"]

/** Root of the SDK package. */
export const SDK_ROOT = Package.ROOT

/** What the agent may read but not write: the SDK's code, its plugin templates, its docs and its manifest. */
export const SDK_PROTECTED = ["src", "dist", "plugins", "docs", "package.json"].map((p) => path.join(SDK_ROOT, p))

/**
 * Host plugin that keeps the SDK read-only: write and edit inside it are
 * denied. It is not in the plugins folder, so the agent cannot edit it. (A
 * shell command can still write anywhere the user can; this stops the normal
 * path, not a determined one.)
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
          event.decision = {
            _tag: "Deny",
            reason: `Pie's SDK (${SDK_ROOT}) is read-only. Plugins live in your plugins folder; edit them there.`
          }
        }
      }))
})

export const layer = (options: LayerOptions) => {
  ModuleResolution.register()
  const home = options.home === undefined ? undefined : path.resolve(options.home)
  if (home) fs.mkdirSync(home, { recursive: true })
  const storage = options.storage ?? (home ? Storage.sqlite(path.join(home, "pie.db")) : Storage.memory)
  const hostEntries: ReadonlyArray<HostEntry> = [
    { plugin: sdkGuard },
    ...(options.plugins ?? []).map((p) => ("plugin" in p ? p : { plugin: p }))
  ]
  let manager: Plugins["Service"] | undefined

  const plugins = Layer.effect(Plugins, Effect.suspend(() => {
    return Plugins.make({
      home,
      seed: options.seed ?? DEFAULT_SEED,
      host: hostEntries,
      pluginOptions: options.pluginOptions ?? {},
      reload: options.reload ?? "hot",
      safe: options.safe ?? process.env.PIE_SAFE === "1",
      required: new Set(options.required ?? [])
    })
  }))

  const startup = Layer.effectDiscard(Effect.gen(function*() {
    manager = yield* Plugins
    const events = yield* Events
    const runtime = yield* Runtime
    // Edits to the plugins folder apply by themselves before the next step of any session.
    yield* runtime.beforeStep(manager.sync)
    yield* runtime.start
    // The snapshot is "good" once Pie has been up for a while, and after each completed run.
    const plugins = manager
    yield* plugins.markGood.pipe(Effect.delay(options.goodAfter ?? 3000), Effect.forkScoped)
    yield* events.stream().pipe(
      Stream.filter((e) => e.type === "event" && e.event.type === "run/ended" && (e.event.data as Outcome).status === "completed"),
      Stream.runForEach(() => plugins.markGood),
      Effect.forkScoped
    )
  }))

  // ctx.pie for plugins (the web UI is one); the plugin manager is reached lazily.
  const api = Layer.effectDiscard(Effect.gen(function*() {
    const host = yield* PluginHost
    const log = yield* EventLog
    const runtime = yield* Runtime
    const events = yield* Events
    const registries = yield* Registries
    yield* host.setApi({
      sessions: {
        list: log.listSessions,
        create: ({ cwd, model }) => log.createSession({ id: randomUUID(), cwd, model }),
        events: (id) => log.branch(id),
        state: runtime.state,
        prompt: (id, text, mode = "prompt") =>
          mode === "prompt" ? runtime.prompt(id, text) : runtime.enqueue(id, mode, text),
        abort: runtime.abort,
        navigate: runtime.navigate,
        setModel: runtime.setModel
      },
      live: events.stream(),
      projection: (projectionId, sessionId) =>
        Effect.gen(function*() {
          const definition = (yield* registries.projections.get).get(projectionId)
          if (!definition) return undefined
          return foldProjection(definition, yield* log.branch(sessionId))
        }),
      registries,
      plugins: new Proxy({} as Plugins["Service"], { get: (_, key) => (manager as any)[key] }),
      paths: {
        home,
        plugins: home ? path.join(home, "plugins") : undefined,
        sdk: SDK_ROOT,
        templates: Package.TEMPLATES,
        docs: Package.DOCS,
        cli: Package.entry("cli")
      }
    })
  }))

  const base = Layer.mergeAll(
    Layer.effect(EventLog, EventLog.make),
    Layer.effect(ConfigLog, ConfigLog.make),
    Layer.effect(Events, Events.make),
    Layer.effect(AbortSignals, AbortSignals.make)
  )

  return Layer.effect(Pie, make).pipe(
    Layer.provideMerge(startup),
    Layer.provideMerge(plugins),
    Layer.provideMerge(api),
    Layer.provideMerge(LogWorkflowEngine.layer),
    Layer.provideMerge(Layer.effect(Runtime, Runtime.make)),
    Layer.provideMerge(Core.layer),
    Layer.provideMerge(base),
    Layer.provideMerge(storage),
    Layer.provideMerge(NodeServices.layer)
  )
}

/**
 * For reload: "restart". Runs the program until a plugin change asks for a
 * restart, then exits the process with RESTART_EXIT_CODE so Supervisor.run
 * starts it again.
 */
export const exitOnRestart = <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Plugins | Runtime | Scope.Scope> =>
  Effect.gen(function*() {
    const manager = yield* Plugins
    const runtime = yield* Runtime
    yield* manager.restartRequested.pipe(
      Effect.andThen(runtime.release),
      Effect.andThen(Effect.sync(() => process.exit(RESTART_EXIT_CODE))),
      Effect.forkScoped
    )
    return yield* program
  })

export { Runtime }
