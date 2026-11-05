/**
 * The core registries. Everything a plugin contributes lands in one of these
 * States; the core only reads them. Shapes are deliberately plain data plus
 * Effect functions so the agent can write new entries itself.
 */
import { Context, Data, Effect, Schema } from "effect"
import type { LanguageModel, Prompt } from "effect/ai"
import type { Layer } from "effect"
import type { LogEvent } from "./Log.ts"
import { Composition, type State } from "./State.ts"

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  readonly sessionId: string
  readonly runId: string
  readonly toolCallId: string
  readonly cwd: string
  /**
   * Appends a plugin event (type "<pluginId>/<name>", registered with
   * ctx.events) to the session log. Ids are derived from the tool call, so a
   * tool re-run after a crash never duplicates events.
   */
  readonly emit: (type: string, data: unknown) => Effect.Effect<void, EmitError>
}

export class EmitError extends Data.TaggedError("EmitError")<{ readonly type: string; readonly message: string }> {}

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
  readonly cwd: string
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
// Plugin state as events: event types (extend), projections (derive),
// reactions (react). See docs/EVENTS.md.
// ---------------------------------------------------------------------------

export interface EventTypeDefinition {
  /** Full type: "<pluginId>/<name>". */
  readonly type: string
  readonly owner: string
  readonly schema: Schema.Codec<any, any>
}

export interface ProjectionDefinition<S = any> {
  readonly id: string
  readonly initial: () => S
  /** Keyed by full event type; core types ("tool/finished", ...) are allowed too. */
  readonly on: Readonly<Record<string, (state: S, data: any, event: LogEvent) => S>>
}

export interface ReactionContext {
  readonly sessionId: string
  /** Appends a plugin event; ids are derived from the triggering event. */
  readonly emit: (type: string, data: unknown) => Effect.Effect<void, EmitError>
}

export interface ReactionDefinition {
  readonly id: string
  /** Event types that trigger it. */
  readonly on: ReadonlyArray<string>
  /**
   * Runs after the event is in the log, at least once per event (keep it
   * idempotent). A per-session cursor makes it survive restarts; a new
   * reaction starts from the events appended after it is first seen.
   */
  readonly run: (event: LogEvent, context: ReactionContext) => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Browser modules (UI). A plugin contributes one module; the web plugin serves
// it and the browser loads it into named slots.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registries service
// ---------------------------------------------------------------------------

export class Registries extends Context.Service<Registries, {
  readonly tools: State<Map<string, ToolDefinition>>
  readonly models: State<Map<string, ModelDefinition>>
  readonly prompt: State<Array<PromptPart>>
  readonly hooks: State<HookTable>
  readonly eventTypes: State<Map<string, EventTypeDefinition>>
  readonly projections: State<Map<string, ProjectionDefinition>>
  readonly reactions: State<Map<string, ReactionDefinition>>
}>()("pie/Registries") {
  static readonly make = Effect.gen(function*() {
    const composition = yield* Composition
    return Registries.of({
      tools: yield* composition.make({ name: "tools", initial: () => new Map<string, ToolDefinition>() }),
      models: yield* composition.make({ name: "models", initial: () => new Map<string, ModelDefinition>() }),
      prompt: yield* composition.make({ name: "prompt", initial: (): Array<PromptPart> => [] }),
      hooks: yield* composition.make({ name: "hooks", initial: emptyHooks }),
      eventTypes: yield* composition.make({ name: "eventTypes", initial: () => new Map<string, EventTypeDefinition>() }),
      projections: yield* composition.make({ name: "projections", initial: () => new Map<string, ProjectionDefinition>() }),
      reactions: yield* composition.make({ name: "reactions", initial: () => new Map<string, ReactionDefinition>() }),
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
