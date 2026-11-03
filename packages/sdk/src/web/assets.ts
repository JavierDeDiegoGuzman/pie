/**
 * Files the web plugin serves. Exported from @pie/sdk so a replacement web
 * plugin written by the agent can reuse (or ignore) them.
 */
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
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

export const shell = path.join(here, "shell.html")
export const uiSdk = path.join(here, "ui-sdk.js")

/** URL path under /vendor/ → file. Matches the import map in shell.html. */
export const vendor: Readonly<Record<string, string>> = {
  "preact.mjs": path.join(pkg("preact"), "dist", "preact.mjs"),
  "preact-hooks.mjs": path.join(pkg("preact"), "hooks", "dist", "hooks.mjs"),
  "htm.mjs": path.join(pkg("htm"), "dist", "htm.module.js"),
  "htm-preact.mjs": path.join(pkg("htm"), "preact", "index.module.js")
}
