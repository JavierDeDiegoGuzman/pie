# Writing a Pie plugin

A plugin is a folder in the plugins folder (`<home>/plugins/<id>/`) with an
`index.ts` whose default export is `Plugin.define({ id, setup })`. The id must
equal the folder name. `index.ts` imports only `"effect"`, `"pie-agent"` and
Node built-ins. Edit the files: Pie applies them before your next step (or tells
you why it could not).

## What `setup` can do (`ctx`)

| Level | API | Use it for |
|---|---|---|
| extend | `ctx.events({ added: schema })` | Your own event types (`<id>/added`) |
| derive | `ctx.projection({ id, initial, on })` | State folded from the session's events; recomputed, never stored |
| react | `ctx.react({ id, on, run })` | Do something after an event is in the log (durable cursor per session) |
| view | `ctx.hook("context", fn)` | What the model sees each step (`event.system`, `event.tools`) |
| policy | `ctx.hook("tool.before", fn)` | Allow or deny a tool call |
| tools | `ctx.tools.transform((tools) => tools.set(name, defineTool(…)))` | Tools for the model |
| prompt | `ctx.prompt.transform((parts) => parts.push({ key, text }))` | Parts of the system prompt |
| models | `ctx.models.transform(…)` | Models (see the opencode-go plugin) |
| web | `ctx.ui(fn)` | A browser module (see the web plugin's README.md) |
| options | `ctx.options` | Options given by the app for this plugin |
| Pie | `ctx.pie` | `plugins`, `registries`, `paths`, sessions |

Everything a plugin registers goes away with it; the events it emitted stay in
the log.

## Example

```ts
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "pie-agent"

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
      Effect.map(notes.get(event.sessionId), (list) => void event.system.push({ key: "notes", text: list.join("\n") })))
  })
})
```

## Rules

- Events record facts, not values computed from the current state: tool calls
  of one step run in parallel, so derive ids, counters and totals in the
  projection (the `todo` template is a full example with a web panel).
- Keep the tools the model sees few: each one costs context on every step. Prefer
  doing things with `bash` unless a tool adds something bash cannot (durability,
  events, a policy).
- More detail on events and the core: `EVENTS.md` and `CORE.md` in this folder.
