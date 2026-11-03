import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const support = path.join(import.meta.dirname, "support")

describe("self-modification in a real Node process, home outside the repo", () => {
  it("edits apply before the next step of the same run, with no restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-self-"))
    const out = path.join(dir, "out.json")
    execFileSync(process.execPath, ["--no-warnings", path.join(support, "self-modify-run.ts"), path.join(dir, ".pie"), out], {
      timeout: 40_000
    })
    const { events, outcome } = JSON.parse(fs.readFileSync(out, "utf8"))
    expect(outcome).toMatchObject({ status: "completed" })
    const results = events.filter((e: any) => e.type === "tool/finished").map((e: any) => e.data)
    expect(results.map((r: any) => [r.name, r.isError])).toEqual([["write", false], ["write", false], ["word_count", false]])
    expect(results[2].content).toBe("3")
    const notices = events.filter((e: any) => e.type === "notice").map((e: any) => e.data.text)
    expect(notices[0]).toContain("NOT applied")
    expect(notices[1]).toContain("applied (word-count")
    const offered = events.filter((e: any) => e.type === "model/requested").map((e: any) => e.data.tools)
    expect(offered[0]).toEqual(["read", "write", "edit", "bash"])
    expect(offered.at(-2)).toContain("word_count")
    expect(fs.readFileSync(`${out}.starts`, "utf8").trim().split("\n")).toHaveLength(1)
  }, 60_000)
})
