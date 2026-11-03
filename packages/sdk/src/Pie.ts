/**
 * Public SDK entry point.
 *
 *   const PieLive = Pie.layer({ storage: Storage.sqlite("pie.db") })
 *   const pie = yield* Pie.Pie
 *   const session = yield* pie.create({ cwd, model: "opencode-go/deepseek-v4.1-flash" })
 *   yield* session.prompt("...")
 *   const outcome = yield* session.awaitIdle
 */
import { randomUUID } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, type Scope, type Stream } from "effect"
import { AbortSignals } from "./core/AbortSignals.ts"
import type * as Agent from "./core/Agent.ts"
import { ConfigLog } from "./core/ConfigLog.ts"
import * as Core from "./core/Core.ts"
import { Events, type PieEvent } from "./core/Events.ts"
import { EventLog, type LogEvent, type SessionInfo, type SessionNotFound } from "./core/Log.ts"
import * as LogWorkflowEngine from "./core/LogWorkflowEngine.ts"
import * as ModuleResolution from "./core/ModuleResolution.ts"
import type { Plugin } from "./core/Plugin.ts"
import { PluginHost } from "./core/PluginHost.ts"
import { PluginLoader } from "./core/PluginLoader.ts"
import { type BuiltinEntry, Plugins } from "./core/Plugins.ts"
import { Runtime, type SessionBusy } from "./core/Runtime.ts"
import type { Storage } from "./core/Storage.ts"
import CodingToolsPlugin from "./plugins/coding-tools.ts"
import ContextFilesPlugin from "./plugins/context-files.ts"
import OpenCodeGoPlugin from "./plugins/opencode-go.ts"
import * as SelfPlugin from "./plugins/self.ts"
import SystemPromptPlugin from "./plugins/system-prompt.ts"
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
  /** Storage.sqlite(file) or Storage.memory. */
  readonly storage: Storage
  /** Built-in plugins in order. Default: `builtins`. The agent can disable them unless protected. */
  readonly plugins?: ReadonlyArray<Plugin | BuiltinEntry>
  /** Directories of human-managed plugin files, synced and watched. */
  readonly pluginDirectories?: ReadonlyArray<string>
  /** Give the agent the plugin_* tools (self-modification). Default: true. */
  readonly selfModify?: boolean
  /** Plugin ids the agent cannot remove, disable or overwrite. "self" is always protected. */
  readonly protected?: ReadonlyArray<string>
  /**
   * How plugin changes apply. "hot": in this process, from the next model call.
   * "restart": drain to a safe point and exit with RESTART_EXIT_CODE (use with
   * Supervisor.run and Pie.exitOnRestart).
   */
  readonly reload?: "hot" | "restart"
  /** Where agent-installed plugin sources are materialized to be imported. */
  readonly pluginCacheDirectory?: string
}

/** The plugins Pie ships with, in their default order. */
export const builtins: ReadonlyArray<Plugin> = [OpenCodeGoPlugin, SystemPromptPlugin, ContextFilesPlugin, CodingToolsPlugin]

export const layer = (options: LayerOptions) => {
  ModuleResolution.register()
  const entries: ReadonlyArray<BuiltinEntry> = (options.plugins ?? builtins).map((p) => ("plugin" in p ? p : { plugin: p }))

  const plugins = Layer.effect(Plugins, Plugins.make({
    builtins: entries,
    protected: new Set(["self", ...(options.protected ?? [])]),
    cacheDirectory: options.pluginCacheDirectory ?? path.join(os.tmpdir(), "pie-plugin-cache"),
    reload: options.reload ?? "hot"
  }))

  const startup = Layer.effectDiscard(Effect.gen(function*() {
    const host = yield* PluginHost
    const loader = yield* PluginLoader
    const manager = yield* Plugins
    const config = yield* ConfigLog
    if (options.selfModify ?? true) {
      yield* host.load(SelfPlugin.make({ plugins: manager, host, config }), { source: "builtin:self", order: 500 }).pipe(Effect.orDie)
    }
    for (const directory of options.pluginDirectories ?? []) yield* loader.watch(directory)
    yield* (yield* Runtime).start
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
    Layer.provideMerge(LogWorkflowEngine.layer),
    Layer.provideMerge(Layer.effect(Runtime, Runtime.make)),
    Layer.provideMerge(Core.layer),
    Layer.provideMerge(base),
    Layer.provideMerge(options.storage),
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
