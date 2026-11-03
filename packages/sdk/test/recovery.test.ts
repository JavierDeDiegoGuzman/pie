import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Pie, Plugins } from "../src/index.ts"
import * as Recovery from "../src/core/Recovery.ts"
import { testHome } from "./support/home.ts"

const plugin = (id: string, tool: string) => `import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "@pie/sdk"
export default Plugin.define({ id: ${JSON.stringify(id)}, setup: (ctx) => ctx.tools.transform((t) => {
  t.set(${JSON.stringify(tool)}, defineTool({ name: ${JSON.stringify(tool)}, description: "x", parameters: Schema.Struct({}),
    idempotent: true, execute: () => Effect.succeed({ content: ${JSON.stringify(tool)} }) }))
}) })
`
const addPlugin = (home: string, id: string, tool = `tool_${id}`) => {
  fs.mkdirSync(path.join(home, "plugins", id), { recursive: true })
  fs.writeFileSync(path.join(home, "plugins", id, "index.ts"), plugin(id, tool))
}

const withPie = <A, E>(home: string, effect: Effect.Effect<A, E, Plugins>, extra: Partial<Pie.LayerOptions> = {}) =>
  effect.pipe(Effect.provide(Pie.layer({ home, seed: ["coding-tools", "self"], goodAfter: 60_000, ...extra })), Effect.scoped)

const loadedIds = Plugins.use((p) => Effect.map(p.explain, (e) => e.plugins.map((x) => x.id)))

describe("rollback", () => {
  it.live("rollback restores an earlier plugins folder, and is itself undoable", () =>
    Effect.gen(function*() {
      const home = testHome("rollback")
      yield* withPie(home, Effect.gen(function*() {
        const plugins = yield* Plugins // #1: seeded from the templates
        addPlugin(home, "a")
        yield* Effect.orDie(plugins.restart("add a")) // #2
        yield* plugins.markGood // #3: good up to #2
        addPlugin(home, "b")
        yield* Effect.orDie(plugins.restart("add b")) // #4
        expect(yield* loadedIds).toEqual(expect.arrayContaining(["a", "b"]))

        yield* Effect.orDie(plugins.rollback(2, "b broke something")) // #5
        expect(yield* loadedIds).toContain("a")
        expect(yield* loadedIds).not.toContain("b")
        expect(fs.existsSync(path.join(home, "plugins", "b"))).toBe(false)

        yield* Effect.orDie(plugins.rollback(4, "actually b was fine")) // #6: undo the rollback
        expect(yield* loadedIds).toEqual(expect.arrayContaining(["a", "b"]))
      }))

      // The same history from the terminal, without loading plugins.
      const explained = yield* Effect.promise(() => Recovery.run(Recovery.explain(home)))
      expect(explained.history.map((h) => h.type)).toEqual([
        "plugins/snapshot",
        "plugins/snapshot",
        "config/good",
        "plugins/snapshot",
        "plugins/snapshot",
        "plugins/snapshot"
      ])
      expect(explained.lastGood).toBe(2)
    }))

  it.live("edits made while Pie was down are recorded at startup; safe mode loads the templates; required plugins must load", () =>
    Effect.gen(function*() {
      const home = testHome("safe")
      yield* withPie(home, Effect.void)
      // While Pie is down: add a plugin and disable a built-in.
      addPlugin(home, "a")
      const manifest = path.join(home, "plugins", "plugins.json")
      fs.writeFileSync(manifest, JSON.stringify({ order: ["coding-tools", "self"], disabled: ["coding-tools"] }))

      const normal = yield* withPie(home, loadedIds)
      expect(normal).toContain("a")
      expect(normal).not.toContain("coding-tools")
      const history = yield* Effect.promise(() => Recovery.run(Recovery.explain(home)))
      expect(history.history.at(-1)?.note).toContain("changes found at startup")

      const safe = yield* withPie(home, loadedIds, { safe: true })
      expect(safe).toContain("coding-tools")
      expect(safe).not.toContain("a")

      const exit = yield* Effect.exit(withPie(home, loadedIds, { required: ["coding-tools"] }))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("automatic rollback by the supervisor", () => {
  it("a plugin that crashes Pie on every start is rolled back to the last good snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-crashy-"))
    const home = path.join(dir, ".pie")
    const out = path.join(dir, "out.json")
    const support = path.join(import.meta.dirname, "support")
    execFileSync(process.execPath, ["--no-warnings", path.join(support, "supervise.ts"), "--home", home, path.join(support, "crashy-run.ts"), home, out], {
      timeout: 60_000,
      stdio: "pipe"
    })
    const { explain, loaded } = JSON.parse(fs.readFileSync(out, "utf8"))
    expect(loaded).not.toContain("bomb")
    expect(fs.existsSync(path.join(home, "plugins", "bomb"))).toBe(false)
    expect(fs.readFileSync(`${out}.starts`, "utf8").trim().split("\n")).toHaveLength(3) // ok+edit, crash, after rollback
    expect(explain.history.some((h: any) => h.note.includes("automatic"))).toBe(true)

    // The terminal sees the same, without loading plugins; and can undo the automatic rollback.
    const cli = path.join(import.meta.dirname, "..", "src", "cli.ts")
    expect(execFileSync(process.execPath, ["--no-warnings", cli, "explain", "--home", home], { encoding: "utf8" })).toContain("automatic")
    const bombSnapshot = explain.history.find((h: any) => h.note.startsWith("bomb")).seq
    expect(execFileSync(process.execPath, ["--no-warnings", cli, "rollback", "--home", home, "--to", String(bombSnapshot)], { encoding: "utf8" }))
      .toContain(`rolled back to #${bombSnapshot}`)
    expect(fs.existsSync(path.join(home, "plugins", "bomb", "index.ts"))).toBe(true)
  }, 90_000)
})
