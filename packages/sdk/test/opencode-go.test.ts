import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import * as OpenCodeGo from "../src/providers/OpenCodeGo.ts"

// What one of the backends behind OpenCode Go really sends (captured): continuation
// fragments carry "id": null, "type": null and "function.name": null.
const chunk = (toolCalls: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finish }] })}\n\n`
const fragments = [
  chunk([{ index: 0, id: "chatcmpl-tool-1", type: "function", function: { name: "read", arguments: "" } }]),
  chunk([{ index: 0, id: null, type: null, function: { name: null, arguments: "{\"path\": " } }]),
  chunk([{ index: 0, id: null, type: null, function: { name: null, arguments: "\"a.ts\"}" } }]),
  chunk([], "tool_calls"),
  "data: [DONE]\n\n"
]

describe("OpenCode Go", () => {
  it.effect("keeps tool-call arguments sent in fragments with null fields", () =>
    Effect.gen(function*() {
      const realFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        // Split mid-line too, as a network would.
        const body = fragments.join("")
        const parts = [body.slice(0, 100), body.slice(100, 333), body.slice(333)]
        return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close() } }), {
          headers: { "content-type": "text/event-stream" }
        })
      }) as typeof fetch
      yield* Effect.addFinalizer(() => Effect.sync(() => void (globalThis.fetch = realFetch)))
      const read = Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }) })
      const toolkit = Toolkit.make(read)
      const calls = yield* LanguageModel.streamText({
        prompt: "read a.ts",
        toolkit: Object.assign(toolkit.of({ read: () => Effect.die("") }), toolkit) as never,
        disableToolCallResolution: true
      }).pipe(
        Stream.filter((p: { type: string }) => p.type === "tool-call"),
        Stream.runCollect,
        Effect.provide(OpenCodeGo.languageModel({ sessionId: "s", apiKey: Redacted.make("k") }))
      )
      expect(Array.from(calls).map((c: any) => [c.name, c.params])).toEqual([["read", { path: "a.ts" }]])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it("normalizeChunk leaves other chunks untouched", () => {
    expect(OpenCodeGo.normalizeChunk("{\"choices\":[{\"delta\":{\"content\":null}}]}")).toBe("{\"choices\":[{\"delta\":{\"content\":null}}]}")
  })
})
