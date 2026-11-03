/**
 * A scripted LanguageModel registered through a plugin, for tests. The script
 * receives the prompt messages and returns what the model "says".
 */
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, type Prompt, type Response } from "effect/ai"
import { Plugin } from "../../src/index.ts"

export type Reply =
  | { readonly text: string }
  | { readonly tools: ReadonlyArray<{ readonly name: string; readonly params: unknown; readonly id?: string }> }

export const FAKE_MODEL = "fake/scripted"

const finish = (reason: "stop" | "tool-calls"): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }
} as Response.StreamPartEncoded)

let callCounter = 0

const toParts = (reply: Reply): Array<Response.StreamPartEncoded> => {
  if ("text" in reply) {
    const id = `t${callCounter++}`
    return [
      { type: "text-start", id } as Response.StreamPartEncoded,
      ...reply.text.split(/(?<= )/).map((delta) => ({ type: "text-delta", id, delta }) as Response.StreamPartEncoded),
      { type: "text-end", id } as Response.StreamPartEncoded,
      finish("stop")
    ]
  }
  return [
    ...reply.tools.map((tool) => ({
      type: "tool-call",
      id: tool.id ?? `call_${callCounter++}`,
      name: tool.name,
      params: tool.params,
      providerExecuted: false
    }) as Response.StreamPartEncoded),
    finish("tool-calls")
  ]
}

/** Reply "hang": the stream sends nothing and never ends (a stalled provider). */
export const HANG = { hang: true } as const

export const fakeModelPlugin = (
  script: (messages: ReadonlyArray<Prompt.Message>, tools: ReadonlyArray<string>) => Reply | typeof HANG,
  onCall?: () => void
) =>
  Plugin.define({
    id: "fake-model",
    setup: (ctx) =>
      ctx.models.transform((models) => {
        models.set(FAKE_MODEL, {
          id: FAKE_MODEL,
          provider: "fake",
          model: "scripted",
          layer: () =>
            Layer.effect(
              LanguageModel.LanguageModel,
              LanguageModel.make({
                generateText: () => Effect.die("not used"),
                streamText: (options) =>
                  Stream.suspend(() => {
                    onCall?.()
                    const reply = script(options.prompt.content, options.tools.map((t) => t.name))
                    return "hang" in reply ? Stream.never : Stream.fromIterable(toParts(reply))
                  })
              })
            )
        })
      })
  })

/** Last message role/content helpers for scripts. */
export const last = (messages: ReadonlyArray<Prompt.Message>) => messages[messages.length - 1]!
export const lastUserText = (messages: ReadonlyArray<Prompt.Message>) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user") return m.content.map((p) => (p.type === "text" ? p.text : "")).join("")
  }
  return ""
}
export const toolResults = (messages: ReadonlyArray<Prompt.Message>) =>
  messages.flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result") : []))
