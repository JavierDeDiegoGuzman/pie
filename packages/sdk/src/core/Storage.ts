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
 *   Files attached to messages go to an `attachments/` folder next to the
 *   database, one file per content hash; the database keeps the reference.
 * - memory: nothing survives the process (tests, ephemeral agents).
 *
 * Postgres/MySQL: the SQL used is portable except `INSERT OR IGNORE`; adding a
 * client layer and dialect switches is the remaining work.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

/**
 * Where the bytes of attached files live. The database keeps, per file, its
 * hash and the name `write` returned; this keeps the bytes under that name.
 */
export class Attachments extends Context.Service<Attachments, {
  /** Stores the bytes of the file with this content hash (once) and returns its name, relative to the store. */
  readonly write: (hash: string, data: Uint8Array) => Effect.Effect<string>
  readonly read: (name: string) => Effect.Effect<Uint8Array | undefined>
}>()("pie/Attachments") {}

/** Files in a folder, one per content hash, written atomically (a temporary file, then a rename). */
export const attachmentsFolder = (dir: string) =>
  Attachments.of({
    write: (hash, data) =>
      Effect.promise(async () => {
        const name = hash
        const file = path.join(dir, name)
        try {
          await fs.access(file)
        } catch {
          await fs.mkdir(dir, { recursive: true })
          const temp = `${file}.${process.pid}.tmp`
          await fs.writeFile(temp, data)
          await fs.rename(temp, file)
        }
        return name
      }),
    read: (name) => Effect.promise(() => fs.readFile(path.join(dir, name)).then((b) => new Uint8Array(b), () => undefined))
  })

const attachmentsInMemory = () => {
  const files = new Map<string, Uint8Array>()
  return Attachments.of({
    write: (hash, data) => Effect.sync(() => (files.set(hash, data), hash)),
    read: (name) => Effect.sync(() => files.get(name))
  })
}

export type Storage = Layer.Layer<SqlClient.SqlClient | Attachments>

/** Another process holds the database. */
export class StorageLocked extends Data.TaggedError("StorageLocked")<{ readonly filename: string; readonly message: string }> {}

const lockedMessage = (filename: string) =>
  `${filename} is in use by another process (Pie opens its database exclusively: one process per database). ` +
  `Stop the other process, or give this one another database.`

export const sqlite = (filename: string): Storage =>
  Layer.merge(sqliteDatabase(filename), Layer.succeed(Attachments, attachmentsFolder(path.join(path.dirname(path.resolve(filename)), "attachments"))))

const sqliteDatabase = (filename: string) =>
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

export const memory: Storage = Layer.merge(
  Layer.orDie(SqliteClient.layer({ filename: ":memory:" })),
  Layer.sync(Attachments, attachmentsInMemory)
)
