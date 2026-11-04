import * as fs from "node:fs"
import * as path from "node:path"

/** A fresh Pie home inside the repo (its plugins import "effect" / "pie-agent" like real ones). */
export const testHome = (name: string) => {
  const home = path.join(import.meta.dirname, "..", ".tmp", "homes", `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(home, { recursive: true })
  return home
}
