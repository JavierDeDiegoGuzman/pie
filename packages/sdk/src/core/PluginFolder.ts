/**
 * The plugins folder (`<home>/plugins`): one subfolder per plugin with an
 * `index.ts`, plus `plugins.json` for order and disabled plugins. The agent
 * edits it with ordinary tools (read, edit, write) and applies it with the
 * restart tool. Pure file operations, no plugin is loaded here.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Files } from "./ConfigLog.ts"

/** The plugin templates shipped with the SDK (copied into a new home). */
export const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins")

export const MANIFEST = "plugins.json"

export interface Manifest {
  /** Load order; plugins not listed load afterwards, alphabetically. */
  readonly order: ReadonlyArray<string>
  readonly disabled: ReadonlyArray<string>
}

const SKIP = new Set(["node_modules", ".git"])

/** Every file under `dir` (relative paths, sorted). */
export const readFiles = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  const walk = async (rel: string) => {
    let entries: Array<import("node:fs").Dirent>
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(relPath)
      else if (entry.isFile()) files[relPath] = await fs.readFile(path.join(dir, relPath), "utf8")
    }
  }
  await walk("")
  return files
}

/** Makes `dir` contain exactly `files` (removes everything else). */
export const writeFiles = async (dir: string, files: Files) => {
  const existing = await readFiles(dir)
  for (const name of Object.keys(existing)) {
    if (!(name in files)) await fs.rm(path.join(dir, name), { force: true })
  }
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    if (existing[name] !== content) await fs.writeFile(file, content)
  }
  // drop folders left empty
  const prune = async (rel: string): Promise<boolean> => {
    const abs = path.join(dir, rel)
    let entries: Array<import("node:fs").Dirent>
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!(await prune(rel ? `${rel}/${entry.name}` : entry.name))) empty = false
      } else empty = false
    }
    if (empty && rel) await fs.rmdir(abs)
    return empty
  }
  await prune("")
}

/** Template files for the given plugin ids, as they would be in a plugins folder (plus the manifest). */
export const templateFiles = async (ids: ReadonlyArray<string>, templates = TEMPLATES): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  for (const id of ids) {
    for (const [name, content] of Object.entries(await readFiles(path.join(templates, id)))) files[`${id}/${name}`] = content
  }
  files[MANIFEST] = JSON.stringify({ order: ids, disabled: [] } satisfies Manifest, null, 2) + "\n"
  return files
}

/** Enabled plugin ids in load order, from the files of a plugins folder. */
export const enabledPlugins = (files: Files): ReadonlyArray<string> => {
  let manifest: Manifest = { order: [], disabled: [] }
  try {
    if (files[MANIFEST]) manifest = { order: [], disabled: [], ...JSON.parse(files[MANIFEST]) }
  } catch {
    // an unreadable manifest is reported by validation; load in default order meanwhile
  }
  const ids = [...new Set(Object.keys(files).filter((f) => f.endsWith("/index.ts") && f.split("/").length === 2).map((f) => f.split("/")[0]!))]
  const ordered = [...manifest.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !manifest.order.includes(id)).sort()]
  return ordered.filter((id) => !manifest.disabled.includes(id))
}

/** Files of one plugin (relative to its folder). */
export const pluginFiles = (files: Files, id: string): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(`${id}/`)).map(([name, c]) => [name.slice(id.length + 1), c]))
