/**
 * Persistence backends. Everything (session logs, plugin cursors, workflow
 * journal) lives in one SQL database.
 *
 * - sqlite(file): durable, and exclusive. The file is opened with SQLite's
 *   exclusive locking mode and locked at once, so for as long as this process
 *   lives no other process can open it (not even to read): a second Pie on
 *   the same file fails at startup with StorageLocked. The operating system
 *   releases the lock when the process ends, however it ends, so a restart
 *   gets it back at once.
 * - memory: nothing survives the process (tests, ephemeral agents).
 *
 * Postgres/MySQL: the SQL used is portable except `INSERT OR IGNORE`; adding a
 * client layer and dialect switches is the remaining work.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

export type Storage = Layer.Layer<SqlClient.SqlClient>

/** Another process holds the database. */
export class StorageLocked extends Data.TaggedError("StorageLocked")<{ readonly filename: string; readonly message: string }> {}

const lockedMessage = (filename: string) =>
  `${filename} is in use by another process (Pie opens its database exclusively: one process per database). ` +
  `Stop the other process, or give this one another database.`

export const sqlite = (filename: string): Storage =>
  Layer.effectContext(
    Effect.gen(function*() {
      const context = yield* Layer.build(SqliteClient.layer({ filename, busyTimeout: 1000 }))
      const client = Context.get(context, SqlClient.SqlClient)
      // Exclusive mode keeps every lock it takes until the connection closes; a write takes the lock now.
      yield* client`PRAGMA locking_mode = EXCLUSIVE`
      yield* client`CREATE TABLE IF NOT EXISTS pie_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
      yield* client`INSERT INTO pie_meta (key, value) VALUES ('opened_by', ${String(process.pid)})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      return context
    }).pipe(
      Effect.catchCause((cause) =>
        /locked|busy/i.test(String(cause))
          ? Effect.die(new StorageLocked({ filename, message: lockedMessage(filename) }))
          : Effect.failCause(cause)
      ),
      Effect.orDie
    )
  )

export const memory: Storage = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))
