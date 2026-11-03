/**
 * The agent as an Elm-style program over the session log:
 *
 *   evolve(state, event) → state       pure: how each event changes the state
 *   decide(state, now)   → commands    pure: what must happen next
 *
 * The runtime executes commands; their results come back as events. Because
 * the state is a fold of the log and decide is pure, resuming after a crash is
 * just: fold the branch, decide, run what is pending. A command whose start
 * was logged but whose result was not is exactly "interrupted mid-way".
 *
 * Event type names and payloads are the durable contract: change them only in
 * backwards-compatible ways.
 */
import type { Prompt } from "effect/ai"
import type { LogEvent } from "./Log.ts"

export const MAX_MODEL_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Core events
// ---------------------------------------------------------------------------

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly params: unknown
}

export interface Usage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
}

export type RunStatus = "completed" | "failed" | "aborted"

export interface CoreEvents {
  /** A run begins; the prompt follows as a `user` event. */
  readonly "run/started": { readonly runId: string }
  /** Text from the user that the model sees. `inputId` when it was queued first. */
  readonly user: { readonly text: string; readonly inputId?: string | undefined }
  /** steer/followUp waiting to be delivered at the right point of the run. */
  readonly "input/queued": { readonly inputId: string; readonly kind: "steer" | "followUp"; readonly text: string }
  /** What was sent to the model ("model-visible means logged"); messages are the branch before it. */
  readonly "model/requested": {
    readonly callId: string
    readonly turn: number
    readonly attempt: number
    readonly model: string
    readonly system: string
    readonly tools: ReadonlyArray<string>
  }
  readonly "model/responded": {
    readonly callId: string
    readonly turn: number
    readonly text: string
    readonly reasoning: string
    readonly toolCalls: ReadonlyArray<ToolCall>
    readonly finishReason: string
    readonly model: string
    readonly usage: Usage
  }
  readonly "model/failed": {
    readonly callId: string
    readonly attempt: number
    readonly message: string
    /** Epoch ms after which the call may be retried. */
    readonly retryAt: number
  }
  readonly "tool/started": { readonly toolCallId: string; readonly name: string }
  readonly "tool/finished": {
    readonly toolCallId: string
    readonly name: string
    readonly content: string
    readonly isError: boolean
    readonly details?: unknown
  }
  readonly "abort/requested": { readonly runId: string }
  readonly "run/ended": { readonly runId: string; readonly status: RunStatus; readonly message?: string | undefined }
  readonly "model/selected": { readonly model: string }
}

export type CoreEventType = keyof CoreEvents

export type CoreEvent = { [K in CoreEventType]: LogEvent<K, CoreEvents[K]> }[CoreEventType]

export const isCore = <K extends CoreEventType>(event: LogEvent, type: K): event is LogEvent<K, CoreEvents[K]> =>
  event.type === type

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ModelCall {
  readonly callId: string
  readonly turn: number
  readonly attempt: number
  readonly responded: boolean
  readonly failure?: { readonly attempt: number; readonly message: string; readonly retryAt: number } | undefined
}

export interface Run {
  readonly runId: string
  /** Completed model responses in this run. */
  readonly turn: number
  readonly call: ModelCall | undefined
  /** Tool calls of the last response. */
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly started: ReadonlySet<string>
  readonly finished: ReadonlySet<string>
  /** Whether the last response asked for tools (true before the first response). */
  readonly expectsMore: boolean
  readonly aborted: boolean
}

export interface AgentState {
  readonly model: string
  readonly run: Run | undefined
  readonly queued: ReadonlyArray<CoreEvents["input/queued"]>
  readonly lastOutcome: CoreEvents["run/ended"] | undefined
}

export const initial = (model: string): AgentState => ({ model, run: undefined, queued: [], lastOutcome: undefined })

export const evolve = (state: AgentState, event: LogEvent): AgentState => {
  const run = state.run
  switch (event.type as CoreEventType) {
    case "run/started": {
      const { runId } = event.data as CoreEvents["run/started"]
      return {
        ...state,
        run: {
          runId,
          turn: 0,
          call: undefined,
          toolCalls: [],
          started: new Set(),
          finished: new Set(),
          expectsMore: true,
          aborted: false
        }
      }
    }
    case "user": {
      const { inputId } = event.data as CoreEvents["user"]
      return inputId === undefined ? state : { ...state, queued: state.queued.filter((q) => q.inputId !== inputId) }
    }
    case "input/queued":
      return { ...state, queued: [...state.queued, event.data as CoreEvents["input/queued"]] }
    case "model/requested": {
      if (!run) return state
      const { attempt, callId, turn } = event.data as CoreEvents["model/requested"]
      const failure = run.call?.callId === callId ? run.call.failure : undefined
      return { ...state, run: { ...run, call: { callId, turn, attempt, responded: false, failure } } }
    }
    case "model/responded": {
      if (!run) return state
      const { callId, toolCalls, turn } = event.data as CoreEvents["model/responded"]
      return {
        ...state,
        run: {
          ...run,
          turn: run.turn + 1,
          call: { callId, turn, attempt: run.call?.attempt ?? 1, responded: true },
          toolCalls,
          started: new Set(),
          finished: new Set(),
          expectsMore: toolCalls.length > 0
        }
      }
    }
    case "model/failed": {
      if (!run?.call) return state
      const failure = event.data as CoreEvents["model/failed"]
      return { ...state, run: { ...run, call: { ...run.call, failure } } }
    }
    case "tool/started": {
      if (!run) return state
      const { toolCallId } = event.data as CoreEvents["tool/started"]
      return { ...state, run: { ...run, started: new Set([...run.started, toolCallId]) } }
    }
    case "tool/finished": {
      if (!run) return state
      const { toolCallId } = event.data as CoreEvents["tool/finished"]
      return { ...state, run: { ...run, finished: new Set([...run.finished, toolCallId]) } }
    }
    case "abort/requested": {
      const { runId } = event.data as CoreEvents["abort/requested"]
      return run && run.runId === runId ? { ...state, run: { ...run, aborted: true } } : state
    }
    case "run/ended":
      return { ...state, run: undefined, lastOutcome: event.data as CoreEvents["run/ended"] }
    case "model/selected":
      return { ...state, model: (event.data as CoreEvents["model/selected"]).model }
    default:
      return state
  }
}

export const fold = (model: string, events: ReadonlyArray<LogEvent>): AgentState => events.reduce(evolve, initial(model))

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly _tag: "CallModel"; readonly key: string; readonly runId: string; readonly callId: string; readonly turn: number; readonly attempt: number }
  | { readonly _tag: "RunTool"; readonly key: string; readonly runId: string; readonly call: ToolCall; readonly turn: number }
  | { readonly _tag: "Deliver"; readonly key: string; readonly inputs: ReadonlyArray<CoreEvents["input/queued"]> }
  | { readonly _tag: "EndRun"; readonly key: string; readonly runId: string; readonly status: RunStatus; readonly message?: string | undefined }
  /** Nothing to run until `at` (epoch ms): the runtime sets a wake-up. */
  | { readonly _tag: "WakeAt"; readonly key: string; readonly at: number }

export const decide = (state: AgentState, now: number): ReadonlyArray<Command> => {
  const run = state.run
  if (!run) return []
  const end = (status: RunStatus, message?: string): ReadonlyArray<Command> => [
    { _tag: "EndRun", key: `end/${run.runId}`, runId: run.runId, status, message }
  ]
  const unfinished = run.toolCalls.filter((c) => !run.finished.has(c.id))
  const toolCommands = unfinished.map((call): Command => ({
    _tag: "RunTool",
    key: `tool/${run.runId}/${run.turn}/${call.id}`,
    runId: run.runId,
    call,
    turn: run.turn
  }))
  const pendingCall = run.call && !run.call.responded ? run.call : undefined

  if (run.aborted) {
    // Settle what is in progress (the runtime turns it into "aborted" results), then end.
    if (toolCommands.length > 0) return toolCommands
    if (pendingCall && !pendingCall.failure) {
      return [{ _tag: "CallModel", key: `model/${pendingCall.callId}`, runId: run.runId, callId: pendingCall.callId, turn: pendingCall.turn, attempt: pendingCall.attempt }]
    }
    return end("aborted")
  }

  if (pendingCall) {
    const failure = pendingCall.failure
    if (failure && failure.attempt >= pendingCall.attempt) {
      if (failure.attempt >= MAX_MODEL_ATTEMPTS) return end("failed", failure.message)
      if (now < failure.retryAt) return [{ _tag: "WakeAt", key: `wake/${pendingCall.callId}`, at: failure.retryAt }]
      return [{ _tag: "CallModel", key: `model/${pendingCall.callId}`, runId: run.runId, callId: pendingCall.callId, turn: pendingCall.turn, attempt: failure.attempt + 1 }]
    }
    return [{ _tag: "CallModel", key: `model/${pendingCall.callId}`, runId: run.runId, callId: pendingCall.callId, turn: pendingCall.turn, attempt: pendingCall.attempt }]
  }

  if (toolCommands.length > 0) return toolCommands

  // The step is complete: deliver what is due, then ask the model again or finish.
  const due = state.queued.filter((q) => q.kind === (run.expectsMore ? "steer" : "followUp"))
  if (due.length > 0) return [{ _tag: "Deliver", key: `deliver/${due.map((q) => q.inputId).join(",")}`, inputs: due }]
  if (!run.expectsMore) return end("completed")
  const callId = `${run.runId}/call/${run.turn}`
  return [{ _tag: "CallModel", key: `model/${callId}`, runId: run.runId, callId, turn: run.turn, attempt: 1 }]
}

// ---------------------------------------------------------------------------
// View: what the model sees
// ---------------------------------------------------------------------------

/** Messages for the model from a branch. Only core conversational events are visible. */
export const toMessages = (events: ReadonlyArray<LogEvent>): Array<Prompt.MessageEncoded> => {
  const messages: Array<Prompt.MessageEncoded> = []
  for (const event of events) {
    if (isCore(event, "user")) {
      messages.push({ role: "user", content: event.data.text })
    } else if (isCore(event, "model/responded")) {
      const content: Array<Prompt.AssistantMessagePartEncoded> = []
      if (event.data.text.length > 0) content.push({ type: "text", text: event.data.text })
      for (const call of event.data.toolCalls) {
        content.push({ type: "tool-call", id: call.id, name: call.name, params: call.params })
      }
      if (content.length > 0) messages.push({ role: "assistant", content })
    } else if (isCore(event, "tool/finished")) {
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          id: event.data.toolCallId,
          name: event.data.name,
          isFailure: event.data.isError,
          result: event.data.content
        }]
      })
    }
  }
  return messages
}
