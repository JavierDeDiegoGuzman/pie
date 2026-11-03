/**
 * Effect's WorkflowEngine on Pie's database, so plugins can write multi-step
 * processes with effect/workflow (Activity, DurableDeferred, DurableClock)
 * and still have one store of truth.
 *
 * It is Effect's in-memory engine (WorkflowEngine.layerMemory) plus an
 * append-only journal of what that engine keeps in maps:
 *
 *   execution  started executions and their payload (resumed on register)
 *   activity   completed activity results (a replay returns them)
 *   deferred   completed DurableDeferreds (approvals, signals)
 *   clock      DurableClock wake-up times (rescheduled after a restart)
 *   result     final results (execute/poll after a restart)
 *
 * Like any workflow engine, it re-runs the workflow body on replay; only the
 * steps are memoized. Activities that were running when the process died run
 * again: keep them idempotent.
 */
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, FiberMap, Layer, Option, Schema, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { Workflow, WorkflowEngine } from "effect/workflow"

type WakeMode = "explicit" | "automatic"

const isUnwakeable = (result: Workflow.Result<unknown, unknown>, mode: WakeMode) =>
  result._tag === "Complete" || (mode === "automatic" && result.failed === true)

/** Exits whose values are already JSON-encoded by the engine wrapper. */
const EncodedExit = Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()))
const encodeExit = (exit: Exit.Exit<unknown, unknown>) => Schema.encodeSync(EncodedExit)(exit)
const decodeExit = (json: unknown) => Schema.decodeUnknownSync(EncodedExit)(json)

export const layer: Layer.Layer<WorkflowEngine.WorkflowEngine, never, SqlClient.SqlClient> = Layer.effect(
  WorkflowEngine.WorkflowEngine
)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const sql = yield* SqlClient.SqlClient

    yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS pie_workflow (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, kind TEXT NOT NULL, workflow TEXT,
      data TEXT NOT NULL, created_at INTEGER NOT NULL)`)

    const record = (id: string, executionId: string, kind: string, data: unknown, workflow?: string) =>
      Effect.asVoid(Effect.orDie(sql`INSERT OR IGNORE INTO pie_workflow ${
        sql.insert({ id, execution_id: executionId, kind, workflow: workflow ?? null, data: JSON.stringify(data), created_at: Date.now() })
      }`))
    const lookup = (id: string) =>
      sql<{ data: string }>`SELECT data FROM pie_workflow WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? Option.some(JSON.parse(rows[0].data) as unknown) : Option.none())),
        Effect.orDie
      )

    const workflows = new Map<string, {
      readonly workflow: Workflow.Any
      readonly execute: (payload: object, executionId: string) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>
      readonly scope: Scope.Scope
    }>()

    type ExecutionState = {
      readonly payload: object
      readonly execute: (payload: object, executionId: string) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>
      readonly parent: string | undefined
      instance: WorkflowEngine.WorkflowInstance["Service"]
      interrupted: boolean
      interruptedUnsafe: boolean
      resumeRequested: WakeMode | undefined
      fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined
      readonly done: Deferred.Deferred<void>
      readonly scope: Scope.Closeable
    }
    const executions = new Map<string, ExecutionState>()
    const activities = new Map<string, { exit: Exit.Exit<Workflow.Result<unknown, unknown>> | undefined }>()
    const deferredState = WorkflowEngine.makeDeferredState()
    const deferredResults = new Map<string, Exit.Exit<any, any>>()
    const clocks = yield* FiberMap.make<string>()

    // Workflow schemas are generic here; their decoding needs no services.
    const resultCodec = (workflow: Workflow.Any) =>
      Schema.toCodecJson(Schema.Exit(workflow.successSchema, workflow.errorSchema, Schema.Defect())) as unknown as Schema.Codec<
        Exit.Exit<unknown, unknown>,
        unknown
      >
    const payloadCodec = (workflow: Workflow.Any) =>
      Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<object, unknown>

    const resume = Effect.fnUntraced(function*(executionId: string, mode: WakeMode): Effect.fn.Return<void> {
      const state = executions.get(executionId)
      if (!state) return
      const exit = state.fiber?.pollUnsafe()
      if (exit && exit._tag === "Success" && isUnwakeable(exit.value, mode)) {
        return
      } else if (state.fiber && !exit) {
        const requested = state.resumeRequested
        state.resumeRequested = mode === "explicit" ? mode : requested ?? mode
        if (requested === undefined) {
          yield* Fiber.await(state.fiber).pipe(
            Effect.flatMap(() => {
              const next = state.resumeRequested!
              state.resumeRequested = undefined
              return resume(executionId, next)
            }),
            Effect.forkIn(scope)
          )
        }
        return
      }

      const entry = workflows.get(state.instance.workflow._tag)!
      const instance = WorkflowEngine.WorkflowInstance.initial(state.instance.workflow, state.instance.executionId, {
        scope: Scope.forkUnsafe(state.scope)
      })
      state.instance = instance
      state.fiber = yield* state.execute(state.payload, state.instance.executionId).pipe(
        Effect.onExit((exit) => {
          if (
            !state.interrupted ||
            (!state.interruptedUnsafe &&
              !instance.suspended &&
              !instance.abandoned &&
              !(Context.get(instance.workflow.annotations, Workflow.SuspendOnFailure) && Exit.isFailure(exit)))
          ) {
            return Effect.void
          }
          instance.interrupted = true
          instance.suspended = false
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
        }),
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
        (effect) => deferredState.trackRun(instance, effect),
        Effect.tap((result) => {
          if (result._tag !== "Complete") return Effect.void
          const persisted = Schema.encodeUnknownEffect(resultCodec(instance.workflow))(result.exit).pipe(
            Effect.flatMap((json) => record(`res/${executionId}`, executionId, "result", json, instance.workflow._tag)),
            Effect.catchCause(() => Effect.void)
          )
          return state.parent ? Effect.andThen(persisted, Effect.forkIn(resume(state.parent, "automatic"), scope)) : persisted
        }),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit) && exit.value._tag === "Suspended") return Effect.void
          return Effect.andThen(
            Scope.close(state.scope, Exit.void),
            Exit.isSuccess(exit) && exit.value._tag === "Complete" ? Deferred.succeed(state.done, void 0) : Effect.void
          )
        }),
        Effect.forkIn(entry.scope)
      )
    })

    const newExecution = (
      workflow: Workflow.Any,
      execute: ExecutionState["execute"],
      executionId: string,
      payload: object,
      parent: string | undefined
    ): ExecutionState => {
      const state: ExecutionState = {
        payload,
        execute,
        instance: WorkflowEngine.WorkflowInstance.initial(workflow, executionId),
        interrupted: false,
        interruptedUnsafe: false,
        resumeRequested: undefined,
        fiber: undefined,
        done: Deferred.makeUnsafe(),
        scope: Scope.makeUnsafe(),
        parent
      }
      executions.set(executionId, state)
      return state
    }

    const storedResult = (workflow: Workflow.Any, executionId: string) =>
      Effect.gen(function*() {
        const json = yield* lookup(`res/${executionId}`)
        if (Option.isNone(json)) return Option.none<Workflow.Result<unknown, unknown>>()
        const exit = yield* Effect.orDie(Schema.decodeUnknownEffect(resultCodec(workflow))(json.value))
        return Option.some(new Workflow.Complete({ exit }) as Workflow.Result<unknown, unknown>)
      })

    const engine = WorkflowEngine.makeUnsafe({
      register: Effect.fnUntraced(function*(workflow, execute) {
        workflows.set(workflow._tag, { workflow, execute, scope: yield* Effect.scope })
        // Resume executions that were running when the process stopped.
        const pending = yield* sql<{ execution_id: string; data: string }>`
          SELECT e.execution_id, e.data FROM pie_workflow e
          WHERE e.kind = 'execution' AND e.workflow = ${workflow._tag}
            AND NOT EXISTS (SELECT 1 FROM pie_workflow r WHERE r.kind = 'result' AND r.execution_id = e.execution_id)`.pipe(
          Effect.orDie
        )
        for (const row of pending) {
          if (executions.has(row.execution_id)) continue
          const payload = yield* Effect.orDie(
            Schema.decodeUnknownEffect(payloadCodec(workflow))(JSON.parse(row.data))
          )
          newExecution(workflow, execute, row.execution_id, payload as object, undefined)
          yield* Effect.forkIn(resume(row.execution_id, "explicit"), scope)
        }
      }),
      execute: Effect.fnUntraced(function*(workflow, options) {
        const entry = workflows.get(workflow._tag)
        if (!entry) return yield* Effect.orDie(Effect.fail(`Workflow ${workflow._tag} is not registered`))
        let state = executions.get(options.executionId)
        if (!state) {
          const stored = yield* storedResult(workflow, options.executionId)
          if (Option.isSome(stored)) return (options.discard ? undefined : stored.value) as any
          const json = yield* Effect.orDie(Schema.encodeUnknownEffect(payloadCodec(workflow))(options.payload))
          yield* record(`exec/${options.executionId}`, options.executionId, "execution", json, workflow._tag)
          state = newExecution(
            workflow,
            entry.execute,
            options.executionId,
            options.payload,
            options.detached ? undefined : options.parent?.executionId
          )
          yield* resume(options.executionId, "explicit")
        }
        if (options.discard) return
        const instance = state.instance
        const exit = yield* Fiber.await(state.fiber!)
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) && instance.suspended) {
          return new Workflow.Suspended({}) as any
        }
        return (yield* exit) as any
      }),
      awaitComplete: (_workflow, executionId) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          return state ? Deferred.await(state.done) : Effect.never
        }),
      interrupt: Effect.fnUntraced(function*(_workflow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.interrupted = true
        yield* resume(executionId, "explicit")
      }),
      interruptUnsafe: Effect.fnUntraced(function*(_workflow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.interrupted = true
        state.interruptedUnsafe = true
        if (state.fiber) yield* Fiber.interrupt(state.fiber)
        yield* resume(executionId, "explicit")
      }),
      resume(_workflow, executionId) {
        return resume(executionId, "explicit")
      },
      activityExecute: Effect.fnUntraced(function*(activity, attempt) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const activityId = `${instance.executionId}/${activity.name}/${attempt}`
        const journaled = yield* lookup(`act/${activityId}`)
        if (Option.isSome(journaled)) return new Workflow.Complete({ exit: decodeExit(journaled.value) })
        let state = activities.get(activityId)
        if (state) {
          const exit = state.exit
          if (exit && exit._tag === "Success" && exit.value._tag === "Suspended") {
            state.exit = undefined
          } else if (exit) {
            return yield* exit
          }
        } else {
          state = { exit: undefined }
          activities.set(activityId, state)
        }
        if (executions.get(instance.executionId)?.interrupted && !instance.interrupted) {
          return new Workflow.Suspended({})
        }
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(instance.workflow, instance.executionId)
        activityInstance.interrupted = instance.interrupted
        const owned = state
        return yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
          Effect.tap((result) =>
            result._tag === "Complete"
              ? record(`act/${activityId}`, instance.executionId, "activity", encodeExit(result.exit), instance.workflow._tag)
              : Effect.void
          ),
          Effect.onExit((exit) => {
            owned.exit = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? undefined : exit
            return Effect.void
          })
        )
      }),
      poll: (workflow, executionId) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          if (!state) return storedResult(workflow, executionId)
          const exit = state.fiber?.pollUnsafe()
          if (!exit) return Effect.succeedNone
          return exit._tag === "Success" ? Effect.succeedSome(exit.value) : Effect.die(exit.cause)
        }),
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const id = `${instance.executionId}/${deferred.name}`
        const cached = deferredResults.get(id)
        if (cached) return Option.some(cached)
        const journaled = yield* lookup(`def/${id}`)
        if (Option.isNone(journaled)) return Option.none()
        const exit = decodeExit(journaled.value)
        deferredResults.set(id, exit)
        return Option.some(exit)
      }),
      deferredDone: (options) =>
        Effect.gen(function*() {
          const id = `${options.executionId}/${options.deferredName}`
          if (deferredResults.has(id) || Option.isSome(yield* lookup(`def/${id}`))) return
          yield* record(`def/${id}`, options.executionId, "deferred", encodeExit(options.exit), options.workflowName)
          deferredResults.set(id, options.exit)
          const wake = Effect.andThen(
            deferredState.deferredDone(options.executionId, options.deferredName),
            resume(options.executionId, "automatic")
          )
          const current = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance)
          yield* Option.isSome(current) && current.value.executionId === options.executionId
            ? wake.pipe(Effect.forkIn(scope), Effect.asVoid)
            : wake
        }),
      scheduleClock: (workflow, options) =>
        Effect.gen(function*() {
          const id = `clock/${options.executionId}/${options.clock.name}`
          const existing = yield* lookup(id)
          let wakeAt: number
          if (Option.isSome(existing)) {
            wakeAt = (existing.value as { wakeAt: number }).wakeAt
          } else {
            wakeAt = Date.now() + Duration.toMillis(options.clock.duration)
            yield* record(id, options.executionId, "clock", { wakeAt }, workflow._tag)
          }
          yield* engine.deferredDone(options.clock.deferred, {
            workflowName: workflow._tag,
            executionId: options.executionId,
            deferredName: options.clock.deferred.name,
            exit: Exit.void
          }).pipe(
            Effect.delay(Math.max(0, wakeAt - Date.now())),
            FiberMap.run(clocks, `${options.executionId}/${options.clock.name}`, { onlyIfMissing: true }),
            Effect.asVoid
          )
        })
    })

    return engine
  })
)
