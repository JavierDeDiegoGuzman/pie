/**
 * OpenCode Go: OpenAI-compatible Chat Completions gateway
 * (https://opencode.ai/zen/go/v1).
 *
 * Per https://opencode.ai/v2/docs/console/go/#where-can-i-use-it, third-party
 * clients must identify themselves with their own User-Agent and send a
 * stable per-conversation `x-opencode-session`. Pie sends `pie/<version>` and
 * its own session id; it never impersonates OpenCode or another client.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { VERSION } from "pie-agent"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FileSystem, Path } from "effect"
import type { LanguageModel } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export const API_URL = "https://opencode.ai/zen/go/v1"
export const DEFAULT_MODEL = "deepseek-v4.1-flash"
export const USER_AGENT = `pie/${VERSION}`

const PiAuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Struct({ key: Schema.String }))
})

/**
 * Resolves the API key: `OPENCODE_GO_API_KEY`, then the credential stored by
 * pi in `~/.pi/agent/auth.json`.
 */
export const apiKey = Effect.gen(function*() {
  const fromEnv = yield* Config.option(Config.Redacted("OPENCODE_GO_API_KEY"))
  if (Option.isSome(fromEnv)) return fromEnv.value
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.String("HOME")
  const raw = yield* fs.readFileString(path.join(home, ".pi", "agent", "auth.json"))
  const auth = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PiAuthFile))(raw)
  const entry = auth["opencode-go"]
  if (entry === undefined) {
    return yield* Effect.fail(new Error("No OpenCode Go credential: set OPENCODE_GO_API_KEY or log in with pi"))
  }
  return Redacted.make(entry.key)
})

export interface Options {
  /** Stable per-conversation id sent as `x-opencode-session`: the Pie session id. */
  readonly sessionId: string
  readonly apiKey?: Redacted.Redacted<string> | undefined
}

/**
 * Some backends behind OpenCode Go send tool-call continuation fragments as
 * `{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":"…"}}`.
 * `@effect/ai-openai-compat` accepts a null `id` and `name` but not a null
 * `type`, so it drops the whole chunk and the call arrives with no arguments.
 * Removing null fields from tool-call deltas keeps every fragment.
 */
export const normalizeChunk = (json: string): string => {
  if (!json.includes('"tool_calls"')) return json
  let chunk: { choices?: Array<{ delta?: { tool_calls?: Array<Record<string, unknown>> | null } }> }
  try {
    chunk = JSON.parse(json)
  } catch {
    return json
  }
  const dropNulls = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o)) if (o[k] === null) delete o[k]
  }
  for (const choice of chunk.choices ?? []) {
    for (const call of choice.delta?.tool_calls ?? []) {
      dropNulls(call)
      if (call.function && typeof call.function === "object") dropNulls(call.function as Record<string, unknown>)
    }
  }
  return JSON.stringify(chunk)
}

/** Rewrites each `data: …` line of a server-sent-events body with `normalizeChunk`. */
const normalizeSse = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  const line = (l: string) => l.startsWith("data: ") && l !== "data: [DONE]" ? `data: ${normalizeChunk(l.slice(6))}` : l
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop()!
      if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(line).join("\n") + "\n"))
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending.length > 0) controller.enqueue(encoder.encode(line(pending)))
    }
  }))
}

const normalizingFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response
  return new Response(normalizeSse(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export const clientLayer = (options: Options) =>
  Layer.unwrap(Effect.gen(function*() {
    const key = options.apiKey ?? (yield* apiKey)
    return OpenAiClient.layer({
      apiKey: key,
      apiUrl: API_URL,
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({
        "user-agent": USER_AGENT,
        "x-opencode-session": options.sessionId
      }))
    })
  })).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, normalizingFetch))
  )

export const languageModel = (
  options: Options & { readonly model?: string | undefined }
): Layer.Layer<LanguageModel.LanguageModel, unknown, FileSystem.FileSystem | Path.Path> =>
  OpenAiLanguageModel.layer({ model: options.model ?? DEFAULT_MODEL }).pipe(Layer.provide(clientLayer(options)))
