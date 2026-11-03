/**
 * The runtime: one tick loop over the event log.
 *
 *   tick(session) = fold the branch → decide(state, now) → run what is pending
 *
 * A tick is triggered when an event is appended, when a timer is due (WakeAt)
 * and when the process starts (every session with an open run resumes). It is
 * level-triggered and idempotent: running it again never duplicates work,
 * because commands in flight are tracked in memory and every event has a
 * deterministic id. After a crash, nothing is in flight, so whatever started
 * and never finished is decided again; tools then follow their idempotency
 * rule (re-run, or "outcome unknown").
 *
 * Plugin reactions run after their events are in the log, with a durable
 * per-session cursor.
 */
import { randomUUID } from "node:crypto"
import { Cause, Context, Data, Effect, FiberSet, Predicate, Schema, Semaphore, Stream } from "effect"
import { type AiError, LanguageModel, Prompt, type Response, Tool, type Toolkit } from "effect/ai"
import { SqlClient } from "effect/sql"
import { AbortSignals } from "./AbortSignals.ts"
import * as Agent from "./Agent.ts"
import { Events } from "./Events.ts"
import { EventLog, type LogEvent, type NewEvent, SessionNotFound } from "./Log.ts"
import {
  type ContextEvent,
  EmitError,
  Registries,
  runHooks,
  type ToolAfterEvent,
  type ToolBeforeEvent,
  type ToolContext,
  type ToolOutput
} from "./Registry.ts"

export class SessionBusy extends Data.TaggedError("SessionBusy")<{ readonly sessionId: string; readonly runId: string }> {}
export class StorageLocked extends Data.TaggedError("StorageLocked")<{ readonly owner: string }> {}

const EMPTY_OBJECT = { type: "object", properties: {}, required: [], additionalProperties: false } as const

const hasNoFields = (schema: unknown) =>
  Predicate.hasProperty(schema, "fields") && Predicate.isObject(schema.fields) && Object.keys(schema.fields).length === 0

const withoutNulls = (params: unknown) =>
  Predicate.isObject(params) && !Array.isArray(params)
    ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null))
    : params

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : typeof error === "string" ? error : Cause.pretty(cause)
}

export interface PromptOptions {
  readonly streamingBehavior?: "steer" | "followUp" | undefined
}

export class Runtime extends Context.Service<Runtime, {
  readonly prompt: (sessionId: string, text: string, options?: PromptOptions) => Effect.Effect<void, SessionBusy | SessionNotFound>
  readonly enqueue: (sessionId: string, kind: "steer" | "followUp", text: string) => Effect.Effect<void, SessionNotFound>
  readonly abort: (sessionId: string) => Effect.Effect<void, SessionNotFound>
  readonly navigate: (sessionId: string, eventId: string | null) => Effect.Effect<void, SessionBusy | SessionNotFound>
  readonly setModel: (sessionId: string, model: string) => Effect.Effect<void, SessionNotFound>
  readonly state: (sessionId: string) => Effect.Effect<Agent.AgentState, SessionNotFound>
  readonly awaitIdle: (sessionId: string) => Effect.Effect<Agent.CoreEvents["run/ended"] | undefined, SessionNotFound>
  /** Appends an event as if a command had produced it (plugins, tests). */
  readonly append: (sessionId: string, event: NewEvent) => Effect.Effect<LogEvent, SessionNotFound>
  /** Stops starting new work and waits for work in flight (safe point for a restart). */
  readonly drain: (timeout?: number) => Effect.Effect<void>
  /** Begins executing: resumes open runs and catches up reactions. Call after plugins are loaded. */
  readonly start: Effect.Effect<void>
  /** Releases the database lock now (before exiting for a restart). */
  readonly release: Effect.Effect<void>
}>()("pie/Runtime") {
  static readonly make = Effect.gen(function*() {
    const log = yield* EventLog
    const registries = yield* Registries
    const events = yield* Events
    const signals = yield* AbortSignals
    const sql = yield* SqlClient.SqlClient
    const fibers = yield* FiberSet.make()
    const runFork = yield* FiberSet.runtime(fibers)<never>()

    // -- process lock: one runtime per database -------------------------------
    const owner = `${process.pid}-${randomUUID()}`
    yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS pie_lock (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    const tryLock = sql.withTransaction(Effect.gen(function*() {
      const now = Date.now()
      yield* sql`DELETE FROM pie_lock WHERE name = 'runtime' AND expires_at < ${now}`
      yield* sql`INSERT OR IGNORE INTO pie_lock ${sql.insert({ name: "runtime", owner, expires_at: now + 3000 })}`
      const [row] = yield* sql<{ owner: string }>`SELECT owner FROM pie_lock WHERE name = 'runtime'`
      return row?.owner === owner ? undefined : row?.owner
    })).pipe(Effect.orDie)
    const deadline = Date.now() + 10_000
    for (;;) {
      const holder = yield* tryLock
      if (holder === undefined) break
      if (Date.now() > deadline) return yield* Effect.die(new StorageLocked({ owner: holder }))
      yield* Effect.sleep("200 millis")
    }
    yield* sql`UPDATE pie_lock SET expires_at = ${Date.now() + 3000} WHERE name = 'runtime' AND owner = ${owner}`.pipe(
      Effect.orDie,
      Effect.delay("1 second"),
      Effect.forever,
      FiberSet.run(fibers)
    )
    const release = Effect.ignore(sql`DELETE FROM pie_lock WHERE name = 'runtime' AND owner = ${owner}`)
    yield* Effect.addFinalizer(() => release)

    // -- per-session state cache and locks ------------------------------------
    const cache = new Map<string, { leafId: string | null; state: Agent.AgentState }>()
    const locks = new Map<string, Semaphore.Semaphore>()
    const lockOf = (sessionId: string) => {
      let lock = locks.get(sessionId)
      if (!lock) {
        lock = Semaphore.makeUnsafe(1)
        locks.set(sessionId, lock)
      }
      return lock
    }

    const load = (sessionId: string) =>
      Effect.gen(function*() {
        const cached = cache.get(sessionId)
        if (cached) return cached.state
        const session = yield* log.getSession(sessionId)
        const state = Agent.fold(session.model, yield* log.branch(sessionId))
        cache.set(sessionId, { leafId: session.leafId, state })
        return state
      })

    // -- appending -------------------------------------------------------------
    const appendUnlocked = (sessionId: string, event: NewEvent) =>
      Effect.gen(function*() {
        const state = yield* load(sessionId)
        const { event: stored, inserted } = yield* log.append(sessionId, event)
        if (inserted) {
          cache.set(sessionId, { leafId: stored.id, state: Agent.evolve(state, stored) })
          yield* events.publish({ type: "event", sessionId, event: stored })
          wake(sessionId)
          wakeReactions(sessionId)
        }
        return stored
      })

    const append = (sessionId: string, event: NewEvent) => lockOf(sessionId).withPermits(1)(appendUnlocked(sessionId, event))

    const emitter = (sessionId: string, prefix: string) => {
      let n = 0
      return (type: string, data: unknown): Effect.Effect<void, EmitError> =>
        Effect.gen(function*() {
          const definition = (yield* registries.eventTypes.get).get(type)
          if (!definition) return yield* new EmitError({ type, message: `event type "${type}" is not registered` })
          const encoded = yield* Schema.encodeUnknownEffect(definition.schema)(data).pipe(
            Effect.mapError((e) => new EmitError({ type, message: e.message }))
          )
          yield* Effect.orDie(append(sessionId, { id: `${prefix}/emit/${n++}`, type, data: encoded }))
        })
    }

    // -- commands ----------------------------------------------------------------
    let draining = false
    const inFlight = new Map<string, Set<string>>()
    const timers = new Set<string>()
    const tickers = new Map<string, { dirty: boolean; running: boolean }>()

    const callModel = (sessionId: string, command: Extract<Agent.Command, { _tag: "CallModel" }>) =>
      Effect.gen(function*() {
        const state = yield* load(sessionId)
        const session = yield* log.getSession(sessionId)
        const { attempt, callId, runId, turn } = command
        if (state.run?.aborted) {
          yield* append(sessionId, {
            id: `${callId}/responded`,
            type: "model/responded",
            data: { callId, turn, text: "", reasoning: "", toolCalls: [], finishReason: "aborted", model: state.model, usage: {} }
          })
          return
        }
        const branch = yield* log.branch(sessionId)
        const tools = yield* registries.tools.get
        const context: ContextEvent = {
          sessionId,
          cwd: session.cwd,
          system: [...(yield* registries.prompt.get)],
          messages: Agent.toMessages(branch),
          tools: [...tools.keys()]
        }
        yield* runHooks("context", context)
        const system = context.system.map((p) => p.text).join("\n\n")
        const offered = context.tools.flatMap((name) => {
          const tool = tools.get(name)
          return tool ? [tool] : []
        })
        yield* append(sessionId, {
          id: `${callId}/requested/${attempt}`,
          type: "model/requested",
          data: { callId, turn, attempt, model: state.model, system, tools: offered.map((t) => t.name) }
        })

        const fail = (message: string) =>
          append(sessionId, {
            id: `${callId}/failed/${attempt}`,
            type: "model/failed",
            data: { callId, attempt, message, retryAt: Date.now() + 1000 * 2 ** (attempt - 1) }
          })

        const model = (yield* registries.models.get).get(state.model)
        if (!model) return yield* fail(`Model "${state.model}" is not registered by any plugin`)

        const toolkit = {
          tools: Object.fromEntries(offered.map((t) => [
            t.name,
            Tool.dynamic(
              t.name,
              hasNoFields(t.parameters)
                ? { description: t.description, parameters: EMPTY_OBJECT }
                : { description: t.description, parameters: t.parameters }
            )
          ])),
          handle: () => Effect.die("Pie executes tools itself")
        } as unknown as Toolkit.WithHandler<Record<string, Tool.Any>>
        const prompt = Prompt.make([
          ...(system.length > 0 ? [{ role: "system" as const, content: system }] : []),
          ...context.messages
        ])

        let text = ""
        let reasoning = ""
        const toolCalls: Array<Agent.ToolCall> = []
        let finishReason = "unknown"
        let usage: Agent.Usage = {}
        const stream = LanguageModel.streamText({
          prompt,
          toolkit,
          disableToolCallResolution: true,
          toolCallValidation: "deferred"
        }) as Stream.Stream<Response.StreamPart<Record<string, Tool.Any>>, AiError.AiError, LanguageModel.LanguageModel>
        const outcome = yield* stream.pipe(
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
          Effect.as("done" as const),
          Effect.raceFirst(Effect.as(signals.await(runId), "aborted" as const)),
          Effect.catchCause((cause) => Effect.succeed({ error: errorMessage(cause) }))
        )
        if (typeof outcome === "object") return yield* fail(outcome.error)
        const aborted = outcome === "aborted"
        yield* append(sessionId, {
          id: `${callId}/responded`,
          type: "model/responded",
          data: {
            callId,
            turn,
            text,
            reasoning,
            // An aborted stream keeps its partial text but not half-received tool calls.
            toolCalls: aborted ? [] : toolCalls,
            finishReason: aborted ? "aborted" : finishReason,
            model: model.id,
            usage
          }
        })
      })

    const runTool = (sessionId: string, command: Extract<Agent.Command, { _tag: "RunTool" }>) =>
      Effect.gen(function*() {
        const { call, runId, turn } = command
        const state = yield* load(sessionId)
        const session = yield* log.getSession(sessionId)
        // Provider tool-call ids are not unique across a run (or a restart): scope them by turn.
        const prefix = `${runId}/t${turn}/${call.id}`
        const finish = (result: Omit<Agent.CoreEvents["tool/finished"], "toolCallId" | "name">) =>
          append(sessionId, { id: `${prefix}/finished`, type: "tool/finished", data: { toolCallId: call.id, name: call.name, ...result } })
        const error = (content: string) => finish({ content, isError: true })

        const alreadyStarted = state.run?.started.has(call.id) ?? false
        if (state.run?.aborted) {
          return yield* error(alreadyStarted ? "Aborted while running; it may have partially taken effect." : "Aborted before running.")
        }
        const tool = (yield* registries.tools.get).get(call.name)
        if (!tool) return yield* error(`Tool "${call.name}" is not available (its plugin may have been removed).`)
        if (alreadyStarted && !tool.idempotent) {
          return yield* error(
            `The process restarted while "${call.name}" was running. Its outcome is unknown: ` +
              `it may or may not have taken effect. Check the current state before retrying.`
          )
        }
        yield* append(sessionId, { id: `${prefix}/started`, type: "tool/started", data: { toolCallId: call.id, name: call.name } })

        const result: ToolOutput = yield* Effect.gen(function*() {
          const decode = Schema.decodeUnknownEffect(tool.parameters)
          const decoded = yield* decode(call.params).pipe(
            Effect.catch(() => decode(withoutNulls(call.params))),
            Effect.result
          )
          if (decoded._tag === "Failure") return { content: `Invalid parameters: ${String(decoded.failure)}`, isError: true }
          const before: ToolBeforeEvent = {
            sessionId,
            toolCallId: call.id,
            tool: call.name,
            params: decoded.success,
            decision: { _tag: "Allow" }
          }
          yield* runHooks("tool.before", before)
          if (before.decision._tag === "Deny") return { content: `Denied: ${before.decision.reason}`, isError: true }
          const context: ToolContext = {
            sessionId,
            runId,
            toolCallId: call.id,
            cwd: session.cwd,
            emit: emitter(sessionId, prefix)
          }
          const output = yield* tool.execute(before.params, context).pipe(
            Effect.catchCause((cause) => Effect.succeed({ content: `Tool failed: ${errorMessage(cause)}`, isError: true }))
          )
          const after: ToolAfterEvent = { sessionId, toolCallId: call.id, tool: call.name, params: before.params, output }
          yield* runHooks("tool.after", after)
          return after.output
        }).pipe(
          Effect.raceFirst(Effect.as(signals.await(runId), {
            content: "Aborted by the user while running; it may have partially taken effect.",
            isError: true
          }))
        )
        yield* finish({
          content: result.content,
          isError: result.isError ?? false,
          ...(result.details === undefined ? {} : { details: result.details })
        })
      })

    const execute = (sessionId: string, command: Agent.Command): Effect.Effect<unknown, SessionNotFound> => {
      switch (command._tag) {
        case "CallModel":
          return Effect.provideService(callModel(sessionId, command), Registries, registries)
        case "RunTool":
          return Effect.provideService(runTool(sessionId, command), Registries, registries)
        case "Deliver":
          return Effect.forEach(command.inputs, (input) =>
            append(sessionId, { id: `input/${input.inputId}`, type: "user", data: { text: input.text, inputId: input.inputId } }))
        case "EndRun":
          return append(sessionId, {
            id: `${command.runId}/end`,
            type: "run/ended",
            data: { runId: command.runId, status: command.status, ...(command.message ? { message: command.message } : {}) }
          })
        case "WakeAt":
          return Effect.void
      }
    }

    /**
     * Every command must leave a trace, or the tick would decide the same thing
     * again at once. A crashed tool becomes an error result, a crashed model
     * call a model/failed (retried with backoff); anything else is retried with
     * backoff instead of in a tight loop.
     */
    const failures = new Map<string, { readonly count: number; readonly retryAt: number }>()
    const settleFailure = (sessionId: string, command: Agent.Command, cause: Cause.Cause<unknown>) =>
      Effect.gen(function*() {
        const message = errorMessage(cause)
        yield* Effect.logError(`pie: command ${command.key} failed`, Cause.pretty(cause))
        if (command._tag === "RunTool") {
          return yield* Effect.ignore(append(sessionId, {
            id: `${command.runId}/t${command.turn}/${command.call.id}/finished`,
            type: "tool/finished",
            data: { toolCallId: command.call.id, name: command.call.name, content: `Tool crashed: ${message}`, isError: true }
          }))
        }
        if (command._tag === "CallModel") {
          return yield* Effect.ignore(append(sessionId, {
            id: `${command.callId}/failed/${command.attempt}`,
            type: "model/failed",
            data: { callId: command.callId, attempt: command.attempt, message, retryAt: Date.now() + 1000 * 2 ** (command.attempt - 1) }
          }))
        }
        const count = (failures.get(command.key)?.count ?? 0) + 1
        const delay = Math.min(30_000, 500 * 2 ** (count - 1))
        failures.set(command.key, { count, retryAt: Date.now() + delay })
        yield* Effect.sync(() => wake(sessionId)).pipe(Effect.delay(delay), FiberSet.run(fibers))
      })

    const tickOnce = (sessionId: string) =>
      Effect.gen(function*() {
        if (draining || !started) return
        const state = yield* load(sessionId)
        let keys = inFlight.get(sessionId)
        if (!keys) {
          keys = new Set()
          inFlight.set(sessionId, keys)
        }
        for (const command of Agent.decide(state, Date.now())) {
          if (command._tag === "WakeAt") {
            const timer = `${sessionId}:${command.key}`
            if (timers.has(timer)) continue
            timers.add(timer)
            yield* Effect.sync(() => {
              timers.delete(timer)
              wake(sessionId)
            }).pipe(Effect.delay(Math.max(0, command.at - Date.now())), FiberSet.run(fibers))
            continue
          }
          if (keys.has(command.key)) continue
          const failure = failures.get(command.key)
          if (failure && Date.now() < failure.retryAt) continue
          keys.add(command.key)
          const owned = keys
          yield* execute(sessionId, command).pipe(
            Effect.tap(() => Effect.sync(() => failures.delete(command.key))),
            Effect.catchCause((cause) => settleFailure(sessionId, command, cause)),
            Effect.ensuring(Effect.sync(() => {
              owned.delete(command.key)
              wake(sessionId)
            })),
            FiberSet.run(fibers)
          )
        }
      })

    function wake(sessionId: string): void {
      let ticker = tickers.get(sessionId)
      if (!ticker) {
        ticker = { dirty: false, running: false }
        tickers.set(sessionId, ticker)
      }
      ticker.dirty = true
      if (ticker.running) return
      ticker.running = true
      const t = ticker
      runFork(Effect.gen(function*() {
        while (t.dirty) {
          t.dirty = false
          // Under the session lock: API calls that append several events (prompt) are seen at once.
          yield* lockOf(sessionId).withPermits(1)(tickOnce(sessionId)).pipe(
            Effect.catchCause((cause) => Effect.logError("pie: tick failed", Cause.pretty(cause)))
          )
        }
        t.running = false
      }))
    }

    // -- reactions (react) -------------------------------------------------------
    yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS pie_cursors (
      reaction_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (reaction_id, session_id))`)
    const reactors = new Map<string, { dirty: boolean; running: boolean }>()

    const reactOnce = (sessionId: string) =>
      Effect.gen(function*() {
        const reactions = [...(yield* registries.reactions.get).values()]
        if (reactions.length === 0) return
        const all = yield* log.all(sessionId)
        const maxSeq = all.length > 0 ? all[all.length - 1]!.seq : 0
        for (const reaction of reactions) {
          const [row] = yield* sql<{ seq: number }>`SELECT seq FROM pie_cursors
            WHERE reaction_id = ${reaction.id} AND session_id = ${sessionId}`
          let cursor = row?.seq
          if (cursor === undefined) {
            // A new reaction starts from now, not from history.
            cursor = maxSeq
            yield* sql`INSERT OR IGNORE INTO pie_cursors ${sql.insert({ reaction_id: reaction.id, session_id: sessionId, seq: cursor })}`
            continue
          }
          for (const event of all) {
            if (event.seq <= cursor) continue
            if (reaction.on.includes(event.type)) {
              yield* reaction.run(event, {
                sessionId,
                emit: emitter(sessionId, `react/${reaction.id}/${event.id}`)
              }).pipe(Effect.catchCause((cause) => Effect.logError(`pie: reaction ${reaction.id} failed`, Cause.pretty(cause))))
            }
            yield* sql`UPDATE pie_cursors SET seq = ${event.seq} WHERE reaction_id = ${reaction.id} AND session_id = ${sessionId}`
          }
        }
      }).pipe(Effect.orDie)

    function wakeReactions(sessionId: string): void {
      let reactor = reactors.get(sessionId)
      if (!reactor) {
        reactor = { dirty: false, running: false }
        reactors.set(sessionId, reactor)
      }
      reactor.dirty = true
      if (reactor.running) return
      reactor.running = true
      const r = reactor
      runFork(Effect.gen(function*() {
        while (r.dirty) {
          r.dirty = false
          yield* reactOnce(sessionId).pipe(Effect.catchCause((cause) => Effect.logError("pie: reactions failed", Cause.pretty(cause))))
        }
        r.running = false
      }))
    }

    // -- startup: resume every open run (called once plugins are loaded) ----------
    let started = false
    const start = Effect.gen(function*() {
      if (started) return
      started = true
      for (const session of yield* log.listSessions) {
        const state = yield* Effect.orDie(load(session.id))
        if (state.run) wake(session.id)
        wakeReactions(session.id)
      }
    })

    // -- API ---------------------------------------------------------------------------
    const startRun = (sessionId: string, text: string) =>
      Effect.gen(function*() {
        const runId = randomUUID()
        yield* appendUnlocked(sessionId, { id: `${runId}/start`, type: "run/started", data: { runId } })
        yield* appendUnlocked(sessionId, { id: `${runId}/prompt`, type: "user", data: { text } })
      })

    const enqueueUnlocked = (sessionId: string, kind: "steer" | "followUp", text: string) =>
      Effect.gen(function*() {
        const state = yield* load(sessionId)
        if (!state.run) return yield* startRun(sessionId, text)
        const inputId = randomUUID()
        yield* appendUnlocked(sessionId, { id: `queued/${inputId}`, type: "input/queued", data: { inputId, kind, text } })
      })

    return Runtime.of({
      prompt: (sessionId, text, options) =>
        lockOf(sessionId).withPermits(1)(Effect.gen(function*() {
          const state = yield* load(sessionId)
          if (state.run) {
            if (options?.streamingBehavior) return yield* enqueueUnlocked(sessionId, options.streamingBehavior, text)
            return yield* new SessionBusy({ sessionId, runId: state.run.runId })
          }
          yield* startRun(sessionId, text)
        })),
      enqueue: (sessionId, kind, text) => lockOf(sessionId).withPermits(1)(enqueueUnlocked(sessionId, kind, text)),
      abort: (sessionId) =>
        lockOf(sessionId).withPermits(1)(Effect.gen(function*() {
          const state = yield* load(sessionId)
          if (!state.run) return
          const { runId } = state.run
          yield* appendUnlocked(sessionId, { id: `${runId}/abort`, type: "abort/requested", data: { runId } })
          yield* signals.fire(runId)
        })),
      navigate: (sessionId, eventId) =>
        lockOf(sessionId).withPermits(1)(Effect.gen(function*() {
          const state = yield* load(sessionId)
          if (state.run) return yield* new SessionBusy({ sessionId, runId: state.run.runId })
          yield* log.setLeaf(sessionId, eventId)
          cache.delete(sessionId)
          yield* load(sessionId)
        })),
      setModel: (sessionId, model) =>
        Effect.asVoid(append(sessionId, { id: `model/${randomUUID()}`, type: "model/selected", data: { model } })),
      state: load,
      awaitIdle: (sessionId) =>
        Effect.gen(function*() {
          for (;;) {
            const state = yield* load(sessionId)
            if (!state.run) return state.lastOutcome
            yield* Effect.sleep("20 millis")
          }
        }),
      append,
      start,
      release: Effect.andThen(Effect.sync(() => {
        draining = true
      }), release),
      drain: (timeout = 30_000) =>
        Effect.gen(function*() {
          draining = true
          const until = Date.now() + timeout
          while (Date.now() < until && [...inFlight.values()].some((keys) => keys.size > 0)) {
            yield* Effect.sleep("20 millis")
          }
        })
    })
  })
}
