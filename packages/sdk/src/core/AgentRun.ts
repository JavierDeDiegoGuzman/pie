/**
 * The durable agent loop. One Workflow execution per run (a prompt plus the
 * followUps it absorbs). Every step that touches the outside world is an
 * Activity, so after a crash the engine replays the body and completed steps
 * return their stored result instead of running again:
 *
 *   llm/<turn>      model call; reads tools/prompt/model from the live registries,
 *                   so its stored result is the composition snapshot of that call
 *   assistant/<turn> append the assistant entry
 *   tool/<turn>/<id> one per tool call, in parallel; start marker + hooks + execute
 *   results/<turn>  append tool results
 *   steer/<turn>    consume queued steering messages
 *   finish/<turn>   consume followUps (continue) or release the session (done)
 *
 * Activity names are part of the durable contract: renaming one breaks replay
 * of runs that were in flight.
 */
import { Cause, Effect, Exit, Predicate, Schedule, Schema, Stream } from "effect"
import { type AiError, LanguageModel, Prompt, type Response, Tool, type Toolkit } from "effect/ai"
import { Activity, Workflow } from "effect/workflow"
import { AbortSignals } from "./AbortSignals.ts"
import { Events } from "./Events.ts"
import { type ContextEvent, Registries, runHooks, type ToolAfterEvent, type ToolBeforeEvent } from "./Registry.ts"
import {
  AssistantData,
  type RunOutcome,
  RunOutcome as RunOutcomeSchema,
  SessionStore,
  type ToolCall,
  ToolResultData,
  toMessages
} from "./Session.ts"

export const MAX_TURNS = 64

export const AgentRun = Workflow.make("Pie/AgentRun", {
  payload: { sessionId: Schema.String, runId: Schema.String },
  success: RunOutcomeSchema,
  error: Schema.String,
  idempotencyKey: (payload) => payload.runId
})

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : typeof error === "string" ? error : Cause.pretty(cause)
}

const EMPTY_OBJECT = { type: "object", properties: {}, required: [], additionalProperties: false } as const

const hasNoFields = (schema: unknown) =>
  Predicate.hasProperty(schema, "fields") && Predicate.isObject(schema.fields) && Object.keys(schema.fields).length === 0

const withoutNulls = (params: unknown) =>
  Predicate.isObject(params) && !Array.isArray(params)
    ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null))
    : params

const toolError = (call: ToolCall, content: string): ToolResultData => ({
  toolCallId: call.id,
  toolName: call.name,
  content,
  isError: true
})

export const AgentRunLive = AgentRun.toLayer(Effect.fn(function*({ runId, sessionId }) {
  const store = yield* SessionStore
  const registries = yield* Registries
  const events = yield* Events
  const signals = yield* AbortSignals

  yield* Workflow.addFinalizer((exit) => {
    const outcome: RunOutcome = Exit.isSuccess(exit)
      ? exit.value as RunOutcome
      : Cause.hasInterruptsOnly(exit.cause)
      ? { status: "aborted" }
      : { status: "failed", message: errorMessage(exit.cause) }
    return store.endRun(sessionId, runId, outcome).pipe(
      Effect.andThen(events.publish({ type: "agent_end", sessionId, runId, outcome }))
    )
  })

  const appendAndPublish = (id: string, entry: Parameters<typeof store.append>[2]) =>
    store.append(sessionId, id, entry).pipe(Effect.tap((stored) => events.publish({ type: "entry", sessionId, entry: stored })))

  const llmTurn = (turn: number) =>
    Effect.gen(function*() {
      yield* events.publish({ type: "turn_start", sessionId, runId, turn })
      const session = yield* store.get(sessionId).pipe(Effect.orDie)
      if (yield* store.isAborted(runId)) {
        return { text: "", reasoning: "", toolCalls: [], finishReason: "aborted", model: session.model, usage: {} } satisfies AssistantData
      }
      const model = (yield* registries.models.get).get(session.model)
      if (!model) return yield* Effect.fail(`Model "${session.model}" is not registered by any plugin`)
      const tools = yield* registries.tools.get
      const context: ContextEvent = {
        sessionId,
        cwd: session.cwd,
        system: [...(yield* registries.prompt.get)],
        messages: toMessages(yield* store.branch(sessionId)),
        tools: [...tools.keys()]
      }
      yield* runHooks("context", context)

      const offered = context.tools.flatMap((name) => {
        const tool = tools.get(name)
        return tool ? [tool] : []
      })
      const toolkit = {
        tools: Object.fromEntries(
          offered.map((t) => [
            t.name,
            Tool.dynamic(
              t.name,
              // Providers reject Effect's default schema for a tool without parameters:
              // send an explicit empty object JSON Schema instead.
              hasNoFields(t.parameters)
                ? { description: t.description, parameters: EMPTY_OBJECT }
                : { description: t.description, parameters: t.parameters }
            )
          ])
        ),
        handle: () => Effect.die("Pie executes tools itself")
      } as unknown as Toolkit.WithHandler<Record<string, Tool.Any>>
      const system = context.system.map((p) => p.text).join("\n\n")
      const prompt = Prompt.make([
        ...(system.length > 0 ? [{ role: "system" as const, content: system }] : []),
        ...context.messages
      ])

      let text = ""
      let reasoning = ""
      const toolCalls: Array<ToolCall> = []
      let finishReason = "unknown"
      let usage: AssistantData["usage"] = {}
      const stream = LanguageModel.streamText({
        prompt,
        toolkit,
        disableToolCallResolution: true,
        toolCallValidation: "deferred"
      }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, AiError.AiError, LanguageModel.LanguageModel>
      const aborted = yield* stream.pipe(
        Stream.runForEach((part) => {
          switch (part.type) {
            case "text-delta":
              text += part.delta
              return events.publish({ type: "text_delta", sessionId, runId, turn, delta: part.delta })
            case "reasoning-delta":
              reasoning += part.delta
              return events.publish({ type: "reasoning_delta", sessionId, runId, turn, delta: part.delta })
            case "tool-call":
              if (!part.providerExecuted) toolCalls.push({ id: part.id, name: part.name, params: part.params })
              return Effect.void
            case "finish":
              finishReason = part.reason
              usage = { inputTokens: part.usage.inputTokens.total, outputTokens: part.usage.outputTokens.total }
              return Effect.void
            default:
              return Effect.void
          }
        }),
        Effect.provide(model.layer({ sessionId })),
        Effect.mapError((error) => (error instanceof Error ? error.message : String(error))),
        Effect.as(false),
        Effect.raceFirst(Effect.as(signals.await(runId), true))
      )
      if (aborted) {
        // Keep the partial text; drop half-received tool calls.
        return { text, reasoning, toolCalls: [], finishReason: "aborted", model: model.id, usage } satisfies AssistantData
      }
      return { text, reasoning, toolCalls, finishReason, model: model.id, usage } satisfies AssistantData
    })

  const runTool = (turn: number, call: ToolCall) =>
    Effect.gen(function*() {
      const session = yield* store.get(sessionId).pipe(Effect.orDie)
      yield* events.publish({ type: "tool_start", sessionId, runId, toolCallId: call.id, tool: call.name, params: call.params })
      const result: ToolResultData = yield* Effect.gen(function*() {
        if (yield* store.isAborted(runId)) return toolError(call, "Aborted before running.")
        const tool = (yield* registries.tools.get).get(call.name)
        if (!tool) return toolError(call, `Tool "${call.name}" is not available (its plugin may have been removed).`)
        const firstAttempt = yield* store.markToolStarted(`${runId}/${turn}/${call.id}`)
        if (!firstAttempt && !tool.idempotent) {
          return toolError(
            call,
            `The process restarted while "${call.name}" was running. Its outcome is unknown: ` +
              `it may or may not have taken effect. Check the current state before retrying.`
          )
        }
        const decode = Schema.decodeUnknownEffect(tool.parameters)
        // OpenAI-style strict schemas make optional parameters "required but nullable",
        // so models may send null for "not given": retry without top-level nulls.
        const decoded = yield* decode(call.params).pipe(
          Effect.catch(() => decode(withoutNulls(call.params))),
          Effect.result
        )
        if (decoded._tag === "Failure") return toolError(call, `Invalid parameters: ${decoded.failure.message}`)
        const before: ToolBeforeEvent = {
          sessionId,
          toolCallId: call.id,
          tool: call.name,
          params: decoded.success,
          decision: { _tag: "Allow" }
        }
        yield* runHooks("tool.before", before)
        if (before.decision._tag === "Deny") return toolError(call, `Denied: ${before.decision.reason}`)
        const output = yield* tool.execute(before.params, { sessionId, toolCallId: call.id, cwd: session.cwd }).pipe(
          Effect.catchCause((cause) => Effect.succeed({ content: `Tool failed: ${errorMessage(cause)}`, isError: true }))
        )
        const after: ToolAfterEvent = { sessionId, toolCallId: call.id, tool: call.name, params: before.params, output }
        yield* runHooks("tool.after", after)
        return {
          toolCallId: call.id,
          toolName: call.name,
          content: after.output.content,
          isError: after.output.isError ?? false,
          ...(after.output.details === undefined ? {} : { details: after.output.details })
        }
      }).pipe(
        Effect.raceFirst(Effect.as(
          signals.await(runId),
          toolError(call, "Aborted by the user while running; it may have partially taken effect.")
        ))
      )
      yield* events.publish({ type: "tool_end", sessionId, runId, result })
      return result
    })

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const assistant = yield* Activity.make({
      name: `llm/${turn}`,
      success: AssistantData,
      error: Schema.String,
      execute: llmTurn(turn).pipe(
        Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") })
      )
    })
    yield* Activity.make({
      name: `assistant/${turn}`,
      execute: Effect.asVoid(appendAndPublish(`${runId}/${turn}/assistant`, { kind: "assistant", data: assistant }))
    })
    if (assistant.finishReason === "aborted") return { status: "aborted" } satisfies RunOutcome

    if (assistant.toolCalls.length > 0) {
      const results = yield* Effect.forEach(
        assistant.toolCalls,
        (call) => Activity.make({ name: `tool/${turn}/${call.id}`, success: ToolResultData, execute: runTool(turn, call) }),
        { concurrency: "unbounded" }
      )
      yield* Activity.make({
        name: `results/${turn}`,
        execute: Effect.forEach(results, (result) =>
          appendAndPublish(`${runId}/${turn}/result/${result.toolCallId}`, { kind: "toolResult", data: result }), {
          discard: true
        })
      })
      yield* Activity.make({
        name: `steer/${turn}`,
        execute: Effect.asVoid(store.consume(sessionId, "steer", `${runId}/${turn}/steer`))
      })
      continue
    }

    const next = yield* Activity.make({
      name: `finish/${turn}`,
      success: Schema.Literals(["continue", "done"]),
      execute: store.finishOrContinue(sessionId, runId, `${runId}/${turn}/followUp`)
    })
    if (next === "done") return { status: "completed" } satisfies RunOutcome
  }
  return { status: "turn_limit" } satisfies RunOutcome
}))
