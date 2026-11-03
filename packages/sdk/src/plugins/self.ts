/**
 * Built-in plugin: lets the agent extend itself through the configuration log.
 *
 *   plugin_install  validate + install (or update) a plugin from its source
 *   plugin_list     what is loaded, what the agent installed, what is disabled
 *   plugin_remove   remove an installed plugin or disable a built-in one
 *   plugin_enable   re-enable a disabled plugin
 *   plugin_history  versions of a plugin in the configuration log
 *   plugin_restore  go back to an earlier version
 *
 * Every change is an event in the configuration log. Protected plugins
 * (this one, by default) cannot be removed or overwritten.
 */
import { Effect, Schema } from "effect"
import type { ConfigLog } from "../core/ConfigLog.ts"
import * as Plugin from "../core/Plugin.ts"
import type { PluginHost } from "../core/PluginHost.ts"
import type { Plugins } from "../core/Plugins.ts"
import { defineTool } from "../core/Registry.ts"

export const GUIDE = `You can extend yourself with plugins. A plugin is a TypeScript module whose default export is
Plugin.define({ id, setup }). setup is an Effect that registers things; everything it registers is removed
when the plugin is replaced or removed. Install plugins with plugin_install; their tools are available from
your next step. Only "effect", "@pie/sdk" and Node built-ins (node:fs, node:child_process, ...) can be imported.

import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "@pie/sdk"

export default Plugin.define({
  id: "notes",
  setup: (ctx) => Effect.gen(function*() {
    // extend: your own event types, stored in the session log (they survive restarts and follow branches)
    yield* ctx.events({ added: Schema.Struct({ text: Schema.String }) })
    // derive: state is a fold over the session's events, never stored separately
    const notes = yield* ctx.projection({
      id: "notes",
      initial: () => [] as Array<string>,
      on: { "notes/added": (s, e) => [...s, e.text] }
    })
    yield* ctx.tools.transform((tools) => {
      tools.set("note_add", defineTool({
        name: "note_add",
        description: "Remember a note",
        parameters: Schema.Struct({ text: Schema.String }),
        idempotent: true, // false if running it twice could do harm
        execute: ({ text }, tool) => Effect.as(Effect.orDie(tool.emit("notes/added", { text })), { content: "saved" })
      }))
    })
    // view: show the state to the model on every call
    yield* ctx.hook("context", (event) =>
      Effect.map(notes.get(event.sessionId), (list) => void event.system.push({ key: "notes", text: "Notes:\\n" + list.join("\\n") })))
  })
})

Events record facts, not values computed from the current state: tool calls of one step run in parallel,
so derive ids, counters and totals in the projection instead of reading the state and emitting the result.

Also available: ctx.prompt.transform((parts) => parts.push({ key, text })) for fixed system prompt text;
ctx.react({ id, on: ["tool/finished"], run: (event, r) => Effect }) to act after events (never blocks the agent);
ctx.hook("tool.before" | "tool.after", ...) is reserved for protected plugins' policy and may be denied to you.`

export const make = (options: {
  readonly plugins: Plugins["Service"]
  readonly host: PluginHost["Service"]
  readonly config: ConfigLog["Service"]
}) => {
  const { config, host, plugins } = options
  const rejected = (e: { readonly message: string }) => Effect.succeed({ content: e.message, isError: true })
  const later = plugins.reload === "hot"
    ? "It is active from your next step."
    : "It becomes active after a restart, which happens automatically when this step finishes."

  const install = defineTool({
    name: "plugin_install",
    description: "Validate and install (or update) a plugin from its full TypeScript source. Returns the error if it does not load; " +
      "the previous version, if any, keeps running.",
    parameters: Schema.Struct({ source: Schema.String.annotate({ description: "Full TypeScript source of the plugin module" }) }),
    idempotent: true,
    execute: ({ source }) =>
      plugins.install(source).pipe(
        Effect.map(({ hash, id }) => ({ content: `Plugin "${id}" installed (version ${hash}). ${later}` })),
        Effect.catchTag("PluginRejected", (e) => rejected({ message: `Plugin rejected: ${e.message}` }))
      )
  })

  const list = defineTool({
    name: "plugin_list",
    description: "List loaded plugins, plugins you installed (with their version) and disabled plugins.",
    parameters: Schema.Struct({}),
    idempotent: true,
    execute: () =>
      Effect.gen(function*() {
        const loaded = yield* host.list
        const state = yield* plugins.config
        return {
          content: JSON.stringify({
            loaded: loaded.map((p) => ({ id: p.id, source: p.source })),
            installed: [...state.installed.values()].map(({ hash, id }) => ({ id, version: hash })),
            disabled: [...state.disabled]
          }, null, 2)
        }
      })
  })

  const remove = defineTool({
    name: "plugin_remove",
    description: "Remove a plugin you installed, or disable a built-in one.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.remove(id).pipe(Effect.as({ content: `Plugin "${id}" removed. ${later}` }), Effect.catchTag("PluginRejected", rejected))
  })

  const enable = defineTool({
    name: "plugin_enable",
    description: "Enable a plugin that was disabled.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.enable(id).pipe(Effect.as({ content: `Plugin "${id}" enabled. ${later}` }), Effect.catchTag("PluginRejected", rejected))
  })

  const history = defineTool({
    name: "plugin_history",
    description: "Versions of a plugin in the configuration log, oldest first.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      Effect.gen(function*() {
        const versions = (yield* config.history)
          .filter((e) => (e.data as { id: string }).id === id)
          .map((e) => ({ seq: e.seq, type: e.type, at: new Date(e.createdAt).toISOString(), version: (e.data as { hash?: string }).hash }))
        return { content: versions.length === 0 ? `No history for "${id}".` : JSON.stringify(versions, null, 2) }
      })
  })

  const restore = defineTool({
    name: "plugin_restore",
    description: "Reinstall an earlier version of a plugin (see plugin_history).",
    parameters: Schema.Struct({ id: Schema.String, version: Schema.String }),
    idempotent: true,
    execute: ({ id, version }) =>
      plugins.restore(id, version).pipe(
        Effect.as({ content: `Plugin "${id}" restored to version ${version}. ${later}` }),
        Effect.catchTag("PluginRejected", rejected)
      )
  })

  return Plugin.define({
    id: "self",
    setup: (ctx) =>
      Effect.gen(function*() {
        yield* ctx.tools.transform((tools) => {
          for (const tool of [install, list, remove, enable, history, restore]) tools.set(tool.name, tool)
        })
        yield* ctx.prompt.transform((parts) => void parts.push({ key: "self/guide", text: GUIDE }))
      })
  })
}
