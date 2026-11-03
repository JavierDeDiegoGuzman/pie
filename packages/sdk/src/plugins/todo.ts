/**
 * Example plugin: a todo list kept as events (not built in by default).
 *
 *   extend   todo/added, todo/toggled, todo/cleared in the session log
 *   derive   the list is a fold over the current branch: after navigating to
 *            an earlier point, the list is the one of that branch
 *   view     open items are shown to the model on every call
 *
 * Events record facts, not values derived from the state: `added` carries only
 * the text and the projection numbers items in log order. Tools of one step
 * run in parallel, so two `add` calls that read the state and chose "the next
 * id" themselves would both pick the same one.
 *
 * Removing the plugin removes the tool and the view; the events stay in the
 * log, so installing it again brings the list back.
 */
import { Effect, Schema } from "effect"
import * as Plugin from "../core/Plugin.ts"
import { defineTool } from "../core/Registry.ts"

export interface Item {
  readonly id: number
  readonly text: string
  readonly done: boolean
}

export interface TodoState {
  readonly items: ReadonlyArray<Item>
  readonly nextId: number
}

const render = (state: TodoState) =>
  state.items.length === 0
    ? "(empty)"
    : state.items.map((i) => `${i.done ? "[x]" : "[ ]"} #${i.id} ${i.text}`).join("\n")

export default Plugin.define({
  id: "todo",
  setup: (ctx) =>
    Effect.gen(function*() {
      yield* ctx.events({
        added: Schema.Struct({ text: Schema.String }),
        toggled: Schema.Struct({ id: Schema.Int }),
        cleared: Schema.Struct({})
      })

      const todos = yield* ctx.projection<TodoState>({
        id: "todo",
        initial: () => ({ items: [], nextId: 1 }),
        on: {
          "todo/added": (s, e: { text: string }) => ({
            items: [...s.items, { id: s.nextId, text: e.text, done: false }],
            nextId: s.nextId + 1
          }),
          "todo/toggled": (s, e: { id: number }) => ({
            ...s,
            items: s.items.map((i) => (i.id === e.id ? { ...i, done: !i.done } : i))
          }),
          "todo/cleared": (s) => ({ ...s, items: [] })
        }
      })

      yield* ctx.tools.transform((tools) => {
        tools.set("todo", defineTool({
          name: "todo",
          description: "Manage a todo list for this session: list, add an item, toggle one done/undone, or clear all.",
          parameters: Schema.Struct({
            action: Schema.Literals(["list", "add", "toggle", "clear"]),
            text: Schema.optional(Schema.String).annotate({ description: "Item text (add)" }),
            id: Schema.optional(Schema.Int).annotate({ description: "Item id (toggle)" })
          }),
          idempotent: true,
          execute: ({ action, id, text }, tool) =>
            Effect.gen(function*() {
              const state = yield* todos.get(tool.sessionId)
              switch (action) {
                case "add":
                  if (!text) return { content: "text is required", isError: true }
                  yield* Effect.orDie(tool.emit("todo/added", { text }))
                  return { content: `Added "${text}"` }
                case "toggle":
                  if (id === undefined || !state.items.some((i) => i.id === id)) return { content: `No item #${id}`, isError: true }
                  yield* Effect.orDie(tool.emit("todo/toggled", { id }))
                  return { content: `Toggled #${id}` }
                case "clear":
                  yield* Effect.orDie(tool.emit("todo/cleared", {}))
                  return { content: "Cleared" }
                case "list":
                  return { content: render(state) }
              }
            })
        }))
      })

      yield* ctx.hook("context", (event) =>
        Effect.map(todos.get(event.sessionId), (state) => {
          if (state.items.some((i) => !i.done)) event.system.push({ key: "todo", text: `Your todo list:\n${render(state)}` })
        }))
    })
})
