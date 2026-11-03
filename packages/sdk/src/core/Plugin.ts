/**
 * A plugin is an Effect that runs in its own Scope. Everything it registers
 * (State transforms, forked fibers, finalizers) is released when that scope
 * closes, i.e. when the plugin is unloaded or replaced.
 *
 * Nearly all behaviour of Pie lives in plugins, including the built-in ones,
 * so the agent can disable, replace or write them.
 */
import type { Effect, FileSystem, Path, Schema, Scope, Stream } from "effect"
import type { AgentState } from "./Agent.ts"
import type { PieEvent } from "./Events.ts"
import type { LogEvent, SessionInfo, SessionNotFound } from "./Log.ts"
import type { Plugins } from "./Plugins.ts"
import type { SessionBusy } from "./Runtime.ts"
import type {
  HookMap,
  HookName,
  ModelDefinition,
  ProjectionDefinition,
  PromptPart,
  ReactionDefinition,
  Registries,
  ToolDefinition
} from "./Registry.ts"
import type { State } from "./State.ts"

export interface PluginContext {
  readonly id: string
  readonly options: Readonly<Record<string, unknown>>
  readonly tools: State<Map<string, ToolDefinition>>
  readonly models: State<Map<string, ModelDefinition>>
  readonly prompt: State<Array<PromptPart>>
  /** Shorthand for a hooks transform that appends one hook. */
  readonly hook: <K extends HookName>(name: K, hook: HookMap[K]) => Effect.Effect<void, never, Scope.Scope>
  /**
   * extend: declares this plugin's event types. `{ added: schema }` registers
   * "<pluginId>/added". Tools and reactions emit them; the log keeps them even
   * after the plugin is removed.
   */
  readonly events: (schemas: Readonly<Record<string, Schema.Codec<any, any>>>) => Effect.Effect<void, never, Scope.Scope>
  /** derive: a pure fold over a session branch; recomputed, never stored. */
  readonly projection: <S>(definition: ProjectionDefinition<S>) => Effect.Effect<Projection<S>, never, Scope.Scope>
  /** react: runs after matching events are in the log; survives restarts. */
  readonly react: (definition: ReactionDefinition) => Effect.Effect<void, never, Scope.Scope>
  /**
   * ui: this plugin's browser module, loaded by the web plugin into named
   * slots. Pass a function `(sdk) => void` (serialized with toString, so it
   * must not close over server variables) or the source of an ES module whose
   * default export is such a function.
   */
  readonly ui: (module: ((sdk: any) => void) | string) => Effect.Effect<void, never, Scope.Scope>
  /** Pie itself: sessions, live events, plugins, projections. For plugins like the web UI. */
  readonly pie: PieApi
}

export interface PieApi {
  readonly sessions: {
    readonly list: Effect.Effect<ReadonlyArray<SessionInfo>>
    readonly create: (options: { readonly cwd: string; readonly model: string }) => Effect.Effect<SessionInfo>
    readonly events: (sessionId: string) => Effect.Effect<ReadonlyArray<LogEvent>>
    readonly state: (sessionId: string) => Effect.Effect<AgentState, SessionNotFound>
    readonly prompt: (sessionId: string, text: string, mode?: "prompt" | "steer" | "followUp") => Effect.Effect<void, SessionBusy | SessionNotFound>
    readonly abort: (sessionId: string) => Effect.Effect<void, SessionNotFound>
    readonly navigate: (sessionId: string, eventId: string | null) => Effect.Effect<void, SessionBusy | SessionNotFound>
    readonly setModel: (sessionId: string, model: string) => Effect.Effect<void, SessionNotFound>
  }
  /** Every appended event plus streaming deltas. */
  readonly live: Stream.Stream<PieEvent>
  /** Current value of a registered projection for a session (undefined if no such projection). */
  readonly projection: (projectionId: string, sessionId: string) => Effect.Effect<unknown>
  readonly registries: Registries["Service"]
  readonly plugins: Plugins["Service"]
}

export interface Projection<S> {
  /** Folds the session's current branch (or up to `leafId`). */
  readonly get: (sessionId: string, leafId?: string | null) => Effect.Effect<S>
}

/** Services the host makes available to every plugin. */
export type PluginServices = Scope.Scope | FileSystem.FileSystem | Path.Path

export interface Plugin {
  readonly id: string
  readonly setup: (context: PluginContext) => Effect.Effect<void, unknown, PluginServices>
  /**
   * Files of its source (absolute paths), so the agent can read a built-in with
   * plugin_source and install its own version instead of editing Pie's files.
   */
  readonly sourceFiles?: ReadonlyArray<string> | undefined
}

export const define = (plugin: Plugin): Plugin => plugin

export const isPlugin = (u: unknown): u is Plugin =>
  typeof u === "object" && u !== null &&
  typeof (u as Plugin).id === "string" && typeof (u as Plugin).setup === "function"
