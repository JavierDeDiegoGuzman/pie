import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { tools } from "../src/plugins/coding-tools.ts"
import { collect } from "../src/plugins/context-files.ts"

const tool = (name: string) => tools.find((t) => t.name === name)!
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pie-tools-"))
const call = (name: string, params: unknown, cwd: string) =>
  tool(name).execute(params as never, { sessionId: "s", toolCallId: "t", cwd })

describe("coding tools", () => {
  it.live("read honours offset/limit and tells how to continue", () =>
    Effect.gen(function*() {
      const cwd = tmp()
      fs.writeFileSync(path.join(cwd, "a.txt"), ["one", "two", "three", "four"].join("\n"))
      expect((yield* call("read", { path: "a.txt" }, cwd)).content).toBe("one\ntwo\nthree\nfour")
      const part = yield* call("read", { path: "a.txt", offset: 2, limit: 2 }, cwd)
      expect(part.content).toBe("two\nthree\n\n[1 more lines; continue with offset=4]")
      expect((yield* call("read", { path: "missing.txt" }, cwd)).isError).toBe(true)
    }))

  it.live("write creates parent directories", () =>
    Effect.gen(function*() {
      const cwd = tmp()
      yield* call("write", { path: "deep/dir/f.ts", content: "x" }, cwd)
      expect(fs.readFileSync(path.join(cwd, "deep/dir/f.ts"), "utf8")).toBe("x")
    }))

  it.live("edit applies unique replacements, rejects ambiguous ones, and converges when re-run", () =>
    Effect.gen(function*() {
      const cwd = tmp()
      const file = path.join(cwd, "f.ts")
      fs.writeFileSync(file, "const a = 1\nconst b = 2\nconst c = 1\n")
      const edits = { path: "f.ts", edits: [{ oldText: "const b = 2", newText: "const b = 3" }] }
      expect((yield* call("edit", edits, cwd)).isError ?? false).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("const a = 1\nconst b = 3\nconst c = 1\n")
      // Same call again (e.g. replay after a crash): already applied, not an error.
      const again = yield* call("edit", edits, cwd)
      expect(again.isError ?? false).toBe(false)
      expect(again.content).toContain("1 already applied")
      const ambiguous = yield* call("edit", { path: "f.ts", edits: [{ oldText: "= 1", newText: "= 9" }] }, cwd)
      expect(ambiguous.isError).toBe(true)
      expect(ambiguous.content).toContain("matches 2 places")
      const missing = yield* call("edit", { path: "f.ts", edits: [{ oldText: "nope", newText: "x" }] }, cwd)
      expect(missing.content).toContain("not found")
    }))

  it.live("bash returns output and exit code, honours timeouts, and is killed when interrupted", () =>
    Effect.gen(function*() {
      const cwd = tmp()
      const ok = yield* call("bash", { command: "echo hi && pwd" }, cwd)
      expect(ok.content).toBe(`hi\n${fs.realpathSync(cwd)}`)
      const failed = yield* call("bash", { command: "echo oops >&2; exit 3" }, cwd)
      expect(failed).toMatchObject({ isError: true })
      expect(failed.content).toBe("oops\n[exit code 3]")
      const slow = yield* call("bash", { command: "sleep 5", timeout: 0.2 }, cwd)
      expect(slow.content).toContain("timed out")

      const marker = path.join(cwd, "survived")
      const fiber = yield* Effect.forkChild(call("bash", { command: `sleep 1 && touch ${marker}` }, cwd))
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(fiber)
      yield* Effect.sleep("1500 millis")
      expect(fs.existsSync(marker)).toBe(false)
    }))

  it.live("grep, find and ls", () =>
    Effect.gen(function*() {
      const cwd = tmp()
      fs.mkdirSync(path.join(cwd, "src"))
      fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const needle = 1\n")
      fs.writeFileSync(path.join(cwd, "src/b.md"), "no match here\n")
      fs.writeFileSync(path.join(cwd, ".hidden"), "needle\n")
      expect((yield* call("grep", { pattern: "needle", glob: "*.ts" }, cwd)).content).toBe("./src/a.ts:1:export const needle = 1")
      expect((yield* call("grep", { pattern: "zzz" }, cwd)).content).toBe("No matches found")
      expect((yield* call("find", { pattern: "**/*.ts" }, cwd)).content).toBe("src/a.ts")
      expect((yield* call("ls", {}, cwd)).content).toBe(".hidden\nsrc/")
    }))
})

describe("context files", () => {
  it.live("collects global then root-to-cwd AGENTS.md, preferring AGENTS.md over CLAUDE.md", () =>
    Effect.gen(function*() {
      const home = tmp()
      const repo = tmp()
      fs.mkdirSync(path.join(home, ".pie"))
      fs.writeFileSync(path.join(home, ".pie/AGENTS.md"), "global")
      fs.mkdirSync(path.join(repo, "pkg"))
      fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo")
      fs.writeFileSync(path.join(repo, "pkg/CLAUDE.md"), "pkg")
      const found = yield* collect(path.join(repo, "pkg"), home)
      expect(found.map((f) => f.text)).toEqual(["global", "repo", "pkg"])
    }))
})
