// Before packing a package: its LICENSE is the repo's; the SDK's README is the repo's, with links that work on npm.
// Usage (from a package folder): node ../../scripts/prepack.mjs <sdk|plugins|cli>
import * as fs from "node:fs"
const root = new URL("../", import.meta.url)
const pkg = new URL(`../packages/${process.argv[2]}/`, import.meta.url)
const blob = "https://github.com/JavierDeDiegoGuzman/pie/blob/main/"
fs.copyFileSync(new URL("LICENSE", root), new URL("LICENSE", pkg))
if (process.argv[2] === "sdk") {
  const readme = fs.readFileSync(new URL("README.md", root), "utf8")
    .replace(/\]\((packages\/[^)]+)\)/g, `](${blob}$1)`)
    .replace("[MIT](LICENSE)", `[MIT](${blob}LICENSE)`)
  fs.writeFileSync(new URL("README.md", pkg), readme)
}
