import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const support = path.join(import.meta.dirname, "support")

const check = (out: string) => {
  const { events, outcome } = JSON.parse(fs.readFileSync(out, "utf8"))
  const results = events.filter((e: any) => e.type === "tool/finished").map((e: any) => e.data)
  expect(outcome).toMatchObject({ status: "completed" })
  expect(results.map((r: any) => [r.name, r.isError])).toEqual([
    ["write", false],
    ["restart", true],
    ["write", false],
    ["restart", false],
    ["word_count", false]
  ])
  expect(results[1].content).toContain("Nothing applied")
  expect(results[4].content).toBe("3")
  const offered = events.filter((e: any) => e.type === "model/requested").map((e: any) => e.data.tools)
  expect(offered[0]).toEqual(expect.arrayContaining(["read", "write", "restart"]))
  expect(offered[0]).not.toContain("word_count")
  expect(offered.at(-2)).toContain("word_count")
}

describe("self-modification in a real Node process, home outside the repo", () => {
  it("hot: after restart the plugin's tool is offered on the next model call of the same run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-self-"))
    const out = path.join(dir, "out.json")
    execFileSync(process.execPath, ["--no-warnings", path.join(support, "self-modify-run.ts"), path.join(dir, ".pie"), "hot", out], {
      timeout: 40_000
    })
    check(out)
    expect(fs.readFileSync(`${out}.starts`, "utf8").trim().split("\n")).toHaveLength(1)
  }, 60_000)

  it("restart: the restart tool drains, exits for the supervisor, and the next process resumes with the plugin", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-self-"))
    const out = path.join(dir, "out.json")
    const home = path.join(dir, ".pie")
    execFileSync(
      process.execPath,
      ["--no-warnings", path.join(support, "supervise.ts"), "--home", home, path.join(support, "self-modify-run.ts"), home, "restart", out],
      { timeout: 50_000 }
    )
    check(out)
    expect(fs.readFileSync(`${out}.starts`, "utf8").trim().split("\n")).toHaveLength(2)
  }, 60_000)
})
