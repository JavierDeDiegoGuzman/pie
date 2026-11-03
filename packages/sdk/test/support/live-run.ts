/**
 * Manual live run against OpenCode Go with all built-in plugins.
 *   node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"
 * Prints the transcript. Plugins written by the agent go to <cwd>/.pie/plugins.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie, Storage } from "../../src/index.ts"

const [dir] = process.argv.slice(2) as [string]

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: dir, model: "opencode-go/deepseek-v4.1-flash" })
  yield* session.prompt(
    process.argv[3]!
  )
  const outcome = yield* session.awaitIdle
  for (const e of yield* session.entries) {
    if (e.kind === "assistant") {
      console.log(`[assistant] ${e.data.text.slice(0, 300)}${e.data.toolCalls.map((c) => `\n  → ${c.name}(${JSON.stringify(c.params).slice(0, 160)})`).join("")}`)
    } else if (e.kind === "toolResult") console.log(`[${e.data.toolName}${e.data.isError ? " ERROR" : ""}] ${e.data.content.slice(0, 300)}`)
    else console.log(`[${e.kind}] ${JSON.stringify(e.data).slice(0, 200)}`)
  }
  console.log("OUTCOME", JSON.stringify(outcome))
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Pie.layer({ storage: Storage.memory, plugins: Pie.builtins, pluginDirectories: [`${dir}/.pie/plugins`] })),
    Effect.scoped,
    Effect.timeout("150 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
