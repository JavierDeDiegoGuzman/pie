#!/usr/bin/env node
/**
 * pie: run Pie and recover it from the terminal, without loading any plugin.
 *
 *   pie serve    [--home .pie] [--cwd .] [--port 4100]   the app (web UI) under the supervisor
 *   pie explain  [--home .pie]                           plugins and history of plugin changes
 *   pie rollback [--home .pie] --to 12                   plugins folder back to snapshot #12
 *   pie rollback [--home .pie] --last-good               back to the last snapshot marked good
 *
 * PIE_SAFE=1 starts with the SDK templates only, ignoring the plugins folder.
 */
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as Recovery from "./core/Recovery.ts"
import * as Supervisor from "./Supervisor.ts"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const command = args[0]
const home = path.resolve(flag("home") ?? ".pie")

const usage = () => {
  console.error(
    "usage: pie serve [--home .pie] [--cwd <dir>] [--port <n>]\n" +
      "       pie explain [--home .pie]\n" +
      "       pie rollback [--home .pie] (--to <seq> | --last-good) [--reason <text>]"
  )
  process.exit(2)
}

if (!["serve", "explain", "rollback"].includes(command ?? "")) usage()

if (command === "serve") {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "app.ts")
  const rest = args.slice(1).filter((_, i, all) => all[i] !== "--home" && all[i - 1] !== "--home")
  const code = await Supervisor.run({
    script: app,
    args: ["--home", home, ...rest],
    home,
    onRollback: ({ reason, toSeq }) => console.error(`pie: rolled back to #${toSeq} (${reason})`)
  })
  process.exit(code)
} else if (command === "explain") {
  const e = await Recovery.run(Recovery.explain(home))
  console.log(`folder ${e.folder}`)
  console.log(`plugins: ${e.plugins.join(", ") || "-"}`)
  console.log(`head #${e.head} · last good #${e.lastGood}`)
  for (const h of e.history) console.log(`#${h.seq} ${h.at} ${h.type} ${h.note}`)
} else {
  const to = args.includes("--last-good") ? "last-good" : flag("to") === undefined ? undefined : Number(flag("to"))
  if (to === undefined || (typeof to === "number" && !Number.isInteger(to))) usage()
  const result = await Recovery.run(Recovery.rollback(home, to!, flag("reason") ?? "pie rollback (terminal)"))
  console.log(result.changed ? `rolled back to #${result.toSeq}` : `nothing to restore for #${result.toSeq}`)
}
