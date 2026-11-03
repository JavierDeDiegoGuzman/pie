/**
 * The configuration log: which plugins the agent installed (with their full
 * source), removed, disabled or re-enabled. The active composition is a fold
 * of this log over the built-in plugins, so every self-modification is
 * recorded, and going back to any version is appending its source again.
 */
import { createHash } from "node:crypto"
import { Context, Effect } from "effect"
import { SqlClient } from "effect/sql"

export interface ConfigEvents {
  readonly "plugin/installed": { readonly id: string; readonly source: string; readonly hash: string }
  readonly "plugin/removed": { readonly id: string }
  readonly "plugin/disabled": { readonly id: string }
  readonly "plugin/enabled": { readonly id: string }
}

export type ConfigEventType = keyof ConfigEvents

export interface ConfigEvent<K extends ConfigEventType = ConfigEventType> {
  readonly seq: number
  readonly type: K
  readonly data: ConfigEvents[K]
  readonly createdAt: number
}

export interface ConfigState {
  /** Agent-installed plugins: current version of each. */
  readonly installed: ReadonlyMap<string, ConfigEvents["plugin/installed"] & { readonly seq: number }>
  /** Built-in or directory plugins switched off. */
  readonly disabled: ReadonlySet<string>
}

export const fold = (events: ReadonlyArray<ConfigEvent>): ConfigState => {
  const installed = new Map<string, ConfigEvents["plugin/installed"] & { readonly seq: number }>()
  const disabled = new Set<string>()
  for (const event of events) {
    switch (event.type) {
      case "plugin/installed": {
        const data = event.data as ConfigEvents["plugin/installed"]
        installed.set(data.id, { ...data, seq: event.seq })
        disabled.delete(data.id)
        break
      }
      case "plugin/removed":
        installed.delete((event.data as ConfigEvents["plugin/removed"]).id)
        break
      case "plugin/disabled":
        disabled.add((event.data as ConfigEvents["plugin/disabled"]).id)
        break
      case "plugin/enabled":
        disabled.delete((event.data as ConfigEvents["plugin/enabled"]).id)
        break
    }
  }
  return { installed, disabled }
}

export const hashSource = (source: string) => createHash("sha256").update(source).digest("hex").slice(0, 16)

export class ConfigLog extends Context.Service<ConfigLog, {
  readonly append: <K extends ConfigEventType>(type: K, data: ConfigEvents[K]) => Effect.Effect<ConfigEvent<K>>
  readonly history: Effect.Effect<ReadonlyArray<ConfigEvent>>
  readonly state: Effect.Effect<ConfigState>
}>()("pie/ConfigLog") {
  static readonly make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.orDie(sql`CREATE TABLE IF NOT EXISTS pie_config (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    const history = sql<{ seq: number; type: ConfigEventType; data: string; created_at: number }>`
      SELECT * FROM pie_config ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }))),
      Effect.orDie
    )
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
      state: Effect.map(history, fold)
    })
  })
}
