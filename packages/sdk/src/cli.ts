#!/usr/bin/env node
/**
 * pie: recovery from the terminal, without loading any plugin.
 *
 *   pie serve    --db pie.db --cwd .          the app (web UI) under the supervisor
 *   pie explain  --db pie.db                  composition and history of changes
 *   pie rollback --db pie.db --to 12          back to right after change #12 (0: built-ins only)
 *   pie rollback --db pie.db --last-good      back to the last composition marked good
 *
 * Safe mode is a flag of the program that runs Pie: PIE_SAFE=1 loads the
 * built-ins only.
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
const db = flag("db")

const usage = () => {
  console.error(
    "usage: pie serve --db <file> [--cwd <dir>] [--port <n>] [--reload hot|restart]\n" +
      "       pie explain --db <file>\n" +
      "       pie rollback --db <file> (--to <seq> | --last-good) [--reason <text>]"
  )
  process.exit(2)
}

if (!db || !["serve", "explain", "rollback"].includes(command ?? "")) usage()

if (command === "serve") {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "app.ts")
  const code = await Supervisor.run({
    script: app,
    args: args.slice(1),
    database: path.resolve(db!),
    onRollback: ({ reason, toSeq }) => console.error(`pie: rolled back to #${toSeq} (${reason})`)
  })
  process.exit(code)
} else if (command === "explain") {
  const e = await Recovery.run(Recovery.explain(db!))
  console.log(`head #${e.head} · last good #${e.lastGood}`)
  console.log(`installed: ${e.installed.map((p) => `${p.id}@${p.version}`).join(", ") || "-"}`)
  console.log(`disabled: ${e.disabled.join(", ") || "-"}`)
  for (const h of e.history) console.log(`#${h.seq} ${h.at} ${h.type}${h.id ? ` ${h.id}` : ""}${h.version ? `@${h.version}` : ""}${h.note ? ` (${h.note})` : ""}`)
} else {
  const to = args.includes("--last-good") ? "last-good" : flag("to") === undefined ? undefined : Number(flag("to"))
  if (to === undefined || (typeof to === "number" && !Number.isInteger(to))) usage()
  const result = await Recovery.run(Recovery.rollback(db!, to!, flag("reason") ?? "pie rollback (terminal)"))
  console.log(result.changed ? `rolled back to #${result.toSeq}` : `already at #${result.toSeq}`)
}
