/**
 * Built-in plugin: lets the agent extend itself. Created by Pie.layer when at
 * least one plugin directory is configured; plugins are written to the first.
 *
 *   plugin_list    loaded plugins and plugin files (with load errors)
 *   plugin_write   write/replace a plugin file and load it now
 *   plugin_remove  delete a plugin file and unload it
 *
 * New tools appear in the next model call of the same run. A plugin that fails
 * to load leaves the previous version running and the error is returned.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Schema } from "effect"
import * as Plugin from "../core/Plugin.ts"
import type { PluginHost } from "../core/PluginHost.ts"
import type { PluginLoader } from "../core/PluginLoader.ts"
import { defineTool } from "../core/Registry.ts"

export const GUIDE = `You can extend yourself with plugins. A plugin is a TypeScript file whose default export is
Plugin.define({ id, setup }). setup is an Effect that registers tools, system prompt parts and hooks;
everything it registers is removed when the plugin is replaced or removed. Write plugins with plugin_write;
they load immediately and their tools are available from your next step. Example:

import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "@pie/sdk"

export default Plugin.define({
  id: "word-count",
  setup: (ctx) =>
    ctx.tools.transform((tools) => {
      tools.set("word_count", defineTool({
        name: "word_count",
        description: "Count words in a text",
        parameters: Schema.Struct({ text: Schema.String }),
        idempotent: true, // false if running it twice could do harm
        execute: ({ text }) => Effect.succeed({ content: String(text.split(/\\s+/).filter(Boolean).length) })
      }))
    })
})

Other registrations: ctx.prompt.transform((parts) => parts.push({ key, text })) adds system prompt text;
ctx.hook("tool.before" | "tool.after" | "context", (event) => Effect) intercepts tool calls or model calls.
Only "effect" and "@pie/sdk" can be imported, plus Node built-ins (node:fs, node:child_process, ...).`

const NAME = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)).annotate({
  description: "File name without extension: lowercase letters, digits and dashes"
})

export const make = (options: {
  readonly host: PluginHost["Service"]
  readonly loader: PluginLoader["Service"]
  readonly directory: string
}) => {
  const { directory, host, loader } = options
  const fileOf = (name: string) => path.join(directory, `${name}.ts`)

  const list = defineTool({
    name: "plugin_list",
    description: "List loaded plugins and plugin files, including load errors.",
    parameters: Schema.Struct({}),
    idempotent: true,
    execute: () =>
      Effect.gen(function*() {
        const loaded = yield* host.list
        const files = yield* loader.status
        return {
          content: JSON.stringify({ loaded, files: files.map(({ error, file, pluginId }) => ({ file, pluginId, error })) }, null, 2)
        }
      })
  })

  const write = defineTool({
    name: "plugin_write",
    description: `Write (or replace) a plugin file in ${directory} and load it immediately. Returns the load error if it fails; ` +
      `in that case the previous version keeps running.`,
    parameters: Schema.Struct({
      name: NAME,
      source: Schema.String.annotate({ description: "Full TypeScript source of the plugin module" })
    }),
    idempotent: true,
    execute: ({ name, source }) =>
      Effect.gen(function*() {
        yield* Effect.promise(async () => {
          await fs.mkdir(directory, { recursive: true })
          await fs.writeFile(fileOf(name), source)
        })
        const status = (yield* loader.sync(directory)).find((s) => s.file === fileOf(name))
        if (status?.error !== undefined) return { content: `Plugin failed to load:\n${status.error}`, isError: true }
        return { content: `Plugin "${status?.pluginId}" loaded from ${fileOf(name)}.` }
      })
  })

  const remove = defineTool({
    name: "plugin_remove",
    description: `Delete a plugin file from ${directory} and unload it.`,
    parameters: Schema.Struct({ name: NAME }),
    idempotent: true,
    execute: ({ name }) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => fs.rm(fileOf(name), { force: true }))
        yield* loader.sync(directory)
        return { content: `Removed ${fileOf(name)}.` }
      })
  })

  return Plugin.define({
    id: "self",
    setup: (ctx) =>
      Effect.gen(function*() {
        yield* ctx.tools.transform((tools) => {
          for (const tool of [list, write, remove]) tools.set(tool.name, tool)
        })
        yield* ctx.prompt.transform((parts) => {
          parts.push({ key: "self/guide", text: GUIDE })
        })
      })
  })
}
