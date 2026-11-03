/**
 * Recovery without plugins: reads and writes the configuration log straight
 * from the database, so it works however broken the agent left the plugins.
 * Used by the `pie` CLI and by the supervisor's automatic rollback.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { ConfigLog } from "./ConfigLog.ts"
import { describe } from "./Plugins.ts"

const withConfig = (database: string) => Layer.effect(ConfigLog, ConfigLog.make).pipe(Layer.provide(SqliteClient.layer({ filename: database })), Layer.orDie)

export const explain = (database: string) =>
  Effect.gen(function*() {
    const config = yield* ConfigLog
    const state = yield* config.state
    return {
      installed: [...state.installed.values()].map(({ hash, id, seq }) => ({ id, version: hash, seq })),
      disabled: [...state.disabled],
      lastGood: state.lastGood,
      head: state.head,
      history: (yield* config.history).map(describe)
    }
  }).pipe(Effect.provide(withConfig(database)))

/** Appends a config/reset. `target`: a config seq, or "last-good" (0 when nothing was ever marked good). */
export const rollback = (database: string, target: number | "last-good", reason: string) =>
  Effect.gen(function*() {
    const config = yield* ConfigLog
    const state = yield* config.state
    const toSeq = target === "last-good" ? state.lastGood : target
    if (toSeq === state.head) return { toSeq, changed: false }
    yield* config.append("config/reset", { toSeq, reason })
    return { toSeq, changed: true }
  }).pipe(Effect.provide(withConfig(database)))

export const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
