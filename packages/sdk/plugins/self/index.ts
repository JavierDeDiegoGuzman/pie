/**
 * Plugin: how the agent changes itself. Every plugin, this one included, is a
 * folder in the plugins folder that the agent edits with its ordinary tools
 * (read, edit, write); these tools apply and undo those edits:
 *
 *   restart          validate what changed, record a snapshot, apply it
 *   plugin_explain   what is loaded, from where, what is pending, history of snapshots
 *   plugin_rollback  put the plugins folder back to an earlier snapshot (undoable too)
 *
 * The prompt tells the agent where its plugins, the SDK (read-only), the
 * templates and the docs are, the way pi points to its own docs.
 */
import { Effect, Schema } from "effect"
import { defineTool, Plugin } from "@pie/sdk"

export const guide = (paths: { plugins?: string | undefined; sdk: string; templates: string; docs: string }) =>
  `You can change yourself: every part of you (tools, prompts, the web interface, models, this text) is a plugin,
and every plugin is a folder you can edit.

- Your plugins: ${paths.plugins ?? "(none: this Pie has no home)"}
  One folder per plugin with an index.ts (and any other files, e.g. web/shell.html). plugins.json sets the load
  order and the disabled ones. Read and edit these files with your normal tools (read, edit, write), then call
  restart to apply them: it validates the changed plugins and refuses (nothing applied) if one does not load.
- To change something, edit the plugin that owns it. Do not patch one plugin from another (e.g. hiding another
  plugin's elements with CSS): change the original. Use plugin_explain to see which plugin is which.
- Pie's SDK is read-only: ${paths.sdk} (you may read it; write/edit there are denied). Templates new homes are
  seeded from, and what safe mode loads: ${paths.templates}. Documentation: ${paths.docs}
  (read EVENTOS.md and CORE.md before writing a new kind of plugin).
- Everything is undoable: plugin_rollback restores an earlier snapshot of the plugins folder (the user can also
  do it from the web page, from the terminal with \`pie rollback\`, and Pie rolls back by itself if a change
  stops it from starting).

A plugin's index.ts imports only "effect", "@pie/sdk" and Node built-ins:

import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "@pie/sdk"

export default Plugin.define({
  id: "notes", // must equal the folder name
  setup: (ctx) => Effect.gen(function*() {
    yield* ctx.events({ added: Schema.Struct({ text: Schema.String }) })            // extend: event types
    const notes = yield* ctx.projection({                                            // derive: fold over events
      id: "notes", initial: () => [] as Array<string>, on: { "notes/added": (s, e) => [...s, e.text] }
    })
    yield* ctx.tools.transform((tools) => {
      tools.set("note_add", defineTool({
        name: "note_add", description: "Remember a note",
        parameters: Schema.Struct({ text: Schema.String }),
        idempotent: true, // false if running it twice could do harm
        execute: ({ text }, tool) => Effect.as(Effect.orDie(tool.emit("notes/added", { text })), { content: "saved" })
      }))
    })
    yield* ctx.hook("context", (event) =>                                            // view: what the model sees
      Effect.map(notes.get(event.sessionId), (list) => void event.system.push({ key: "notes", text: list.join("\\n") })))
  })
})

Events record facts, not values computed from the current state: tool calls of one step run in parallel, so
derive ids, counters and totals in the projection.`

export default Plugin.define({
  id: "self",
  setup: (ctx) =>
    Effect.gen(function*() {
      const plugins = ctx.pie.plugins
      const applied = () =>
        plugins.reload === "hot"
          ? "Applied: the changes are active from your next step."
          : "Pie restarts to apply them as soon as this step finishes; you continue right after."
      const rejected = (e: { readonly message: string }) => Effect.succeed({ content: e.message, isError: true })

      const restart = defineTool({
        name: "restart",
        description:
          "Apply your edits to the plugins folder: validates the changed plugins (nothing is applied if one fails, " +
          "and you get the errors), records a snapshot that can be rolled back, then reloads Pie with them.",
        parameters: Schema.Struct({ reason: Schema.String.annotate({ description: "What changed, for the history" }) }),
        idempotent: true,
        execute: ({ reason }) =>
          plugins.restart(reason).pipe(
            Effect.map(({ changed }) => ({
              content: changed.length === 0
                ? `No plugin changed since the last restart. ${applied()}`
                : `Changed: ${changed.join(", ")}. ${applied()}`
            })),
            Effect.catchTag("PluginRejected", rejected)
          )
      })

      const explain = defineTool({
        name: "plugin_explain",
        description: "Loaded plugins with their folder and files, plugins with edits not yet applied (pending), and the " +
          "history of snapshots with their numbers (for plugin_rollback).",
        parameters: Schema.Struct({}),
        idempotent: true,
        execute: () => Effect.map(plugins.explain, (e) => ({ content: JSON.stringify(e, null, 2) }))
      })

      const rollback = defineTool({
        name: "plugin_rollback",
        description: "Put the plugins folder back to snapshot #toSeq (see plugin_explain) and apply it. It is recorded " +
          "as a new snapshot, so it can be undone the same way.",
        parameters: Schema.Struct({ toSeq: Schema.Int, reason: Schema.String }),
        idempotent: true,
        execute: ({ reason, toSeq }) =>
          plugins.rollback(toSeq, reason).pipe(
            Effect.as({ content: `Plugins folder restored to snapshot #${toSeq}. ${applied()}` }),
            Effect.catchTag("PluginRejected", rejected)
          )
      })

      yield* ctx.tools.transform((tools) => {
        for (const tool of [restart, explain, rollback]) tools.set(tool.name, tool)
      })
      yield* ctx.prompt.transform((parts) => void parts.push({ key: "self/guide", text: guide(ctx.pie.paths) }))
    })
})
