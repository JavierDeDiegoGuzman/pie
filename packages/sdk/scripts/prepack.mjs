// Before packing: the package's README and LICENSE are the repo's, with links that work on npm.
import * as fs from "node:fs"
const root = new URL("../../../", import.meta.url)
const pkg = new URL("../", import.meta.url)
const readme = fs.readFileSync(new URL("README.md", root), "utf8")
  .replaceAll("](packages/sdk/docs/", "](https://github.com/JavierDeDiegoGuzman/pie/blob/main/packages/sdk/docs/")
  .replaceAll("](plugins/", "](https://github.com/JavierDeDiegoGuzman/pie/blob/main/packages/sdk/plugins/")
  .replace("[MIT](LICENSE)", "[MIT](https://github.com/JavierDeDiegoGuzman/pie/blob/main/LICENSE)")
fs.writeFileSync(new URL("README.md", pkg), readme)
fs.copyFileSync(new URL("LICENSE", root), new URL("LICENSE", pkg))
