import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import OpenCodeGoPlugin from "../src/opencode-go/index.ts"
import * as OpenCodeGo from "../src/opencode-go/provider.ts"
import { defineTool, Pie, Plugin, Storage } from "pie-agent"

const Add = Tool.make("add", {
  description: "Add two integers",
  parameters: Schema.Struct({ a: Schema.Int, b: Schema.Int }),
  success: Schema.Int
})
const Math = Toolkit.make(Add)
const MathLive = Math.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

const ModelLive = OpenCodeGo.languageModel({ sessionId: `pie-live-${Date.now()}` }).pipe(
  Layer.provide(NodeServices.layer)
)

describe.skipIf(process.env.PIE_LIVE !== "1")("OpenCode Go (live)", () => {
  it.effect("deepseek-v4.1-flash answers and calls a tool", () =>
    Effect.gen(function*() {
      const toolkit = yield* Math
      const res = yield* LanguageModel.generateText({
        prompt: "Usa la tool add para sumar 19 y 23. No calcules tú.",
        toolkit,
        toolChoice: "required"
      })
      expect(res.toolCalls.map((c) => c.name)).toContain("add")
      expect(res.toolResults.find((r) => r.name === "add")?.result).toBe(42)
    }).pipe(Effect.provide([ModelLive, MathLive])), 60_000)
})

describe.skipIf(process.env.PIE_LIVE !== "1")("Pie loop with OpenCode Go (live)", () => {
  it.live("deepseek-v4.1-flash drives a durable run with a plugin tool", () =>
    Effect.gen(function*() {
      const pie = yield* Pie.Pie
      const session = yield* pie.create({ cwd: process.cwd(), model: "opencode-go/deepseek-v4.1-flash" })
      yield* session.prompt("Usa la tool add para sumar 19 y 23 y responde solo con el número.")
      const outcome = yield* session.awaitIdle
      const events = yield* session.events
      expect(outcome).toMatchObject({ status: "completed" })
      expect(events.some((e) => e.type === "tool/finished" && (e.data as { content: string }).content === "42")).toBe(true)
      const answer = [...events].reverse().find((e) => e.type === "model/responded")
      expect((answer?.data as { text: string }).text).toContain("42")
    }).pipe(
      Effect.provide(Pie.layer({
        storage: Storage.memory,
        plugins: [
          OpenCodeGoPlugin,
          Plugin.define({
            id: "math",
            setup: (ctx) =>
              ctx.tools.transform((tools) => {
                tools.set("add", defineTool({
                  name: "add",
                  description: "Add two integers",
                  parameters: Schema.Struct({ a: Schema.Int, b: Schema.Int }),
                  idempotent: true,
                  execute: ({ a, b }) => Effect.succeed({ content: String(a + b) })
                }))
              })
          })
        ]
      })),
      Effect.scoped
    ), 90_000)
})
