import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const script = path.join(import.meta.dirname, "support", "self-modify-run.ts")

describe("self-modification (real Node process, plugin dir outside the repo)", () => {
  it("a broken plugin is rejected, a valid one loads, and its tool is used in the same run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-self-"))
    const pluginDir = path.join(dir, "plugins")
    const output = execFileSync(process.execPath, ["--no-warnings", script, pluginDir, dir], { encoding: "utf8", timeout: 40_000 })
    const { offered, outcome, results } = JSON.parse(output.trim().split("\n").pop()!)

    expect(outcome).toEqual({ status: "completed" })
    expect(results.map((r: any) => [r.toolName, r.isError])).toEqual([
      ["plugin_write", true],
      ["plugin_write", false],
      ["word_count", false]
    ])
    expect(results[0].content).toContain("Plugin failed to load")
    expect(results[2].content).toBe("3")
    expect(offered[0]).not.toContain("word_count")
    expect(offered[2]).toContain("word_count")
    expect(offered[0]).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "grep", "find", "ls", "plugin_write"]))
    expect(fs.existsSync(path.join(pluginDir, "word-count.ts"))).toBe(true)
  }, 60_000)
})
