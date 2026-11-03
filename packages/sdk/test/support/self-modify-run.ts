/**
 * Child process: a scripted agent writes a broken plugin into its plugins
 * folder (restart refuses it), then a valid one (restart applies it), then
 * uses its tool. The home is outside the repo, so the plugin's imports of
 * "effect" and "@pie/sdk" go through Pie's module resolver.
 *
 *   node self-modify-run.ts <home> <hot|restart> <outFile>
 *
 * In restart mode it runs under Supervisor: restart exits with the restart
 * code and the next process resumes the run with the plugin loaded.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as Pie from "../../src/Pie.ts"
import { FAKE_MODEL, fakeModelPlugin, toolResults } from "./fake-model.ts"

const [home, mode, outFile] = process.argv.slice(2) as [string, "hot" | "restart", string]
fs.appendFileSync(`${outFile}.starts`, "start\n")

const file = path.join(home, "plugins", "word-count", "index.ts")
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
const restart = { name: "restart", params: { reason: "word counter" } }
const steps = [
  { name: "write", params: { path: file, content: "export default {{ broken" } },
  restart,
  { name: "write", params: { path: file, content: VALID } },
  restart,
  { name: "word_count", params: { text: "uno dos tres" } }
]
const model = fakeModelPlugin((messages) => {
  const n = toolResults(messages).length
  return n < steps.length ? { tools: [steps[n]!] } : { text: "done" }
})

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const existing = (yield* pie.list).find((s) => s.id === "s1")
  const session = existing ? yield* pie.open("s1") : yield* pie.create({ id: "s1", cwd: home, model: FAKE_MODEL })
  if (!existing) yield* session.prompt("give yourself a word counter")
  const outcome = yield* session.awaitIdle
  const events = yield* session.events
  fs.writeFileSync(outFile, JSON.stringify({ outcome, events }))
})

NodeRuntime.runMain(
  program.pipe(
    Pie.exitOnRestart,
    Effect.provide(Pie.layer({ home, seed: ["coding-tools", "self"], plugins: [model], reload: mode })),
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
