/**
 * Child process for the automatic rollback test, run under Supervisor.
 * First start: waits until the plugins snapshot is marked good, then adds a
 * plugin that crashes the process shortly after loading and restarts. The
 * supervisor starts it again, it crashes again (the plugin is in the folder),
 * and after two quick crashes the supervisor restores the last good snapshot.
 * The next start finds the plugin gone and writes the result.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
// Deliberately not "../../src/index.ts": the plugin must load pie-agent for the
// first time through Pie's module resolver (TypeScript stripped).
import * as Pie from "../../src/Pie.ts"
import { Plugins } from "../../src/core/Plugins.ts"

const [home, out] = process.argv.slice(2) as [string, string]
fs.appendFileSync(`${out}.starts`, "start\n")

const BOMB = `import { Effect } from "effect"
import { Plugin } from "pie-agent"
export default Plugin.define({
  id: "bomb",
  setup: () => Effect.sync(() => void setTimeout(() => { throw new Error("boom") }, 100))
})
`

const program = Effect.gen(function*() {
  const plugins = yield* Plugins
  yield* Effect.sleep("1 second") // a plugin that breaks Pie gets the chance to do it (and the snapshot is marked good)
  const loaded = (yield* plugins.explain).plugins.map((p) => p.id)
  if (!fs.existsSync(`${out}.edited`)) {
    fs.writeFileSync(`${out}.edited`, "")
    fs.mkdirSync(path.join(home, "plugins", "bomb"), { recursive: true })
    fs.writeFileSync(path.join(home, "plugins", "bomb", "index.ts"), BOMB)
    yield* Effect.orDie(plugins.restart("bomb")) // validation passes: the crash comes later
    return yield* Effect.never // the bomb goes off
  }
  fs.writeFileSync(out, JSON.stringify({ loaded, explain: yield* plugins.explain }))
})

NodeRuntime.runMain(
  program.pipe(
    Pie.exitOnRestart,
    Effect.provide(Pie.layer({ home, seed: ["self"], goodAfter: 300 })),
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
