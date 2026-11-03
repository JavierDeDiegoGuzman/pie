/**
 * The Pie application: a Pie home (`.pie`: sessions + editable plugins) with
 * the web interface. Run it through the supervisor with `pie serve`
 * (restarts, automatic rollback) or directly:
 *
 *   node src/app.ts [--home .pie] [--cwd /path/to/repo] [--port 4100]
 *
 * Under the supervisor, the agent's restart tool really restarts Pie; run
 * directly, changes apply in this process. PIE_SAFE=1 loads the SDK templates
 * instead of the plugins folder.
 */
import * as path from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as Pie from "./Pie.ts"

const args = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const home = path.resolve(flag("home", ".pie")!)
const cwd = path.resolve(flag("cwd", process.cwd())!)

NodeRuntime.runMain(
  Effect.never.pipe(
    Pie.exitOnRestart,
    Effect.provide(Pie.layer({
      home,
      seed: [...Pie.DEFAULT_SEED, "web", "web-chat"],
      pluginOptions: { web: { cwd, ...(flag("port") ? { port: Number(flag("port")) } : {}) } },
      reload: (flag("reload") as "hot" | "restart" | undefined) ?? (process.env.PIE_SUPERVISED === "1" ? "restart" : "hot")
    })),
    Effect.scoped
  )
)
