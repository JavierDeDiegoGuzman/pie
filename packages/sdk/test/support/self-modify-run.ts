/**
 * Child process: a scripted agent first writes a broken plugin, then a valid
 * one, then uses the tool the plugin added. The plugin directory is outside the
 * repo, so its imports of "effect" and "@pie/sdk" go through Pie's resolver.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie, Storage } from "../../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, toolResults } from "./fake-model.ts"

const [pluginDir, cwd] = process.argv.slice(2) as [string, string]

const VALID = `import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "@pie/sdk"

export default Plugin.define({
  id: "word-count",
  setup: (ctx) =>
    ctx.tools.transform((tools) => {
      tools.set("word_count", defineTool({
        name: "word_count",
        description: "Count words",
        parameters: Schema.Struct({ text: Schema.String }),
        idempotent: true,
        execute: ({ text }) => Effect.succeed({ content: String(text.split(/\\s+/).filter(Boolean).length) })
      }))
    })
})
`

const offered: Array<ReadonlyArray<string>> = []
const model = fakeModelPlugin((messages, tools) => {
  offered.push(tools)
  const results = toolResults(messages)
  switch (results.length) {
    case 0:
      return { tools: [{ name: "plugin_write", params: { name: "word-count", source: "export default {{ broken" } }] }
    case 1:
      return { tools: [{ name: "plugin_write", params: { name: "word-count", source: VALID } }] }
    case 2:
      return { tools: [{ name: "word_count", params: { text: "uno dos tres" } }] }
    default:
      return { text: "done" }
  }
})

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd, model: FAKE_MODEL })
  yield* session.prompt("give yourself a word counter")
  const outcome = yield* session.awaitIdle
  const results = (yield* session.entries).flatMap((e) => (e.kind === "toolResult" ? [e.data] : []))
  process.stdout.write(JSON.stringify({ outcome, results, offered }) + "\n")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Pie.layer({
      storage: Storage.memory,
      plugins: [model, ...Pie.builtins.filter((p) => p.id !== "opencode-go")],
      pluginDirectories: [pluginDir]
    })),
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
