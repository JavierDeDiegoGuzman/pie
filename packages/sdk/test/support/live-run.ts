/**
 * Manual live run against OpenCode Go with all built-in plugins.
 *   node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"
 * Prints the transcript. Pie's home (sessions, editable plugins) is <cwd>/.pie.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie } from "../../src/index.ts"

const [dir] = process.argv.slice(2) as [string]

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: dir, model: "opencode-go/deepseek-v4.1-flash" })
  yield* session.prompt(
    process.argv[3]!
  )
  const outcome = yield* session.awaitIdle
  for (const e of yield* session.events) {
    const d = e.data as any
    if (e.type === "model/responded") {
      console.log(`[assistant] ${d.text.slice(0, 300)}${d.toolCalls.map((c: any) => `\n  → ${c.name}(${JSON.stringify(c.params).slice(0, 160)})`).join("")}`)
    } else if (e.type === "tool/finished") console.log(`[${d.name}${d.isError ? " ERROR" : ""}] ${d.content.slice(0, 300)}`)
    else if (e.type !== "model/requested" && e.type !== "tool/started") console.log(`[${e.type}] ${JSON.stringify(d).slice(0, 200)}`)
  }
  console.log("OUTCOME", JSON.stringify(outcome))
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Pie.layer({ home: `${dir}/.pie`, seed: [...Pie.DEFAULT_SEED, "todo"] })),
    Effect.scoped,
    Effect.timeout("150 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
