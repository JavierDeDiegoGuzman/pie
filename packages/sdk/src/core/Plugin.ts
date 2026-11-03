/**
 * A plugin is an Effect that runs in its own Scope. Everything it registers
 * (State transforms, forked fibers, finalizers) is released when that scope
 * closes, i.e. when the plugin is unloaded or replaced.
 *
 * Nearly all behaviour of Pie lives in plugins, including the built-in ones,
 * so the agent can disable, replace or write them.
 */
import type { Effect, FileSystem, Path, Scope } from "effect"
import type { HookMap, HookName, ModelDefinition, PromptPart, ToolDefinition } from "./Registry.ts"
import type { State } from "./State.ts"

export interface PluginContext {
  readonly id: string
  readonly options: Readonly<Record<string, unknown>>
  readonly tools: State<Map<string, ToolDefinition>>
  readonly models: State<Map<string, ModelDefinition>>
  readonly prompt: State<Array<PromptPart>>
  /** Shorthand for a hooks transform that appends one hook. */
  readonly hook: <K extends HookName>(name: K, hook: HookMap[K]) => Effect.Effect<void, never, Scope.Scope>
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
