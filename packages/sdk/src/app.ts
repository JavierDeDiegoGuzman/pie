/**
 * The Pie application: built-in plugins + web interface + todo, on a SQLite
 * file. Run it through the supervisor with `pie serve` (restarts, automatic
 * rollback) or directly:
 *
 *   node src/app.ts --db pie.db --cwd /path/to/repo [--port 4100] [--reload hot|restart]
 *
 * PIE_SAFE=1 starts with the built-ins only, ignoring what the agent changed.
 */
import * as path from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import * as Pie from "./Pie.ts"
import * as Storage from "./core/Storage.ts"
import TodoPlugin from "./plugins/todo.ts"
import WebChatPlugin from "./plugins/web-chat.ts"
import WebPlugin from "./plugins/web.ts"

const args = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const db = path.resolve(flag("db", "pie.db")!)
const cwd = path.resolve(flag("cwd", process.cwd())!)
const reload = flag("reload", "hot") as "hot" | "restart"

NodeRuntime.runMain(
  Effect.never.pipe(
    Pie.exitOnRestart,
    Effect.provide(Pie.layer({
      storage: Storage.sqlite(db),
      plugins: [
        ...Pie.builtins,
        TodoPlugin,
        { plugin: WebPlugin, options: { cwd, ...(flag("port") ? { port: Number(flag("port")) } : {}) } },
        WebChatPlugin
      ],
      reload,
      pluginCacheDirectory: path.join(path.dirname(db), ".pie-plugins")
    })),
    Effect.scoped
  )
)
