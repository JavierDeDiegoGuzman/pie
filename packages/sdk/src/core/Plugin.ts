/**
 * An extension: an Effect that runs in its own Scope and registers what it
 * adds to the agent (tools, models, prompt parts, hooks, event types,
 * projections, reactions). Everything it registers is released when that
 * scope closes.
 *
 * Extensions are passed in code, to Pie.layer({ plugins }). A program that
 * embeds Pie changes its extensions like any other code of its own and
 * restarts; Pie is durable, so work in flight carries on in the new process.
 */
import type { Effect, FileSystem, Path, Schema, Scope } from "effect"
import type {
  HookMap,
  HookName,
  ModelDefinition,
  ProjectionDefinition,
  PromptPart,
  ReactionDefinition,
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
}

export const define = (plugin: Plugin): Plugin => plugin

export const isPlugin = (u: unknown): u is Plugin =>
  typeof u === "object" && u !== null &&
  typeof (u as Plugin).id === "string" && typeof (u as Plugin).setup === "function"
