/**
 * Restart instead of hot reload, and the automatic rollback.
 *
 * Runs the Pie program as a child process and starts it again when it exits
 * with RESTART_EXIT_CODE (a plugin change in reload: "restart"). If it crashes
 * `maxQuickCrashes` times in a row within `quickCrashMs` of starting, the last
 * configuration change is assumed to be the cause: the configuration log is
 * rolled back to the last composition marked good, without loading plugins,
 * and the program starts again.
 *
 *   // supervisor.ts (never changes)
 *   Supervisor.run({ script: "./agent.ts", database: "pie.db" })
 */
import { spawn } from "node:child_process"
import * as Recovery from "./core/Recovery.ts"

export const RESTART_EXIT_CODE = 75

export interface RunOptions {
  readonly script: string
  readonly args?: ReadonlyArray<string>
  readonly nodeArgs?: ReadonlyArray<string>
  /** Database of the program; enables the automatic rollback. */
  readonly database?: string
  readonly quickCrashMs?: number
  readonly maxQuickCrashes?: number
  /** Called before each (re)start; return false to stop. */
  readonly onStart?: (attempt: number) => boolean | void
  readonly onRollback?: (info: { readonly toSeq: number; readonly reason: string }) => void
}

/** Runs the script until it exits with 0 (or the attempts stop); resolves with the last exit code. */
export const run = (options: RunOptions): Promise<number> =>
  new Promise((resolve) => {
    let attempt = 0
    let quickCrashes = 0
    const start = () => {
      if (options.onStart?.(attempt) === false) return resolve(1)
      attempt++
      const startedAt = Date.now()
      const child = spawn(process.execPath, [...(options.nodeArgs ?? ["--no-warnings"]), options.script, ...(options.args ?? [])], {
        stdio: "inherit"
      })
      child.on("exit", (code) => {
        if (code === 0) return resolve(0)
        if (code === RESTART_EXIT_CODE) {
          quickCrashes = 0
          return start()
        }
        quickCrashes = Date.now() - startedAt < (options.quickCrashMs ?? 15_000) ? quickCrashes + 1 : 0
        if (options.database && quickCrashes >= (options.maxQuickCrashes ?? 2)) {
          quickCrashes = 0
          const reason = `automatic: crashed ${options.maxQuickCrashes ?? 2} times in a row right after starting (exit ${code})`
          Recovery.run(Recovery.rollback(options.database, "last-good", reason)).then(
            (result) => {
              options.onRollback?.({ toSeq: result.toSeq, reason })
              start()
            },
            () => resolve(code ?? 1)
          )
          return
        }
        start()
      })
    }
    start()
  })
