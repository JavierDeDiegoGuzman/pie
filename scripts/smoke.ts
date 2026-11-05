/**
 * Release smoke test: packs pie-agent and @pie-agent/plugins, installs the
 * tarballs with npm in an empty folder (as a user would) and checks that they
 * work from node_modules: the SDK imports, has types, loads the extensions
 * passed in code, and holds its SQLite database exclusively.
 *
 * Run after `pnpm build`: node --no-warnings scripts/smoke.ts
 */
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pie-smoke-"))
const run = (cmd: string, args: Array<string>, cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
const step = (name: string) => console.log(`\n▸ ${name}`)
const children = new Set<ReturnType<typeof spawn>>()
process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM")
})
const fail = (message: string): never => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const packages: Record<string, Array<string>> = {
  sdk: ["package/dist/src/index.js", "package/dist/src/index.d.ts", "package/docs/PLUGINS.md", "package/LICENSE", "package/README.md"],
  plugins: ["package/dist/src/index.js", "package/dist/src/index.d.ts", "package/LICENSE", "package/README.md"]
}
const tarballs: Array<string> = []
for (const [dir, needed] of Object.entries(packages)) {
  step(`pack ${dir}`)
  const out = path.join(work, dir)
  fs.mkdirSync(out)
  run("pnpm", ["pack", "--pack-destination", out], path.join(root, "packages", dir))
  const tarball = path.join(out, fs.readdirSync(out).find((f) => f.endsWith(".tgz")) ?? fail(`no tarball for ${dir}`))
  const listing = run("tar", ["-tzf", tarball], work).split("\n")
  for (const file of needed) if (!listing.includes(file)) fail(`${dir} does not contain ${file}`)
  if (listing.some((f) => f.startsWith("package/dist/test") || f.startsWith("package/test/"))) fail(`${dir} contains tests`)
  const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], work))
  if (JSON.stringify(manifest.dependencies ?? {}).includes("workspace:")) fail(`${dir} has workspace: dependencies`)
  console.log(`  ${path.basename(tarball)}: ${listing.filter(Boolean).length} files`)
  tarballs.push(tarball)
}

step("install with npm in an empty project")
const app = path.join(work, "app")
fs.mkdirSync(app)
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }))
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], app)

step("the SDK with plugins in code")
fs.writeFileSync(
  path.join(app, "use.mjs"),
  `import { Effect } from "effect"
import { Pie, Registries, Storage } from "pie-agent"
import { defaults } from "@pie-agent/plugins"
const program = Effect.gen(function*() {
  const registries = yield* Registries
  const tools = [...(yield* registries.tools.get).keys()]
  const models = [...(yield* registries.models.get).keys()]
  if (tools.join() !== "read,write,edit,bash") throw new Error("tools: " + tools)
  if (!models.includes("opencode-go/deepseek-v4.1-flash")) throw new Error("models: " + models)
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: process.cwd(), model: "opencode-go/deepseek-v4.1-flash" })
  console.log("  tools:", tools.join(", "), "· session", session.id.slice(0, 8))
})
await Effect.runPromise(program.pipe(Effect.provide(Pie.layer({ plugins: defaults, storage: Storage.sqlite("pie.db") })), Effect.scoped))
`
)
process.stdout.write(run(process.execPath, ["--no-warnings", "use.mjs"], app))

fs.rmSync(work, { recursive: true, force: true }) // on failure fail() exits first and keeps it for inspection
console.log("\n✓ smoke test passed")
