/** Child process: opens a Pie on the database given and keeps it until killed. Prints "ready" once it holds it. */
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie, Storage } from "../../src/index.ts"

const [db] = process.argv.slice(2) as [string]
NodeRuntime.runMain(
  Effect.sync(() => console.log("ready")).pipe(
    Effect.andThen(Effect.never),
    Effect.provide(Pie.layer({ storage: Storage.sqlite(db) })),
    Effect.scoped
  )
)
