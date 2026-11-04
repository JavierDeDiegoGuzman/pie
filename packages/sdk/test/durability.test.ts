import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const script = path.join(import.meta.dirname, "support", "crash-run.ts")

// Generous: the child process starts slowly when the whole suite runs in parallel.
const waitFor = async (predicate: () => boolean, ms = 40_000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("durability (SQLite, real process kill)", () => {
  it("resumes after SIGKILL: no repeated model call, idempotent tool re-runs, non-idempotent reports unknown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-crash-"))
    const db = path.join(dir, "pie.db")
    const log = path.join(dir, "log")
    fs.writeFileSync(`${log}.block`, "")
    const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [])

    const child = spawn(process.execPath, ["--no-warnings", script, db, log, "start"], { stdio: "ignore" })
    await waitFor(() => lines().includes("write-start") && lines().includes("read-start"))
    child.kill("SIGKILL")
    await new Promise((r) => child.once("exit", r))
    expect(lines().filter((l) => l === "llm")).toHaveLength(1)

    fs.rmSync(`${log}.block`)
    const output = execFileSync(process.execPath, ["--no-warnings", script, db, log, "resume"], {
      encoding: "utf8",
      timeout: 40_000
    })
    const { events, outcome } = JSON.parse(output.trim().split("\n").pop()!)

    expect(outcome).toMatchObject({ status: "completed" })
    // turn 0 was answered before the crash and is not asked again; only turn 1 is new
    expect(lines().filter((l) => l === "llm")).toHaveLength(2)
    expect(lines().filter((l) => l === "write-start")).toHaveLength(1)
    expect(lines().filter((l) => l === "read-start")).toHaveLength(2)

    const results = events.filter((e: any) => e.type === "tool/finished").map((e: any) => e.data)
    expect(results.find((r: any) => r.name === "read_file")).toMatchObject({ isError: false, content: "contents" })
    expect(results.find((r: any) => r.name === "write_file")).toMatchObject({ isError: true })
    expect(results.find((r: any) => r.name === "write_file").content).toContain("outcome is unknown")
    const conversation = events.map((e: any) => e.type).filter((t: string) =>
      ["user", "model/responded", "tool/finished", "run/ended"].includes(t)
    )
    expect(conversation).toEqual(["user", "model/responded", "tool/finished", "tool/finished", "model/responded", "run/ended"])
    // both tools started before the crash; re-running the read reuses its event id, so no duplicates
    expect(events.filter((e: any) => e.type === "tool/started")).toHaveLength(2)
  }, 120_000)
})
