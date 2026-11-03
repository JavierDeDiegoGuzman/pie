/**
 * Child process for the workflow engine test (Effect workflows journaled in
 * Pie's database). Phases:
 *   start   begin the workflow; it runs activity "a", then a durable 1.5 s clock (parent SIGKILLs meanwhile)
 *   resume  the engine resumes it on register; the clock fires at its original time; then it waits for an
 *           approval (DurableDeferred), which this process gives; prints the result
 *   again   execute returns the stored result without running anything
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow"
import * as fs from "node:fs"
import { Pie, Storage } from "../../src/index.ts"

const [db, log, phase] = process.argv.slice(2) as [string, string, "start" | "resume" | "again"]
const note = (line: string) => fs.appendFileSync(log, `${line} ${Date.now()}\n`)

const Approval = DurableDeferred.make("approval", { success: Schema.String })

const Flow = Workflow.make("Pie/TestFlow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: (p) => p.id
})

const FlowLive = Flow.toLayer(Effect.fn(function*() {
  const a = yield* Activity.make({ name: "a", success: Schema.String, execute: Effect.sync(() => (note("a"), "A")) })
  yield* DurableClock.sleep({ name: "pause", duration: "1500 millis", inMemoryThreshold: 0 })
  const token = yield* DurableDeferred.token(Approval)
  yield* Activity.make({ name: "publish-token", execute: Effect.sync(() => fs.writeFileSync(`${log}.token`, token)) })
  const answer = yield* DurableDeferred.await(Approval)
  const b = yield* Activity.make({ name: "b", success: Schema.String, execute: Effect.sync(() => (note("b"), "B")) })
  return `${a}${answer}${b}`
}))

const program = Effect.gen(function*() {
  if (phase === "start") {
    yield* Flow.execute({ id: "w1" }, { discard: true })
    return yield* Effect.never
  }
  if (phase === "resume") {
    while (!fs.existsSync(`${log}.token`)) yield* Effect.sleep("50 millis")
    note("token-seen")
    const token = fs.readFileSync(`${log}.token`, "utf8") as DurableDeferred.Token
    yield* DurableDeferred.succeed(Approval, { token, value: "ok" })
  }
  const result = yield* Flow.execute({ id: "w1" })
  process.stdout.write(JSON.stringify({ result }) + "\n")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(FlowLive.pipe(Layer.provideMerge(Pie.layer({ storage: Storage.sqlite(db), plugins: [], selfModify: false })))),
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
