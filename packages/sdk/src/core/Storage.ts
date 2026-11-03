/**
 * Persistence backends. Everything (session logs, configuration log, plugin
 * cursors, workflow journal, process lock) lives in one SQL database.
 *
 * - sqlite(file): durable; one runtime per file (enforced by a lock).
 * - memory: nothing survives the process (tests, ephemeral agents).
 *
 * Postgres/MySQL: the SQL used is portable except `INSERT OR IGNORE`; adding a
 * client layer and dialect switches is the remaining work.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer } from "effect"
import type { SqlClient } from "effect/sql"

export type Storage = Layer.Layer<SqlClient.SqlClient>

export const sqlite = (filename: string): Storage => Layer.orDie(SqliteClient.layer({ filename }))

export const memory: Storage = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))
