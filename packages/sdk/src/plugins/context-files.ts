/**
 * Built-in plugin: adds AGENTS.md (or CLAUDE.md) instructions to the system
 * prompt on every model call: the global one in ~/.pie/AGENTS.md, then every
 * file from the filesystem root down to the session cwd, closest last.
 * Files are read at call time, so edits apply to the next call.
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import * as Plugin from "../core/Plugin.ts"

const NAMES = ["AGENTS.md", "CLAUDE.md"]

const readFirst = (dir: string) =>
  Effect.promise(async () => {
    for (const name of NAMES) {
      const file = path.join(dir, name)
      try {
        return { file, text: await fs.readFile(file, "utf8") }
      } catch {
        // try the next name
      }
    }
    return undefined
  })

export const collect = (cwd: string, home = os.homedir()) =>
  Effect.gen(function*() {
    const dirs: Array<string> = []
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      dirs.unshift(dir)
      if (path.dirname(dir) === dir) break
    }
    const found: Array<{ file: string; text: string }> = []
    const global = yield* readFirst(path.join(home, ".pie"))
    if (global) found.push(global)
    for (const dir of dirs) {
      const local = yield* readFirst(dir)
      if (local) found.push(local)
    }
    return found
  })

export default Plugin.define({
  id: "context-files",
  sourceFiles: [fileURLToPath(import.meta.url)],
  setup: (ctx) =>
    ctx.hook("context", (event) =>
      Effect.gen(function*() {
        for (const { file, text } of yield* collect(event.cwd)) {
          event.system.push({ key: `context-files/${file}`, text: `Instructions from ${file}:\n\n${text.trim()}` })
        }
      }))
})
