import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const script = path.join(import.meta.dirname, "support", "workflow-run.ts")

describe("Effect workflows journaled in Pie's database", () => {
  it("survive SIGKILL: completed activities are not re-run, the durable clock keeps its time, approvals resume them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-wf-"))
    const db = path.join(dir, "pie.db")
    const log = path.join(dir, "log")
    const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")) : [])

    const child = spawn(process.execPath, ["--no-warnings", script, db, log, "start"], { stdio: "ignore" })
    const deadline = Date.now() + 15_000
    while (!lines().some(([name]) => name === "a")) {
      if (Date.now() > deadline) throw new Error("activity a never ran")
      await new Promise((r) => setTimeout(r, 50))
    }
    const aAt = Number(lines().find(([name]) => name === "a")![1])
    // Kill during the 1.5 s clock, after "a" was journaled. (Killed between finishing and journaling,
    // "a" would run again: activities are at-least-once.)
    await new Promise((r) => setTimeout(r, 300))
    child.kill("SIGKILL")
    await new Promise((r) => child.once("exit", r))

    const resumed = JSON.parse(execFileSync(process.execPath, ["--no-warnings", script, db, log, "resume"], { encoding: "utf8", timeout: 30_000 }).trim().split("\n").pop()!)
    expect(resumed.result).toBe("AokB")
    expect(lines().filter(([name]) => name === "a")).toHaveLength(1) // not re-run after the crash
    expect(lines().filter(([name]) => name === "b")).toHaveLength(1)
    const tokenAt = Number(lines().find(([name]) => name === "token-seen")![1])
    expect(tokenAt - aAt).toBeGreaterThanOrEqual(1400) // the clock waited its full duration across the crash

    const again = JSON.parse(execFileSync(process.execPath, ["--no-warnings", script, db, log, "again"], { encoding: "utf8", timeout: 30_000 }).trim().split("\n").pop()!)
    expect(again.result).toBe("AokB")
    expect(lines().filter(([name]) => name === "a" || name === "b")).toHaveLength(2) // nothing ran again
  }, 60_000)
})
