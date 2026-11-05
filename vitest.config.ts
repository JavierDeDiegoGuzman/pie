import * as path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Plugins (templates and the ones in test homes) import "pie-agent", like real plugins do.
    alias: {
      "pie-agent": path.resolve(import.meta.dirname, "packages/sdk/src/index.ts"),
      "@pie-agent/plugins": path.resolve(import.meta.dirname, "packages/plugins/src/index.ts")
    }
  },
  test: { include: ["packages/*/test/**/*.test.ts"] }
})
