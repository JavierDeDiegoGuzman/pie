// Copies the docs from packages/sdk/docs (the single source, also shipped with
// the npm package) into the site, adding Starlight frontmatter and turning links
// between them into site links. The copies are generated: do not edit them.
import * as fs from "node:fs"
import * as path from "node:path"

const here = path.dirname(new URL(import.meta.url).pathname)
const sdk = path.resolve(here, "../../../packages/sdk")
const out = path.resolve(here, "../src/content/docs")

const pages = {
  "SDK.md": { slug: "docs/sdk", title: "Using the SDK", description: "Pie from code: choose extensions, bring any model, restart safely, let a program change itself." },
  "PLUGINS.md": { slug: "docs/plugins", title: "Writing extensions", description: "The extension API: tools, models, prompt, hooks, events, projections and reactions." },
  "EVENTS.md": { slug: "docs/events", title: "Events and durability", description: "The session log, the agent loop written over it, the tick, and why restarting is safe." },
  "CORE.md": { slug: "docs/core", title: "Core and extensions", description: "What the SDK does and what extensions add." },
  "architecture.md": { slug: "docs/architecture", title: "Architecture", description: "Diagrams, persisted data, edge cases and the SDK API." },
  "REFERENCES.md": { slug: "docs/references", title: "References", description: "What Pie takes from pi, OpenCode and the DeepSeek Harness." }
}

// Pages are served as folders (/docs/events/), so links are relative to the page itself.
const link = (from, to) => path.posix.relative(`/${from}`, `/${to}`) + "/"

const convert = (source, page) => {
  let text = fs.readFileSync(source, "utf8").replace(/^# .*\n+/, "")
  for (const [file, target] of Object.entries(pages)) {
    // [EVENTS.md](EVENTS.md) reads well on GitHub; on the site, use the page title.
    text = text.replaceAll(`[${file}](${file})`, `[${target.title}](${file})`)
    text = text.replaceAll(`](${file})`, `](${link(page.slug, target.slug)})`)
  }
  const frontmatter = `---\ntitle: ${JSON.stringify(page.title)}\ndescription: ${JSON.stringify(page.description)}\n---\n\n`
  return `<!-- Generated from packages/sdk by scripts/sync-docs.mjs: edit the original. -->\n`.replace(/^/, frontmatter) + text
}

fs.rmSync(path.join(out, "docs"), { recursive: true, force: true })
fs.mkdirSync(path.join(out, "docs"), { recursive: true })
for (const [file, page] of Object.entries(pages)) {
  fs.writeFileSync(path.join(out, `${page.slug}.md`), convert(path.join(sdk, "docs", file), page))
}
fs.cpSync(path.join(sdk, "docs", "diagrams"), path.join(out, "docs", "diagrams"), {
  recursive: true,
  filter: (f) => fs.statSync(f).isDirectory() || f.endsWith(".svg")
})
fs.writeFileSync(
  path.join(out, "changelog.md"),
  convert(path.join(sdk, "CHANGELOG.md"), { slug: "changelog", title: "Changelog", description: "Releases of Pie." })
)
console.log(`synced ${Object.keys(pages).length + 1} pages from packages/sdk`)
