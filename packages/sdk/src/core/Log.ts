/**
 * The session log: the single source of truth. Each session is a tree of
 * events (pi's session model); the current branch is the path from the root
 * to the session's leaf. Everything else (agent state, plugin state, what the
 * model sees) is a fold over a branch.
 *
 * Appends are idempotent by event id: re-running a step after a crash with the
 * same deterministic ids never duplicates anything.
 */
import { Context, Data, Effect } from "effect"
import { SqlClient } from "effect/sql"

export interface LogEvent<Type extends string = string, Data = unknown> {
  readonly id: string
  readonly sessionId: string
  readonly parentId: string | null
  /** Monotonic per session, across branches. */
  readonly seq: number
  readonly type: Type
  readonly data: Data
  readonly createdAt: number
}

export interface SessionInfo {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly leafId: string | null
  readonly createdAt: number
}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{ readonly sessionId: string }> {}
export class EventNotFound extends Data.TaggedError("EventNotFound")<{ readonly eventId: string }> {}

interface SessionRow {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly leaf_id: string | null
  readonly created_at: number
}

interface EventRow {
  readonly id: string
  readonly session_id: string
  readonly parent_id: string | null
  readonly seq: number
  readonly type: string
  readonly data: string
  readonly created_at: number
}

const toInfo = (row: SessionRow): SessionInfo => ({
  id: row.id,
  cwd: row.cwd,
  model: row.model,
  leafId: row.leaf_id,
  createdAt: row.created_at
})

const toEvent = (row: EventRow): LogEvent => ({
  id: row.id,
  sessionId: row.session_id,
  parentId: row.parent_id,
  seq: row.seq,
  type: row.type,
  data: JSON.parse(row.data),
  createdAt: row.created_at
})

export interface NewEvent {
  readonly id: string
  readonly type: string
  readonly data: unknown
}

export class EventLog extends Context.Service<EventLog, {
  readonly createSession: (options: { readonly id: string; readonly cwd: string; readonly model: string }) => Effect.Effect<SessionInfo>
  readonly getSession: (sessionId: string) => Effect.Effect<SessionInfo, SessionNotFound>
  readonly listSessions: Effect.Effect<ReadonlyArray<SessionInfo>>
  /** Appends after the current leaf (or returns the existing event with that id). */
  readonly append: (sessionId: string, event: NewEvent) => Effect.Effect<{ readonly event: LogEvent; readonly inserted: boolean }>
  /** Root-first path to `leafId` (default: the session's current leaf). */
  readonly branch: (sessionId: string, leafId?: string | null) => Effect.Effect<ReadonlyArray<LogEvent>>
  /** Every event of the session, in seq order (all branches). */
  readonly all: (sessionId: string) => Effect.Effect<ReadonlyArray<LogEvent>>
  readonly get: (eventId: string) => Effect.Effect<LogEvent, EventNotFound>
  /** Moves the session's leaf: new events then branch from there. */
  readonly setLeaf: (sessionId: string, eventId: string | null) => Effect.Effect<void>
}>()("pie/EventLog") {
  static readonly make = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    yield* Effect.orDie(Effect.gen(function*() {
      yield* sql`CREATE TABLE IF NOT EXISTS pie_sessions (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT NOT NULL,
        leaf_id TEXT, created_at INTEGER NOT NULL)`
      yield* sql`CREATE TABLE IF NOT EXISTS pie_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`
      yield* sql`CREATE INDEX IF NOT EXISTS pie_events_session ON pie_events (session_id, seq)`
    }))

    const getSession = (sessionId: string) =>
      sql<SessionRow>`SELECT * FROM pie_sessions WHERE id = ${sessionId}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => rows[0] ? Effect.succeed(toInfo(rows[0])) : Effect.fail(new SessionNotFound({ sessionId })))
      )

    const append = (sessionId: string, event: NewEvent) =>
      sql.withTransaction(Effect.gen(function*() {
        const existing = yield* sql<EventRow>`SELECT * FROM pie_events WHERE id = ${event.id}`
        if (existing[0]) return { event: toEvent(existing[0]), inserted: false }
        const [session] = yield* sql<SessionRow>`SELECT * FROM pie_sessions WHERE id = ${sessionId}`
        const [{ next }] = (yield* sql<{ next: number }>`
          SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM pie_events WHERE session_id = ${sessionId}`) as [{ next: number }]
        const row: EventRow = {
          id: event.id,
          session_id: sessionId,
          parent_id: session?.leaf_id ?? null,
          seq: next,
          type: event.type,
          data: JSON.stringify(event.data ?? null),
          created_at: Date.now()
        }
        yield* sql`INSERT INTO pie_events ${sql.insert({ ...row })}`
        yield* sql`UPDATE pie_sessions SET leaf_id = ${event.id} WHERE id = ${sessionId}`
        return { event: toEvent(row), inserted: true }
      })).pipe(Effect.orDie)

    const all = (sessionId: string) =>
      sql<EventRow>`SELECT * FROM pie_events WHERE session_id = ${sessionId} ORDER BY seq`.pipe(
        Effect.map((rows) => rows.map(toEvent)),
        Effect.orDie
      )

    const branch = (sessionId: string, leafId?: string | null) =>
      Effect.gen(function*() {
        const leaf = leafId === undefined ? (yield* Effect.orDie(getSession(sessionId))).leafId : leafId
        const events = yield* all(sessionId)
        const byId = new Map(events.map((e) => [e.id, e]))
        const path: Array<LogEvent> = []
        for (let cursor = leaf; cursor !== null;) {
          const event = byId.get(cursor)
          if (!event) break
          path.push(event)
          cursor = event.parentId
        }
        return path.reverse()
      })

    return EventLog.of({
      createSession: ({ cwd, id, model }) =>
        Effect.gen(function*() {
          yield* sql`INSERT OR IGNORE INTO pie_sessions ${sql.insert({ id, cwd, model, leaf_id: null, created_at: Date.now() })}`
          return yield* getSession(id)
        }).pipe(Effect.orDie),
      getSession,
      listSessions: sql<SessionRow>`SELECT * FROM pie_sessions ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(toInfo)),
        Effect.orDie
      ),
      append,
      branch,
      all,
      get: (eventId) =>
        sql<EventRow>`SELECT * FROM pie_events WHERE id = ${eventId}`.pipe(
          Effect.orDie,
          Effect.flatMap((rows) => rows[0] ? Effect.succeed(toEvent(rows[0])) : Effect.fail(new EventNotFound({ eventId })))
        ),
      setLeaf: (sessionId, eventId) => Effect.asVoid(Effect.orDie(sql`UPDATE pie_sessions SET leaf_id = ${eventId} WHERE id = ${sessionId}`))
    })
  })
}
