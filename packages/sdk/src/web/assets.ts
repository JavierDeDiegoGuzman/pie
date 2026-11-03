/**
 * Browser libraries the web plugin serves (Preact + htm), resolved from the
 * SDK's dependencies so plugins anywhere can serve them without installing.
 */
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

const require = createRequire(import.meta.url)
/** Package root: walk up from its entry point (not every package exports package.json). */
const pkg = (name: string) => {
  let dir = path.dirname(require.resolve(name))
  while (!fs.existsSync(path.join(dir, "package.json")) || path.basename(dir) !== name) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`cannot find the package root of ${name}`)
    dir = parent
  }
  return dir
}

/** URL path under /vendor/ → file. Matches the import map in shell.html. */
export const vendor: Readonly<Record<string, string>> = {
  "preact.mjs": path.join(pkg("preact"), "dist", "preact.mjs"),
  "preact-hooks.mjs": path.join(pkg("preact"), "hooks", "dist", "hooks.mjs"),
  "htm.mjs": path.join(pkg("htm"), "dist", "htm.module.js"),
  "htm-preact.mjs": path.join(pkg("htm"), "preact", "index.module.js")
}
