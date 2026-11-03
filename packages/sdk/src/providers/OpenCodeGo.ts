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
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FileSystem, Path } from "effect"
import type { LanguageModel } from "effect/ai"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export const API_URL = "https://opencode.ai/zen/go/v1"
export const DEFAULT_MODEL = "deepseek-v4.1-flash"
export const USER_AGENT = "pie/0.0.0"

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
  })).pipe(Layer.provide(FetchHttpClient.layer))

export const languageModel = (
  options: Options & { readonly model?: string | undefined }
): Layer.Layer<LanguageModel.LanguageModel, unknown, FileSystem.FileSystem | Path.Path> =>
  OpenAiLanguageModel.layer({ model: options.model ?? DEFAULT_MODEL }).pipe(Layer.provide(clientLayer(options)))
