/**
 * Built-in plugin: registers OpenCode Go models in the model registry.
 * Options: { models?: string[] } to override the default model list.
 */
import { Effect, FileSystem, Layer, Path } from "effect"
import * as Plugin from "../core/Plugin.ts"
import * as OpenCodeGo from "../providers/OpenCodeGo.ts"

export const DEFAULT_MODELS = ["deepseek-v4.1-flash", "deepseek-v4-pro", "kimi-k3", "glm-5.3", "qwen3.8-max"]

export default Plugin.define({
  id: "opencode-go",
  setup: (ctx) =>
    Effect.gen(function*() {
      const platform = Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem),
        Layer.succeed(Path.Path, yield* Path.Path)
      )
      const models = Array.isArray(ctx.options.models)
        ? ctx.options.models.filter((m): m is string => typeof m === "string")
        : DEFAULT_MODELS
      yield* ctx.models.transform((registry) => {
        for (const model of models) {
          registry.set(`opencode-go/${model}`, {
            id: `opencode-go/${model}`,
            provider: "opencode-go",
            model,
            layer: ({ sessionId }) =>
              OpenCodeGo.languageModel({ sessionId, model }).pipe(Layer.provide(platform))
          })
        }
      })
    })
})
