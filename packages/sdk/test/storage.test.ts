import { describe, expect, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { Storage } from "../src/index.ts"
import { testHome } from "./support/home.ts"

const open = (db: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* Effect.orDie(sql`SELECT value FROM pie_meta WHERE key = 'opened_by'`)
  }).pipe(Effect.provide(Layer.fresh(Storage.sqlite(db))), Effect.scoped)

const holder = (db: string) =>
  new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", path.join(import.meta.dirname, "support", "hold-db.ts"), db], {
      stdio: ["ignore", "pipe", "inherit"]
    })
    child.stdout!.on("data", (d) => String(d).includes("ready") && resolve(child))
    child.on("exit", (code) => reject(new Error(`holder exited with ${code}`)))
  })

describe("one process per database", () => {
  it.live("a second process fails at once while the first holds the file; after a kill -9 it opens again", () =>
    Effect.gen(function*() {
      const db = path.join(testHome("exclusive"), "pie.db")
      const child = yield* Effect.promise(() => holder(db))
      try {
        const started = Date.now()
        const exit = yield* Effect.exit(open(db))
        expect(Date.now() - started).toBeLessThan(5000)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(exit)).toContain("in use by another process")
      } finally {
        child.kill("SIGKILL")
        yield* Effect.promise(() => new Promise((r) => child.once("exit", r)))
      }
      // The operating system released the lock with the process.
      const rows = yield* open(db)
      expect(rows).toEqual([{ value: String(process.pid) }])
      expect(fs.existsSync(db)).toBe(true)
    }), 30_000)
})
