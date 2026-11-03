/**
 * Persistence backends. Each provides the SQL client used by the SessionStore
 * and the WorkflowEngine, and they always share one database: the guarantees
 * of the loop depend on session writes and engine state living together.
 *
 * - sqlite(file): durable, single process per file (local / CLI).
 * - memory: nothing survives the process (tests, ephemeral agents).
 *
 * Postgres/MySQL use the same engine (`SqlMessageStorage` supports them) and
 * are a matter of swapping the SQL client layer; not wired yet.
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster"
import { Digest } from "effect/crypto"
import { WorkflowEngine } from "effect/workflow"

export const sqlite = (filename: string) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" })),
    Layer.provide(Digest.layerWebCrypto),
    Layer.provideMerge(SqliteClient.layer({ filename })),
    Layer.orDie
  )

export const memory = Layer.merge(WorkflowEngine.layerMemory, SqliteClient.layer({ filename: ":memory:" })).pipe(
  Layer.orDie
)
