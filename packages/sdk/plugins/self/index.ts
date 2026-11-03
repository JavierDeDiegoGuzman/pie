/**
 * Plugin: tells the agent how it can change itself. It adds no tools: the
 * agent edits its plugins with read/edit/write, Pie applies the edits by
 * itself before the agent's next step (and tells it, or tells it why not), and
 * the agent inspects or undoes changes with the pie CLI through bash. Like
 * pi, the prompt only points to where things are; the details (how to write a
 * plugin, examples) are in docs the agent reads when needed.
 */
import { Effect } from "effect"
import { Plugin } from "@pie/sdk"
import * as path from "node:path"

export const guide = (paths: { home?: string | undefined; plugins?: string | undefined; sdk: string; templates: string; docs: string }) => {
  const pie = `node --no-warnings ${path.join(paths.sdk, "src", "cli.ts")}`
  const home = paths.home === undefined ? "" : ` --home ${paths.home}`
  return `You can change yourself: every part of you (tools, prompts, the web interface, models, this text) is a plugin,
and every plugin is a folder you can edit. Only do it when the user asks for a change to Pie itself.

- Your plugins: ${paths.plugins ?? "(none: this Pie has no home)"}
  One folder per plugin with an index.ts and any other files it needs; a plugin may have a README.md that explains
  it (read it before changing that plugin). plugins.json sets the load order and the disabled ones.
- Your edits apply by themselves before your next step: Pie validates the changed plugins and tells you they are
  applied, or, if one does not load, applies nothing and tells you the errors. When edits depend on each other,
  make them all in the same step.
- Edit the plugin that owns what you change; do not patch one plugin from another.
- Before writing a new plugin, read ${path.join(paths.docs, "PLUGINS.md")} (API and examples).
- Pie's SDK is read-only: ${paths.sdk}. Templates new homes are seeded from: ${paths.templates}.
- Every applied change records a snapshot of the plugins folder. To see them, or which plugins are loaded:
  ${pie} explain${home}
  To undo, restore a snapshot (it applies before your next step too):
  ${pie} rollback${home} --to <number> --reason "<why>"`
}

export default Plugin.define({
  id: "self",
  setup: (ctx) => ctx.prompt.transform((parts) => void parts.push({ key: "self/guide", text: guide(ctx.pie.paths) }))
})
