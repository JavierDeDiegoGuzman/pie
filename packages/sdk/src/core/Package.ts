/**
 * Where the pie-agent package is and how it runs: from source (src/*.ts, in
 * the repo) or built (dist/src/*.js, installed from npm). Everything that
 * needs a path into the package (templates, docs, the CLI) goes through here.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const findRoot = (from: string): string => {
  let dir = from
  for (;;) {
    const file = path.join(dir, "package.json")
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === "pie-agent") return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error("pie-agent: cannot find the package root")
    dir = parent
  }
}

/** The package root (the folder with its package.json). */
export const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)))
/** ".ts" when running from source, ".js" when built. */
export const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
/** The folder with the running code: src/ or dist/src/. */
export const SOURCE = path.join(ROOT, EXT === ".ts" ? "src" : path.join("dist", "src"))
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
/** A module of the running code, e.g. entry("cli") → src/cli.ts or dist/src/cli.js. */
export const entry = (name: string): string => path.join(SOURCE, `${name}${EXT}`)
/** Plugin templates new homes are seeded from (TypeScript sources, shipped as they are). */
export const TEMPLATES = path.join(ROOT, "plugins")
export const DOCS = path.join(ROOT, "docs")
