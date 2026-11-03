import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Pie, Plugins, Storage } from "../src/index.ts"
import * as Recovery from "../src/core/Recovery.ts"

const sdk = path.join(import.meta.dirname, "..", "src", "index.ts")
const plugin = (id: string, tool: string) => `
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from ${JSON.stringify(sdk)}
export default Plugin.define({ id: ${JSON.stringify(id)}, setup: (ctx) => ctx.tools.transform((t) => {
  t.set(${JSON.stringify(tool)}, defineTool({ name: ${JSON.stringify(tool)}, description: "x", parameters: Schema.Struct({}),
    idempotent: true, execute: () => Effect.succeed({ content: ${JSON.stringify(tool)} }) }))
}) })
`
const cacheDirectory = path.join(import.meta.dirname, ".tmp", "plugin-cache")
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pie-recovery-")), "pie.db")

const withPie = <A, E>(db: string, effect: Effect.Effect<A, E, Plugins>, extra: Partial<Pie.LayerOptions> = {}) =>
  effect.pipe(
    Effect.provide(Pie.layer({ storage: Storage.sqlite(db), pluginCacheDirectory: cacheDirectory, goodAfter: 60_000, ...extra })),
    Effect.scoped
  )

const loadedIds = Plugins.use((p) => Effect.map(p.explain, (e) => e.loaded.map((x) => x.id)))

describe("rollback", () => {
  it.live("rollback restores an earlier composition, and is itself undoable", () =>
    Effect.gen(function*() {
      const db = tmpDb()
      yield* withPie(db, Effect.gen(function*() {
        const plugins = yield* Plugins
        yield* Effect.orDie(plugins.install(plugin("a", "tool_a"))) // #1
        yield* plugins.markGood // #2: good up to #1
        yield* Effect.orDie(plugins.install(plugin("b", "tool_b"))) // #3
        expect(yield* loadedIds).toEqual(expect.arrayContaining(["a", "b"]))

        yield* Effect.orDie(plugins.rollback(1, "b broke something")) // #4
        expect(yield* loadedIds).toContain("a")
        expect(yield* loadedIds).not.toContain("b")

        yield* Effect.orDie(plugins.rollback(3, "actually b was fine")) // #5: undo the rollback
        expect(yield* loadedIds).toEqual(expect.arrayContaining(["a", "b"]))

        yield* Effect.orDie(plugins.rollback(0, "built-ins only"))
        const ids = yield* loadedIds
        expect(ids).not.toContain("a")
        expect(ids).toContain("self") // built-ins stay
      }), { plugins: Pie.builtins.filter((p) => p.id !== "opencode-go") })

      // The same history from the terminal, without loading plugins.
      const explained = yield* Effect.promise(() => Recovery.run(Recovery.explain(db)))
      expect(explained.history.map((h) => h.type)).toEqual([
        "plugin/installed",
        "config/good",
        "plugin/installed",
        "config/reset",
        "config/reset",
        "config/reset"
      ])
      expect(explained.lastGood).toBe(1)
    }))

  it.live("safe mode loads the built-ins only; required plugins must load", () =>
    Effect.gen(function*() {
      const db = tmpDb()
      yield* withPie(db, Effect.gen(function*() {
        const plugins = yield* Plugins
        yield* Effect.orDie(plugins.install(plugin("a", "tool_a")))
        yield* Effect.orDie(plugins.remove("coding-tools")) // the agent disables a built-in
      }))
      const safe = yield* withPie(db, loadedIds, { safe: true })
      expect(safe).toContain("coding-tools")
      expect(safe).not.toContain("a")
      const normal = yield* withPie(db, loadedIds)
      expect(normal).toContain("a")
      expect(normal).not.toContain("coding-tools")

      const exit = yield* Effect.exit(withPie(db, loadedIds, { required: ["coding-tools"] }))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.live("try loads a plugin in this process only; keep makes it permanent; built-ins can be replaced", () =>
    Effect.gen(function*() {
      const db = tmpDb()
      yield* withPie(db, Effect.gen(function*() {
        const plugins = yield* Plugins
        yield* Effect.orDie(plugins.try(plugin("t", "tool_t")))
        expect(yield* loadedIds).toContain("t")
        expect((yield* plugins.explain).trial.map((p) => p.id)).toEqual(["t"])
        expect((yield* plugins.config).installed.has("t")).toBe(false)
      }))
      expect(yield* withPie(db, loadedIds)).not.toContain("t") // gone after a restart

      yield* withPie(db, Effect.gen(function*() {
        const plugins = yield* Plugins
        yield* Effect.orDie(plugins.try(plugin("t", "tool_t")))
        yield* Effect.orDie(plugins.keep("t"))
        // replace a built-in with the agent's own version
        yield* Effect.orDie(plugins.install(plugin("coding-tools", "my_read")))
        const explain = yield* plugins.explain
        expect(explain.loaded.find((p) => p.id === "coding-tools")?.source).toMatch(/^config:/)
      }))
      expect(yield* withPie(db, loadedIds)).toContain("t")
    }))
})

describe("automatic rollback by the supervisor", () => {
  it("a plugin that crashes Pie on every start is rolled back to the last good composition", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-crashy-"))
    const db = path.join(dir, "pie.db")
    const out = path.join(dir, "out.json")
    const support = path.join(import.meta.dirname, "support")
    execFileSync(process.execPath, ["--no-warnings", path.join(support, "supervise.ts"), "--db", db, path.join(support, "crashy-run.ts"), db, dir, out], {
      timeout: 60_000,
      stdio: "pipe"
    })
    const { explain, loaded } = JSON.parse(fs.readFileSync(out, "utf8"))
    expect(loaded).not.toContain("bomb")
    expect(fs.readFileSync(`${out}.starts`, "utf8").trim().split("\n")).toHaveLength(3) // ok+install, crash, after rollback
    const reset = explain.history.find((h: any) => h.type === "config/reset")
    expect(reset.note).toContain("automatic")

    // The terminal sees the same, without loading plugins; and can undo the automatic rollback.
    const cli = path.join(import.meta.dirname, "..", "src", "cli.ts")
    expect(execFileSync(process.execPath, ["--no-warnings", cli, "explain", "--db", db], { encoding: "utf8" })).toContain("config/reset")
    expect(execFileSync(process.execPath, ["--no-warnings", cli, "rollback", "--db", db, "--to", "1"], { encoding: "utf8" })).toContain(
      "rolled back to #1"
    )
  }, 90_000)
})

void Layer
