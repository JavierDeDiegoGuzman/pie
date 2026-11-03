/**
 * The configuration log: snapshots of the plugins folder. Every applied change
 * (the restart tool, a rollback, changes found at startup) records the full
 * content of `<home>/plugins`, so any earlier state can be restored, and a
 * rollback is just a new snapshot equal to an old one (undoable too).
 */
import { createHash } from "node:crypto"
import { Context, Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Relative path inside the plugins folder → content. */
export type Files = Readonly<Record<string, string>>

export interface ConfigEvents {
  readonly "plugins/snapshot": { readonly files: Files; readonly hash: string; readonly reason: string }
  /** The snapshot `seq` booted and worked: the target of automatic rollbacks. */
  readonly "config/good": { readonly seq: number }
}

export type ConfigEventType = keyof ConfigEvents

export interface ConfigEvent<K extends ConfigEventType = ConfigEventType> {
  readonly seq: number
  readonly type: K
  readonly data: ConfigEvents[K]
  readonly createdAt: number
}

export interface ConfigState {
  /** Seq of the latest snapshot (0 if none). */
  readonly head: number
  readonly current: ConfigEvents["plugins/snapshot"] | undefined
  /** Seq of the last snapshot marked good (0 if none). */
  readonly lastGood: number
}

export const fold = (events: ReadonlyArray<ConfigEvent>): ConfigState => {
  let head = 0
  let current: ConfigEvents["plugins/snapshot"] | undefined
  let lastGood = 0
  for (const event of events) {
    if (event.type === "plugins/snapshot") {
      head = event.seq
      current = event.data as ConfigEvents["plugins/snapshot"]
    } else if (event.type === "config/good") {
      lastGood = (event.data as ConfigEvents["config/good"]).seq
    }
  }
  return { head, current, lastGood }
}

export const hashSource = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 16)

export const hashFiles = (files: Files) =>
  hashSource(Object.keys(files).sort().map((name) => `${name}\0${files[name]}`).join("\0\0"))

export class ConfigLog extends Context.Service<ConfigLog, {
  readonly append: <K extends ConfigEventType>(type: K, data: ConfigEvents[K]) => Effect.Effect<ConfigEvent<K>>
  readonly history: Effect.Effect<ReadonlyArray<ConfigEvent>>
  readonly state: Effect.Effect<ConfigState>
  readonly get: (seq: number) => Effect.Effect<ConfigEvent | undefined>
}>()("pie/ConfigLog") {
  static readonly make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS pie_config (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    const decode = (r: { seq: number; type: ConfigEventType; data: string; created_at: number }): ConfigEvent => ({
      seq: r.seq,
      type: r.type,
      data: JSON.parse(r.data),
      createdAt: r.created_at
    })
    const history = sql<{ seq: number; type: ConfigEventType; data: string; created_at: number }>`
      SELECT * FROM pie_config ORDER BY seq`.pipe(Effect.map((rows) => rows.map(decode)), Effect.orDie)
    return ConfigLog.of({
      append: (type, data) =>
        Effect.gen(function*() {
          const createdAt = Date.now()
          const [row] = yield* sql<{ seq: number }>`INSERT INTO pie_config ${
            sql.insert({ type, data: JSON.stringify(data), created_at: createdAt })
          } RETURNING seq`
          return { seq: row!.seq, type, data, createdAt }
        }).pipe(Effect.orDie),
      history,
      state: Effect.map(history, fold),
      get: (seq) =>
        sql<{ seq: number; type: ConfigEventType; data: string; created_at: number }>`
          SELECT * FROM pie_config WHERE seq = ${seq}`.pipe(Effect.map((rows) => (rows[0] ? decode(rows[0]) : undefined)), Effect.orDie)
    })
  })
}
