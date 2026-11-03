/**
 * Session storage: a tree of entries (pi's session model) plus the queue of
 * steer/followUp inputs and the tool start markers. Every write is idempotent
 * (deterministic ids + INSERT OR IGNORE), so activities can be retried after a
 * crash without duplicating anything.
 */
import { Context, Data, Effect, Schema } from "effect"
import type { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"

// ---------------------------------------------------------------------------
// Entry payloads (also used as durable activity results)
// ---------------------------------------------------------------------------

export const ToolCall = Schema.Struct({ id: Schema.String, name: Schema.String, params: Schema.Unknown })
export type ToolCall = typeof ToolCall.Type

export const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number)
})

export const AssistantData = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  toolCalls: Schema.Array(ToolCall),
  finishReason: Schema.String,
  model: Schema.String,
  usage: Usage
})
export type AssistantData = typeof AssistantData.Type

export const ToolResultData = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.String,
  isError: Schema.Boolean,
  details: Schema.optional(Schema.Unknown)
})
export type ToolResultData = typeof ToolResultData.Type

export const RunOutcome = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "aborted", "turn_limit"]),
  message: Schema.optional(Schema.String)
})
export type RunOutcome = typeof RunOutcome.Type

interface EntryBase {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  readonly seq: number
  readonly createdAt: number
}

export type Entry =
  | EntryBase & { readonly kind: "user"; readonly data: { readonly text: string } }
  | EntryBase & { readonly kind: "assistant"; readonly data: AssistantData }
  | EntryBase & { readonly kind: "toolResult"; readonly data: ToolResultData }
  | EntryBase & { readonly kind: "runEnd"; readonly data: RunOutcome & { readonly runId: string } }

export type EntryInput = Pick<Entry, "kind" | "data"> extends infer T ? T : never

export interface SessionInfo {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly leafId: string | null
  readonly activeRun: string | null
  readonly createdAt: number
}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{ readonly sessionId: string }> {}
export class SessionBusy extends Data.TaggedError("SessionBusy")<{
  readonly sessionId: string
  readonly activeRun: string
}> {}

/** Converts the current branch into the messages sent to the model. */
export const toMessages = (entries: ReadonlyArray<Entry>): Array<Prompt.MessageEncoded> => {
  const messages: Array<Prompt.MessageEncoded> = []
  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        messages.push({ role: "user", content: entry.data.text })
        break
      case "assistant": {
        const content: Array<Prompt.AssistantMessagePartEncoded> = []
        if (entry.data.text.length > 0) content.push({ type: "text", text: entry.data.text })
        for (const call of entry.data.toolCalls) {
          content.push({ type: "tool-call", id: call.id, name: call.name, params: call.params })
        }
        if (content.length > 0) messages.push({ role: "assistant", content })
        break
      }
      case "toolResult":
        messages.push({
          role: "tool",
          content: [{
            type: "tool-result",
            id: entry.data.toolCallId,
            name: entry.data.toolName,
            isFailure: entry.data.isError,
            result: entry.data.content
          }]
        })
        break
      case "runEnd":
        break
    }
  }
  return messages
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly leaf_id: string | null
  readonly active_run: string | null
  readonly created_at: number
}

interface EntryRow {
  readonly id: string
  readonly session_id: string
  readonly parent_id: string | null
  readonly seq: number
  readonly kind: Entry["kind"]
  readonly data: string
  readonly created_at: number
}

const toInfo = (row: SessionRow): SessionInfo => ({
  id: row.id,
  cwd: row.cwd,
  model: row.model,
  leafId: row.leaf_id,
  activeRun: row.active_run,
  createdAt: row.created_at
})

const toEntry = (row: EntryRow): Entry =>
  ({
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    seq: row.seq,
    createdAt: row.created_at,
    kind: row.kind,
    data: JSON.parse(row.data)
  }) as Entry

export class SessionStore extends Context.Service<SessionStore, {
  readonly create: (options: { readonly id: string; readonly cwd: string; readonly model: string }) => Effect.Effect<SessionInfo>
  readonly get: (sessionId: string) => Effect.Effect<SessionInfo, SessionNotFound>
  readonly list: Effect.Effect<ReadonlyArray<SessionInfo>>
  readonly listActive: Effect.Effect<ReadonlyArray<SessionInfo>>
  /** Entries of the current branch, root first. */
  readonly branch: (sessionId: string) => Effect.Effect<ReadonlyArray<Entry>>
  /** Appends after the current leaf. Idempotent by id; returns the stored entry. */
  readonly append: (sessionId: string, id: string, entry: EntryInput) => Effect.Effect<Entry>
  /** Atomically claims the session for a run and appends the prompt. */
  readonly beginRun: (sessionId: string, runId: string, text: string) => Effect.Effect<void, SessionBusy | SessionNotFound>
  /** Queues steer/followUp if a run is active; otherwise claims the session (returns "started"). */
  readonly enqueue: (
    sessionId: string,
    input: { readonly id: string; readonly kind: "steer" | "followUp"; readonly text: string; readonly runId: string }
  ) => Effect.Effect<"queued" | "started", SessionNotFound>
  /** Consumes queued inputs of a kind into user entries. Idempotent per key. */
  readonly consume: (sessionId: string, kind: "steer" | "followUp", key: string) => Effect.Effect<number>
  /**
   * End of a turn without tool calls: consumes queued followUps and returns
   * "continue", or releases the session and returns "done". Atomic, so a
   * followUp is never lost between "nothing queued" and "released".
   */
  readonly finishOrContinue: (sessionId: string, runId: string, key: string) => Effect.Effect<"continue" | "done">
  /** Releases the session (if still owned by runId) and records the outcome. Idempotent. */
  readonly endRun: (sessionId: string, runId: string, outcome: RunOutcome) => Effect.Effect<void>
  /** Marks a tool call as started. Returns false if it had already been started (crash mid-execution). */
  readonly markToolStarted: (key: string) => Effect.Effect<boolean>
  /** Durable abort request for a run; survives restarts. */
  readonly requestAbort: (runId: string) => Effect.Effect<void>
  readonly isAborted: (runId: string) => Effect.Effect<boolean>
  readonly queued: (sessionId: string) => Effect.Effect<{ readonly steer: number; readonly followUp: number }>
}>()("pie/SessionStore") {
  static readonly make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* sql`CREATE TABLE IF NOT EXISTS pie_sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT NOT NULL,
      leaf_id TEXT, active_run TEXT, created_at INTEGER NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS pie_entries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL,
      kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`
    yield* sql`CREATE INDEX IF NOT EXISTS pie_entries_session ON pie_entries (session_id, seq)`
    yield* sql`CREATE TABLE IF NOT EXISTS pie_inputs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      consumed_by TEXT, created_at INTEGER NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS pie_tool_attempts (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL)`
    yield* sql`CREATE TABLE IF NOT EXISTS pie_aborts (run_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL)`
  }).pipe(Effect.orDie, Effect.andThen(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const now = () => Date.now()

    const get = (sessionId: string) =>
      sql<SessionRow>`SELECT * FROM pie_sessions WHERE id = ${sessionId}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => rows[0] ? Effect.succeed(toInfo(rows[0])) : Effect.fail(new SessionNotFound({ sessionId })))
      )

    const appendUnsafe = (sessionId: string, id: string, entry: EntryInput) =>
      Effect.gen(function*() {
        const existing = yield* sql<EntryRow>`SELECT * FROM pie_entries WHERE id = ${id}`
        if (existing[0]) return toEntry(existing[0])
        const [session] = yield* sql<SessionRow>`SELECT * FROM pie_sessions WHERE id = ${sessionId}`
        const [{ next }] = (yield* sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM pie_entries WHERE session_id = ${sessionId}`) as [{ next: number }]
        const row: EntryRow = {
          id,
          session_id: sessionId,
          parent_id: session?.leaf_id ?? null,
          seq: next,
          kind: entry.kind,
          data: JSON.stringify(entry.data),
          created_at: now()
        }
        yield* sql`INSERT INTO pie_entries ${sql.insert({ ...row })}`
        yield* sql`UPDATE pie_sessions SET leaf_id = ${id} WHERE id = ${sessionId}`
        return toEntry(row)
      })

    const append = (sessionId: string, id: string, entry: EntryInput) =>
      sql.withTransaction(appendUnsafe(sessionId, id, entry)).pipe(Effect.orDie)

    const consumeUnsafe = (sessionId: string, kind: "steer" | "followUp", key: string) =>
      Effect.gen(function*() {
        yield* sql`UPDATE pie_inputs SET consumed_by = ${key}
          WHERE session_id = ${sessionId} AND kind = ${kind} AND consumed_by IS NULL`
        const rows = yield* sql<{ id: string; text: string }>`
          SELECT id, text FROM pie_inputs WHERE consumed_by = ${key} ORDER BY created_at, id`
        for (const row of rows) yield* appendUnsafe(sessionId, `input/${row.id}`, { kind: "user", data: { text: row.text } })
        return rows.length
      })

    const branch = (sessionId: string) =>
      Effect.gen(function*() {
        const session = yield* Effect.orDie(get(sessionId))
        const rows = yield* Effect.orDie(sql<EntryRow>`SELECT * FROM pie_entries WHERE session_id = ${sessionId}`)
        const byId = new Map(rows.map((row) => [row.id, row]))
        const path: Array<Entry> = []
        let cursor = session.leafId
        while (cursor !== null) {
          const row = byId.get(cursor)
          if (!row) break
          path.push(toEntry(row))
          cursor = row.parent_id
        }
        return path.reverse()
      })

    return SessionStore.of({
      create: ({ id, cwd, model }) =>
        Effect.gen(function*() {
          yield* sql`INSERT OR IGNORE INTO pie_sessions ${
            sql.insert({ id, cwd, model, leaf_id: null, active_run: null, created_at: now() })
          }`
          return yield* get(id)
        }).pipe(Effect.orDie),
      get,
      list: sql<SessionRow>`SELECT * FROM pie_sessions ORDER BY created_at`.pipe(Effect.map((r) => r.map(toInfo)), Effect.orDie),
      listActive: sql<SessionRow>`SELECT * FROM pie_sessions WHERE active_run IS NOT NULL`.pipe(
        Effect.map((r) => r.map(toInfo)),
        Effect.orDie
      ),
      branch,
      append,
      beginRun: (sessionId, runId, text) =>
        sql.withTransaction(Effect.gen(function*() {
          const session = yield* get(sessionId)
          if (session.activeRun === runId) return
          if (session.activeRun !== null) {
            return yield* new SessionBusy({ sessionId, activeRun: session.activeRun })
          }
          yield* sql`UPDATE pie_sessions SET active_run = ${runId} WHERE id = ${sessionId}`
          yield* appendUnsafe(sessionId, `${runId}/prompt`, { kind: "user", data: { text } })
        })).pipe(Effect.catchTag("SqlError", Effect.die)),
      enqueue: (sessionId, input) =>
        sql.withTransaction(Effect.gen(function*() {
          const session = yield* get(sessionId)
          if (session.activeRun === null) {
            yield* sql`UPDATE pie_sessions SET active_run = ${input.runId} WHERE id = ${sessionId}`
            yield* appendUnsafe(sessionId, `${input.runId}/prompt`, { kind: "user", data: { text: input.text } })
            return "started" as const
          }
          yield* sql`INSERT OR IGNORE INTO pie_inputs ${
            sql.insert({ id: input.id, session_id: sessionId, kind: input.kind, text: input.text, consumed_by: null, created_at: now() })
          }`
          return "queued" as const
        })).pipe(Effect.catchTag("SqlError", Effect.die)),
      consume: (sessionId, kind, key) => sql.withTransaction(consumeUnsafe(sessionId, kind, key)).pipe(Effect.orDie),
      finishOrContinue: (sessionId, runId, key) =>
        sql.withTransaction(Effect.gen(function*() {
          const consumed = yield* consumeUnsafe(sessionId, "followUp", key)
          if (consumed > 0) return "continue" as const
          yield* sql`UPDATE pie_sessions SET active_run = NULL WHERE id = ${sessionId} AND active_run = ${runId}`
          return "done" as const
        })).pipe(Effect.orDie),
      endRun: (sessionId, runId, outcome) =>
        sql.withTransaction(Effect.gen(function*() {
          yield* appendUnsafe(sessionId, `${runId}/end`, { kind: "runEnd", data: { ...outcome, runId } })
          yield* sql`UPDATE pie_sessions SET active_run = NULL WHERE id = ${sessionId} AND active_run = ${runId}`
        })).pipe(Effect.orDie),
      markToolStarted: (key) =>
        sql`INSERT OR IGNORE INTO pie_tool_attempts ${sql.insert({ key, started_at: now() })} RETURNING key`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        ),
      requestAbort: (runId) =>
        sql`INSERT OR IGNORE INTO pie_aborts ${sql.insert({ run_id: runId, requested_at: now() })}`.pipe(
          Effect.asVoid,
          Effect.orDie
        ),
      isAborted: (runId) =>
        sql`SELECT run_id FROM pie_aborts WHERE run_id = ${runId}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie
        ),
      queued: (sessionId) =>
        sql<{ kind: string; n: number }>`SELECT kind, COUNT(*) AS n FROM pie_inputs
          WHERE session_id = ${sessionId} AND consumed_by IS NULL GROUP BY kind`.pipe(
          Effect.map((rows) => ({
            steer: rows.find((r) => r.kind === "steer")?.n ?? 0,
            followUp: rows.find((r) => r.kind === "followUp")?.n ?? 0
          })),
          Effect.orDie
        )
    })
  })))
}
