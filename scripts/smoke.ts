/**
 * Release smoke test: packs pie-agent, installs the tarball with npm in an
 * empty folder (as a user would) and checks that it works from node_modules:
 *
 *   - the library imports and has types;
 *   - `pie serve` seeds a home, loads the plugins from it (TypeScript outside
 *     node_modules importing "pie-agent"), and serves the web UI;
 *   - safe mode (PIE_SAFE=1) loads the templates shipped in the package;
 *   - `pie explain` reads the home.
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

step("pack")
run("pnpm", ["pack", "--pack-destination", work], path.join(root, "packages", "sdk"))
const tarball = fs.readdirSync(work).find((f) => f.endsWith(".tgz")) ?? fail("no tarball")
const listing = run("tar", ["-tzf", path.join(work, tarball)], work).split("\n")
for (const needed of ["package/dist/src/cli.js", "package/dist/src/index.d.ts", "package/plugins/web/shell.html", "package/docs/PLUGINS.md", "package/LICENSE", "package/README.md"]) {
  if (!listing.includes(needed)) fail(`the package does not contain ${needed}`)
}
if (listing.some((f) => f.startsWith("package/dist/test") || f.startsWith("package/test/"))) fail("the package contains tests")
console.log(`  ${tarball}: ${listing.filter(Boolean).length} files`)

step("install with npm in an empty project")
const app = path.join(work, "app")
fs.mkdirSync(app)
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }))
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", path.join(work, tarball)], app)

step("import the library")
fs.writeFileSync(
  path.join(app, "use.mjs"),
  `import * as Pie from "pie-agent"\nif (typeof Pie.Pie.layer !== "function") throw new Error("no Pie.layer")\nconsole.log("  exports:", Object.keys(Pie).length)\n`
)
process.stdout.write(run(process.execPath, ["use.mjs"], app))

const bin = path.join(app, "node_modules", ".bin", "pie")
const serve = async (home: string, port: number, env: Record<string, string> = {}) => {
  const child = spawn(bin, ["serve", "--home", home, "--cwd", app, "--port", String(port)], {
    cwd: app,
    env: { ...process.env, PIE_TOKEN: "smoke", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  children.add(child)
  let output = ""
  child.stdout.on("data", (d) => (output += d))
  child.stderr.on("data", (d) => (output += d))
  try {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/plugins`, { headers: { "x-pie-token": "smoke" } })
        if (res.ok) return { plugins: await res.json(), output }
      } catch {
        // not up yet
      }
    }
    return fail(`pie serve did not answer on port ${port}:\n${output}`)
  } finally {
    child.kill("SIGTERM")
    await new Promise((r) => child.once("exit", r))
    children.delete(child)
  }
}

step("pie serve: seeds a home and loads its plugins")
const home = path.join(app, ".pie")
const normal = await serve(home, 4791)
const ids = normal.plugins.plugins.map((p: { id: string }) => p.id)
for (const id of ["coding-tools", "self", "web", "web-chat", "opencode-go"]) {
  if (!ids.includes(id)) fail(`plugin ${id} did not load: ${JSON.stringify(ids)}\n${normal.output}`)
}
if (!fs.existsSync(path.join(home, "plugins", "coding-tools", "index.ts"))) fail(`the home was not seeded: ${work}\n${JSON.stringify(normal.plugins, null, 1).slice(0, 600)}`)
console.log("  loaded:", ids.join(", "))

step("PIE_SAFE=1: loads the templates shipped in the package")
const safe = await serve(home, 4792, { PIE_SAFE: "1" })
if (!safe.plugins.safe || !safe.plugins.plugins.some((p: { id: string }) => p.id === "coding-tools")) {
  fail(`safe mode did not load the templates: ${JSON.stringify(safe.plugins)}\n${safe.output}`)
}
console.log("  safe mode ok")

step("pie explain")
const explained = run(bin, ["explain", "--home", home], app)
if (!explained.includes("seeded from the SDK templates")) fail(`unexpected explain output:\n${explained}`)
console.log("  ok")

fs.rmSync(work, { recursive: true, force: true }) // on failure fail() exits first and keeps it for inspection
console.log("\n✓ smoke test passed")
