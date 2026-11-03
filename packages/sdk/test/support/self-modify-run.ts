/**
 * Child process: a scripted agent installs a broken plugin (rejected), then a
 * valid one, then uses its tool. Plugin sources import "effect" and "@pie/sdk"
 * from a cache directory outside the repo (Pie's module resolver).
 *
 *   node self-modify-run.ts <db> <cacheDir> <hot|restart> <outFile>
 *
 * In restart mode it runs under Supervisor: installing exits with the restart
 * code and the next process resumes the run with the plugin loaded.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import { Pie, Storage } from "../../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, toolResults } from "./fake-model.ts"

const [db, cacheDir, mode, outFile] = process.argv.slice(2) as [string, string, "hot" | "restart", string]
fs.appendFileSync(`${outFile}.starts`, "start\n")

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

const model = fakeModelPlugin((messages) => {
  switch (toolResults(messages).length) {
    case 0:
      return { tools: [{ name: "plugin_install", params: { source: "export default {{ broken" } }] }
    case 1:
      return { tools: [{ name: "plugin_install", params: { source: VALID } }] }
    case 2:
      return { tools: [{ name: "word_count", params: { text: "uno dos tres" } }] }
    default:
      return { text: "done" }
  }
})

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const existing = (yield* pie.list).find((s) => s.id === "s1")
  const session = existing ? yield* pie.open("s1") : yield* pie.create({ id: "s1", cwd: cacheDir, model: FAKE_MODEL })
  if (!existing) yield* session.prompt("give yourself a word counter")
  const outcome = yield* session.awaitIdle
  const events = yield* session.events
  fs.writeFileSync(outFile, JSON.stringify({ outcome, events }))
})

NodeRuntime.runMain(
  program.pipe(
    Pie.exitOnRestart,
    Effect.provide(Pie.layer({
      storage: Storage.sqlite(db),
      plugins: [model, ...Pie.builtins.filter((p) => p.id !== "opencode-go")],
      reload: mode,
      pluginCacheDirectory: cacheDir
    })),
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
