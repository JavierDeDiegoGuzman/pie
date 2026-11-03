/**
 * Restart instead of hot reload. A tiny supervisor runs the Pie process as a
 * child and starts it again whenever it exits with RESTART_EXIT_CODE. Since
 * the log is the source of truth, the new process resumes every open run.
 *
 *   // supervisor.ts (never changes)
 *   Supervisor.run({ script: "./agent.ts", args: process.argv.slice(2) })
 *
 *   // agent.ts
 *   program.pipe(Effect.provide(Pie.layer({ ..., reload: "restart" })), Pie.exitOnRestart, ...)
 */
import { spawn } from "node:child_process"

export const RESTART_EXIT_CODE = 75

export interface RunOptions {
  readonly script: string
  readonly args?: ReadonlyArray<string>
  readonly nodeArgs?: ReadonlyArray<string>
  /** Called before each (re)start; return false to stop. */
  readonly onStart?: (attempt: number) => boolean | void
}

/** Runs the script until it exits with any code other than RESTART_EXIT_CODE; resolves with that code. */
export const run = (options: RunOptions): Promise<number> =>
  new Promise((resolve) => {
    let attempt = 0
    const start = () => {
      if (options.onStart?.(attempt) === false) return resolve(RESTART_EXIT_CODE)
      attempt++
      const child = spawn(process.execPath, [...(options.nodeArgs ?? ["--no-warnings"]), options.script, ...(options.args ?? [])], {
        stdio: "inherit"
      })
      child.on("exit", (code) => (code === RESTART_EXIT_CODE ? start() : resolve(code ?? 1)))
    }
    start()
  })
