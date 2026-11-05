// Bundles the page into web/dist (part of `npm run check`, so a broken UI never restarts the app).
import * as fs from "node:fs"
import * as esbuild from "esbuild"
const here = new URL(".", import.meta.url).pathname
// Start from an empty dist: leftovers from another build must not be served.
fs.rmSync(`${here}dist`, { recursive: true, force: true })
fs.mkdirSync(`${here}dist`, { recursive: true })
await esbuild.build({
  entryPoints: [`${here}src/app.tsx`],
  outfile: `${here}dist/app.js`,
  bundle: true,
  format: "esm",
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning"
})
fs.copyFileSync(`${here}index.html`, `${here}dist/index.html`)
fs.copyFileSync(`${here}src/styles.css`, `${here}dist/styles.css`)
// Static files (favicon, icons): web/public as they are.
if (fs.existsSync(`${here}public`)) fs.cpSync(`${here}public`, `${here}dist`, { recursive: true })
