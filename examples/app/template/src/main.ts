/**
 * Entry point. Runs as a service (systemd restarts it when it exits); the
 * agent restarts it by running `npm run apply` with bash. `--smoke` boots everything
 * against an in-memory database on a free port and exits: the boot test used
 * by `npm run check`.
 */
import * as path from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie, Storage } from "pie-agent"
import { agentPlugins } from "./agent.ts"
import { serve } from "./server.ts"

const smoke = process.argv.includes("--smoke")
const APP_DIR = path.resolve(import.meta.dirname, "..")
// PIE_DATA: where the database lives (default .data); a test copy of the app must use another folder.
const DATA = path.resolve(process.env.PIE_DATA ?? path.join(APP_DIR, ".data"))
const storage = smoke ? Storage.memory : Storage.sqlite(path.join(DATA, "pie.db"))
if (!smoke) await import("node:fs").then((fs) => fs.mkdirSync(DATA, { recursive: true }))
// `npm run apply` (run by the agent with bash) restarts the app by signalling this process.
if (!smoke) process.env.PIE_APP_PID = String(process.pid)

const program = serve({
  appDir: APP_DIR,
  host: smoke ? "127.0.0.1" : process.env.HOST ?? "127.0.0.1",
  port: smoke ? 0 : Number(process.env.PORT ?? 4400)
}).pipe(
  Effect.andThen(smoke ? Effect.sync(() => console.log("smoke: the app boots")) : Effect.never)
)

NodeRuntime.runMain(program.pipe(Effect.provide(Pie.layer({ storage, plugins: agentPlugins })), Effect.scoped))
