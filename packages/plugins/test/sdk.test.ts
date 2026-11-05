import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Pie, PluginHost, Registries } from "pie-agent"
import { codingTools, defaults, systemPrompt } from "../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, toolResults } from "./support/fake-model.ts"
import { testHome } from "./support/home.ts"

const loadedIds = Effect.gen(function*() {
  const host = yield* PluginHost
  return (yield* host.list).map((p) => p.id)
})

describe("the SDK with plugins in code", () => {
  it.live("the extensions passed in code are all there is", () =>
    Effect.gen(function*() {
      const registries = yield* Registries
      expect([...(yield* registries.models.get).keys()]).toContain("opencode-go/deepseek-v4.1-flash")
      expect([...(yield* registries.tools.get).keys()]).toEqual(["read", "write", "edit", "bash"])
      expect(yield* loadedIds).toEqual(["sdk-guard", "opencode-go", "system-prompt", "context-files", "coding-tools"])
    }).pipe(Effect.provide(Pie.layer({ plugins: defaults })), Effect.scoped))

  it.live("any model plugin works: no OpenCode Go needed", () => {
    const dir = testHome("sdk-own-model")
    return Effect.gen(function*() {
      const pie = yield* Pie.Pie
      const session = yield* pie.create({ cwd: dir, model: FAKE_MODEL })
      yield* session.prompt("write hello.txt")
      expect(yield* session.awaitIdle).toMatchObject({ status: "completed" })
      expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("hi")
    }).pipe(
      Effect.provide(Pie.layer({
        plugins: [
          fakeModelPlugin((messages) =>
            toolResults(messages).length === 0 ? { tools: [{ name: "write", params: { path: "hello.txt", content: "hi" } }] } : { text: "done" }
          ),
          systemPrompt,
          codingTools
        ]
      })),
      Effect.scoped
    )
  })
})
