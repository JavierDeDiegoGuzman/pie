/**
 * Recovery without plugins: reads and writes the configuration log and the
 * plugins folder of a Pie home directly, so it works however broken the agent
 * left its plugins. Used by the `pie` CLI and the supervisor's automatic
 * rollback.
 */
import * as path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { ConfigLog, type Files } from "./ConfigLog.ts"
import * as Folder from "./PluginFolder.ts"
import { describe } from "./Plugins.ts"

export const database = (home: string) => path.join(home, "pie.db")

const withConfig = (home: string) =>
  Layer.effect(ConfigLog, ConfigLog.make).pipe(Layer.provide(SqliteClient.layer({ filename: database(home) })), Layer.orDie)

export const explain = (home: string) =>
  Effect.gen(function*() {
    const config = yield* ConfigLog
    const state = yield* config.state
    const files = yield* Effect.promise(() => Folder.readFiles(path.join(home, "plugins")))
    return {
      folder: path.join(home, "plugins"),
      plugins: Folder.enabledPlugins(files),
      lastGood: state.lastGood,
      head: state.head,
      history: (yield* config.history).map(describe)
    }
  }).pipe(Effect.provide(withConfig(home)))

/** Restores the plugins folder of a snapshot (`last-good`: the last one marked good) and records it. */
export const rollback = (home: string, target: number | "last-good", reason: string) =>
  Effect.gen(function*() {
    const config = yield* ConfigLog
    const state = yield* config.state
    const toSeq = target === "last-good" ? state.lastGood : target
    const event = toSeq === 0 ? undefined : yield* config.get(toSeq)
    if (!event || event.type !== "plugins/snapshot") return { toSeq, changed: false }
    const { files, hash } = event.data as { files: Files; hash: string }
    yield* Effect.promise(() => Folder.writeFiles(path.join(home, "plugins"), files))
    yield* config.append("plugins/snapshot", { files, hash, reason: `rollback to #${toSeq}: ${reason}` })
    return { toSeq, changed: true }
  }).pipe(Effect.provide(withConfig(home)))

export const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
