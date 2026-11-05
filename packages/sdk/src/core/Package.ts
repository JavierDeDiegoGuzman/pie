/**
 * Where the pie-agent package is and how it runs: from source (src/*.ts, in
 * the repo) or built (dist/src/*.js, installed from npm).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** The nearest folder at or above `from` whose package.json has `name` (any package if no name is given). */
export const findRoot = (from: string, name?: string): string => {
  let dir = from
  for (;;) {
    const file = path.join(dir, "package.json")
    if (fs.existsSync(file) && (name === undefined || JSON.parse(fs.readFileSync(file, "utf8")).name === name)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`cannot find the package root${name ? ` of ${name}` : ""} from ${from}`)
    dir = parent
  }
}

/** The package root (the folder with its package.json). */
export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)), "pie-agent")
/** ".ts" when running from source, ".js" when built. */
export const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
/** The folder with the running code: src/ or dist/src/. */
export const SOURCE = path.join(ROOT, EXT === ".ts" ? "src" : path.join("dist", "src"))
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
/** A module of the running code, e.g. entry("index") → src/index.ts or dist/src/index.js. */
export const entry = (name: string): string => path.join(SOURCE, `${name}${EXT}`)
export const DOCS = path.join(ROOT, "docs")
