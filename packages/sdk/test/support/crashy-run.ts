/**
 * Child process for the automatic rollback test, run under Supervisor.
 * First start: waits until the composition is marked good, then installs a
 * plugin that crashes the process shortly after loading. The supervisor
 * restarts it, it crashes again (the plugin is in the configuration), and
 * after two quick crashes the supervisor rolls back to the last good
 * composition. The next start finds the plugin gone and writes the result.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as fs from "node:fs"
// Deliberately not "../../src/index.ts": the agent's plugin must load @pie/sdk
// for the first time through Pie's module resolver (TypeScript stripped).
import * as Pie from "../../src/Pie.ts"
import { Plugins } from "../../src/core/Plugins.ts"
import * as Storage from "../../src/core/Storage.ts"

const [db, dir, out] = process.argv.slice(2) as [string, string, string]
fs.appendFileSync(`${out}.starts`, "start\n")

const BOMB = `import { Effect } from "effect"
import { Plugin } from "@pie/sdk"
export default Plugin.define({
  id: "bomb",
  setup: () => Effect.sync(() => void setTimeout(() => { throw new Error("boom") }, 100))
})
`

const program = Effect.gen(function*() {
  const plugins = yield* Plugins
  yield* Effect.sleep("1 second") // a plugin that breaks Pie gets the chance to do it
  const loaded = (yield* plugins.explain).loaded.map((p) => p.id)
  if (!fs.existsSync(`${out}.installed`)) {
    fs.writeFileSync(`${out}.installed`, "")
    yield* Effect.orDie(plugins.install(BOMB))
    return yield* Effect.never // the bomb goes off
  }
  fs.writeFileSync(out, JSON.stringify({ loaded, explain: yield* plugins.explain }))
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Pie.layer({ storage: Storage.sqlite(db), plugins: [], pluginCacheDirectory: dir, goodAfter: 300 })),
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.andThen(Effect.sync(() => process.exit(0)))
  )
)
