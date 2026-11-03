/**
 * The core registries. Everything a plugin contributes lands in one of these
 * States; the core only reads them. Shapes are deliberately plain data plus
 * Effect functions so the agent can write new entries itself.
 */
import { Context, Effect, Schema } from "effect"
import type { LanguageModel, Prompt } from "effect/ai"
import type { Layer } from "effect"
import { Composition, type State } from "./State.ts"

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly sessionId: string
  readonly toolCallId: string
  readonly cwd: string
}

export interface ToolOutput {
  /** Text the model sees. */
  readonly content: string
  /** Structured data for hosts/UIs; not sent to the model. */
  readonly details?: unknown
  readonly isError?: boolean
}

export interface ToolDefinition<Params = any> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Codec<Params, any>
  /**
   * Safe to run again if the process died mid-execution. Non-idempotent tools
   * (bash, network writes) report "outcome unknown" instead of re-running.
   */
  readonly idempotent: boolean
  readonly execute: (params: Params, context: ToolContext) => Effect.Effect<ToolOutput>
}

export const defineTool = <S extends Schema.Codec<any, any>>(tool: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly idempotent: boolean
  readonly execute: (params: S["Type"], context: ToolContext) => Effect.Effect<ToolOutput>
}): ToolDefinition<S["Type"]> => tool

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelDefinition {
  /** Fully qualified id: "<provider>/<model>". */
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number | undefined
  /** Builds the LanguageModel for one session (providers may need the session id). */
  readonly layer: (options: { readonly sessionId: string }) => Layer.Layer<LanguageModel.LanguageModel, unknown>
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export interface PromptPart {
  /** Stable key, e.g. "core/identity" or "agents-md". Used for ordering and diffing. */
  readonly key: string
  readonly text: string
}

// ---------------------------------------------------------------------------
// Hooks: interceptors run in plugin order; later hooks see earlier changes.
// ---------------------------------------------------------------------------

export interface ContextEvent {
  readonly sessionId: string
  readonly cwd: string
  /** Mutable: hooks may add, edit or remove parts. */
  system: Array<PromptPart>
  /** Mutable: messages about to be sent to the model. */
  messages: Array<Prompt.MessageEncoded>
  /** Mutable: names of tools offered to the model this call. */
  tools: Array<string>
}

export type ToolDecision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: string }

export interface ToolBeforeEvent {
  readonly sessionId: string
  readonly toolCallId: string
  readonly tool: string
  /** Mutable: hooks may rewrite parameters. */
  params: unknown
  /** Mutable: last writer wins. */
  decision: ToolDecision
}

export interface ToolAfterEvent {
  readonly sessionId: string
  readonly toolCallId: string
  readonly tool: string
  readonly params: unknown
  /** Mutable: hooks may rewrite the output. */
  output: ToolOutput
}

export interface HookMap {
  readonly context: (event: ContextEvent) => Effect.Effect<void>
  readonly "tool.before": (event: ToolBeforeEvent) => Effect.Effect<void>
  readonly "tool.after": (event: ToolAfterEvent) => Effect.Effect<void>
}

export type HookName = keyof HookMap

export type HookTable = { [K in HookName]: Array<HookMap[K]> }

const emptyHooks = (): HookTable => ({ context: [], "tool.before": [], "tool.after": [] })

// ---------------------------------------------------------------------------
// Registries service
// ---------------------------------------------------------------------------

export class Registries extends Context.Service<Registries, {
  readonly tools: State<Map<string, ToolDefinition>>
  readonly models: State<Map<string, ModelDefinition>>
  readonly prompt: State<Array<PromptPart>>
  readonly hooks: State<HookTable>
}>()("pie/Registries") {
  static readonly make = Effect.gen(function*() {
    const composition = yield* Composition
    return Registries.of({
      tools: yield* composition.make({ name: "tools", initial: () => new Map<string, ToolDefinition>() }),
      models: yield* composition.make({ name: "models", initial: () => new Map<string, ModelDefinition>() }),
      prompt: yield* composition.make({ name: "prompt", initial: (): Array<PromptPart> => [] }),
      hooks: yield* composition.make({ name: "hooks", initial: emptyHooks })
    })
  })
}

/** Runs every registered hook of one kind, in order, over a shared mutable event. */
export const runHooks = <K extends HookName>(name: K, event: Parameters<HookMap[K]>[0]) =>
  Effect.gen(function*() {
    const registries = yield* Registries
    const table = yield* registries.hooks.get
    for (const hook of table[name]) {
      yield* (hook as (e: typeof event) => Effect.Effect<void>)(event)
    }
    return event
  })
