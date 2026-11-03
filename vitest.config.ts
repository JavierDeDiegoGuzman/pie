import * as path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Plugins (templates and the ones in test homes) import "@pie/sdk", like real plugins do.
    alias: { "@pie/sdk": path.resolve(import.meta.dirname, "packages/sdk/src/index.ts") }
  },
  test: { include: ["packages/*/test/**/*.test.ts"] }
})
