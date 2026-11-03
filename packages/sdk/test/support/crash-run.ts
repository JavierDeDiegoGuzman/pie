/**
 * Child process for the crash test. Phase "start" begins a run and blocks
 * inside two tools until the parent SIGKILLs it. Phase "resume" opens the same
 * database, waits for the run to finish and prints the entries as JSON.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import { defineTool, Pie, Plugin, Storage } from "../../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, last } from "./fake-model.ts"

const [db, log, phase] = process.argv.slice(2) as [string, string, "start" | "resume"]
const note = (line: string) => fs.appendFileSync(log, line + "\n")
const blocking = () => fs.existsSync(`${log}.block`)

const tools = Plugin.define({
  id: "crash-tools",
  setup: (ctx) =>
    ctx.tools.transform((registry) => {
      registry.set("write_file", defineTool({
        name: "write_file",
        description: "not idempotent",
        parameters: Schema.Struct({}),
        idempotent: false,
        execute: () => Effect.sync(() => note("write-start")).pipe(Effect.andThen(blocking() ? Effect.never : Effect.succeed({ content: "written" })))
      }))
      registry.set("read_file", defineTool({
        name: "read_file",
        description: "idempotent",
        parameters: Schema.Struct({}),
        idempotent: true,
        execute: () => Effect.sync(() => note("read-start")).pipe(Effect.andThen(blocking() ? Effect.never : Effect.succeed({ content: "contents" })))
      }))
    })
})

const model = fakeModelPlugin(
  (messages) =>
    last(messages).role === "tool"
      ? { text: "done" }
      : { tools: [{ name: "write_file", params: {} }, { name: "read_file", params: {} }] },
  () => note("llm")
)

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  if (phase === "start") {
    const session = yield* pie.create({ id: "s1", cwd: "/repo", model: FAKE_MODEL })
    yield* session.prompt("do it")
    return yield* Effect.never
  }
  const session = yield* pie.open("s1")
  const outcome = yield* session.awaitIdle
  process.stdout.write(JSON.stringify({ outcome, entries: yield* session.entries }) + "\n")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Pie.layer({ storage: Storage.sqlite(db), plugins: [model, tools] })),
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
