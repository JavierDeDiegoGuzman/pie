/**
 * Built-in plugin: lets the agent extend itself through the configuration log.
 *
 *   plugin_install   validate + install (or update) a plugin from its source
 *   plugin_try/keep  load in this process only; make it permanent
 *   plugin_explain   what is loaded, from where, and the history of changes
 *   plugin_remove    remove an installed plugin or disable a built-in one
 *   plugin_enable    re-enable a disabled plugin
 *   plugin_restore   one plugin back to an earlier version
 *   plugin_rollback  the whole configuration back to an earlier point
 *
 * Every change is an event in the configuration log. Nothing is protected by
 * default, this plugin included: the safety net is rollback (also from the
 * terminal with `pie rollback`, and automatic when a change stops Pie from
 * booting).
 */
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import * as Plugin from "../core/Plugin.ts"
import type { Plugins } from "../core/Plugins.ts"
import { defineTool } from "../core/Registry.ts"

export const GUIDE = `Pie's own source code and installation are not your workspace: never edit them to change yourself.
Change yourself (tools, prompts, the web UI, any behaviour) only through plugins, as below: every plugin change is
recorded and can be undone, while editing Pie's files would bypass that.

You can extend yourself with plugins. A plugin is a TypeScript module whose default export is
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

Everything is modifiable, built-ins included: installing a plugin with a built-in's id replaces it. Read any
plugin's code with plugin_source (for example "web": its page shell holds the header). A replacement can reuse
the built-in, e.g. the web plugin with another page: import { WebPlugin } from "@pie/sdk" and call
WebPlugin.setup({ ...ctx, options: { ...ctx.options, shell: "<!doctype html>..." } }). Prefer
plugin_try for experiments and plugin_keep once it works; plugin_rollback undoes any change.

Also available: ctx.prompt.transform((parts) => parts.push({ key, text })) for fixed system prompt text;
ctx.react({ id, on: ["tool/finished"], run: (event, r) => Effect }) to act after events (never blocks the agent);
ctx.hook("tool.before" | "tool.after", ...) is reserved for protected plugins' policy and may be denied to you.`

export const make = (options: { readonly plugins: Plugins["Service"] }) => {
  const { plugins } = options
  const rejected = (e: { readonly message: string }) => Effect.succeed({ content: e.message, isError: true })
  const later = () =>
    plugins.reload === "hot"
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
        Effect.map(({ hash, id }) => ({ content: `Plugin "${id}" installed (version ${hash}). ${later()}` })),
        Effect.catchTag("PluginRejected", (e) => rejected({ message: `Plugin rejected: ${e.message}` }))
      )
  })

  const tryTool = defineTool({
    name: "plugin_try",
    description: "Validate and load a plugin in this process only, without making it permanent. Use plugin_keep to persist it; " +
      "a restart or plugin_remove discards it.",
    parameters: Schema.Struct({ source: Schema.String.annotate({ description: "Full TypeScript source of the plugin module" }) }),
    idempotent: true,
    execute: ({ source }) =>
      plugins.try(source).pipe(
        Effect.map(({ hash, id }) => ({ content: `Plugin "${id}" loaded for trial (version ${hash}). It is active from your next step.` })),
        Effect.catchTag("PluginRejected", (e) => rejected({ message: `Plugin rejected: ${e.message}` }))
      )
  })

  const keep = defineTool({
    name: "plugin_keep",
    description: "Make a plugin you are trying (plugin_try) permanent.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.keep(id).pipe(Effect.as({ content: `Plugin "${id}" is now permanent.` }), Effect.catchTag("PluginRejected", rejected))
  })

  const explain = defineTool({
    name: "plugin_explain",
    description: "What is loaded and where each plugin comes from (built-in, installed, trial), what is disabled, and the " +
      "history of configuration changes with their numbers (use them with plugin_rollback).",
    parameters: Schema.Struct({}),
    idempotent: true,
    execute: () => Effect.map(plugins.explain, (e) => ({ content: JSON.stringify(e, null, 2) }))
  })

  const source = defineTool({
    name: "plugin_source",
    description: "Read the source files of a loaded plugin, built-ins included (e.g. \"web\" with its page shell, " +
      "\"web-chat\", \"coding-tools\"). To change one, install a plugin with the same id: it replaces the built-in " +
      "and stays undoable. Never look for or edit Pie's files on disk.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.source(id).pipe(
        Effect.map((files) => ({
          content: Object.entries(files).map(([name, text]) => `=== ${name} ===\n${text}`).join("\n\n")
        })),
        Effect.catchTag("PluginRejected", rejected)
      )
  })

  const remove = defineTool({
    name: "plugin_remove",
    description: "Remove a plugin you installed or are trying, or disable a built-in one.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.remove(id).pipe(Effect.as({ content: `Plugin "${id}" removed. ${later()}` }), Effect.catchTag("PluginRejected", rejected))
  })

  const enable = defineTool({
    name: "plugin_enable",
    description: "Enable a plugin that was disabled.",
    parameters: Schema.Struct({ id: Schema.String }),
    idempotent: true,
    execute: ({ id }) =>
      plugins.enable(id).pipe(Effect.as({ content: `Plugin "${id}" enabled. ${later()}` }), Effect.catchTag("PluginRejected", rejected))
  })

  const restore = defineTool({
    name: "plugin_restore",
    description: "Reinstall an earlier version of one plugin (versions in plugin_explain).",
    parameters: Schema.Struct({ id: Schema.String, version: Schema.String }),
    idempotent: true,
    execute: ({ id, version }) =>
      plugins.restore(id, version).pipe(
        Effect.as({ content: `Plugin "${id}" restored to version ${version}. ${later()}` }),
        Effect.catchTag("PluginRejected", rejected)
      )
  })

  const rollback = defineTool({
    name: "plugin_rollback",
    description: "Put the whole plugin configuration back to how it was right after change #toSeq (0: built-ins only). " +
      "It is recorded as a change too, so it can be undone.",
    parameters: Schema.Struct({ toSeq: Schema.Int, reason: Schema.String }),
    idempotent: true,
    execute: ({ reason, toSeq }) =>
      plugins.rollback(toSeq, reason).pipe(
        Effect.as({ content: `Configuration rolled back to #${toSeq}. ${later()}` }),
        Effect.catchTag("PluginRejected", rejected)
      )
  })

  return Plugin.define({
    id: "self",
    sourceFiles: [fileURLToPath(import.meta.url)],
    setup: (ctx) =>
      Effect.gen(function*() {
        yield* ctx.tools.transform((tools) => {
          for (const tool of [install, tryTool, keep, explain, source, remove, enable, restore, rollback]) tools.set(tool.name, tool)
        })
        yield* ctx.prompt.transform((parts) => void parts.push({ key: "self/guide", text: GUIDE }))
      })
  })
}
