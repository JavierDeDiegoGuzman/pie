import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Schema } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import TodoPlugin from "../src/todo/index.ts"
import { codingTools } from "../src/index.ts"
import { defineTool, type LogEvent, Pie, Plugin } from "pie-agent"
import { testHome } from "./support/home.ts"
import { FAKE_MODEL, fakeModelPlugin, HANG, last, lastUserText, type Reply, toolResults } from "./support/fake-model.ts"

const addTool = Plugin.define({
  id: "math",
  setup: (ctx) =>
    ctx.tools.transform((tools) => {
      tools.set("add", defineTool({
        name: "add",
        description: "Add two integers",
        parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
        idempotent: true,
        execute: ({ a, b }) => Effect.succeed({ content: String(a + b) })
      }))
    })
})

type Messages = Parameters<Parameters<typeof fakeModelPlugin>[0]>[0]

/** Calls `add` once per user message, then answers with the sum. */
const mathScript = (messages: Messages): Reply => {
  const results = toolResults(messages)
  if (last(messages).role === "tool") return { text: `result ${String(results[results.length - 1]?.result)}` }
  return { tools: [{ name: "add", params: { a: 19, b: 23 } }] }
}

const run = <A, E>(effect: Effect.Effect<A, E, Pie.Pie>, plugins: ReadonlyArray<Plugin.Plugin>) =>
  effect.pipe(Effect.provide(Pie.layer({ plugins })), Effect.scoped)


const CONVERSATION = new Set(["user", "model/responded", "tool/finished", "run/ended"])
const conversation = (events: ReadonlyArray<LogEvent>) => events.filter((e) => CONVERSATION.has(e.type)).map((e) => e.type)
const data = <T>(events: ReadonlyArray<LogEvent>, type: string) => events.filter((e) => e.type === type).map((e) => e.data as T)

describe("plugin state as events", () => {
  const todoScript = (messages: Messages): Reply => {
    const text = lastUserText(messages)
    if (last(messages).role === "tool") return { text: "ok" }
    if (text.startsWith("add ")) return { tools: [{ name: "todo", params: { action: "add", text: text.slice(4) } }] }
    return { text: "nothing to do" }
  }

  it.live("todo: events in the log, list as a projection, visible to the model, follows branches", () => {
    const systems: Array<string> = []
    const recordingModel = fakeModelPlugin((messages) => {
      const system = messages.find((m) => m.role === "system")
      systems.push(system?.role === "system" ? system.content : "")
      return todoScript(messages)
    })
    return run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("add buy milk")
        yield* session.awaitIdle
        const branchPoint = (yield* session.events).at(-1)!.id
        yield* session.prompt("add write tests")
        yield* session.awaitIdle

        const events = yield* session.events
        expect(data<{ text: string }>(events, "todo/added")).toEqual([{ text: "buy milk" }, { text: "write tests" }])
        // the model sees the list (view) on the following call
        expect(systems.at(-1)).toContain("#2 write tests")

        // navigate back: the list is the one of that branch
        yield* session.navigate(branchPoint)
        yield* session.prompt("add call mom")
        yield* session.awaitIdle
        const branch = yield* session.events
        expect(data<{ text: string }>(branch, "todo/added").map((t) => t.text)).toEqual(["buy milk", "call mom"])
        expect(systems.at(-1)).toContain("#1 buy milk") // the view of this branch
        expect(systems.at(-1)).not.toContain("write tests")
        // a program shows the list through the public API
        const todo = yield* session.projection<{ items: ReadonlyArray<{ text: string }> }>("todo")
        expect(todo?.items.map((i) => i.text)).toEqual(["buy milk", "call mom"])
      }),
      [recordingModel, TodoPlugin]
    )
  })

  it.live("todo: parallel adds in one step get distinct ids (events record facts, the projection numbers them)", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("two at once")
        yield* session.awaitIdle
        const listed = data<{ name: string; content: string }>(yield* session.events, "tool/finished").at(-1)
        expect(listed?.content).toBe("[ ] #1 a\n[ ] #2 b")
      }),
      [
        fakeModelPlugin((messages) => {
          const n = toolResults(messages).length
          if (n === 0) {
            return {
              tools: [
                { name: "todo", params: { action: "add", text: "a" } },
                { name: "todo", params: { action: "add", text: "b" } }
              ]
            }
          }
          if (n === 2) return { tools: [{ name: "todo", params: { action: "list" } }] }
          return { text: "done" }
        }),
        TodoPlugin
      ]
    ))

  it.live("react: runs after its events are in the log and can emit its own events", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* Effect.sleep("50 millis") // let the reaction register its cursor ("from now")
        yield* session.prompt("sum")
        yield* session.awaitIdle
        yield* Effect.sleep("100 millis")
        const all = yield* session.events
        expect(data<{ tool: string }>(all, "audit/tool")).toEqual([{ tool: "add" }])
      }),
      [
        fakeModelPlugin(mathScript),
        addTool,
        Plugin.define({
          id: "audit",
          setup: (ctx) =>
            Effect.gen(function*() {
              yield* ctx.events({ tool: Schema.Struct({ tool: Schema.String }) })
              yield* ctx.react({
                id: "audit-tools",
                on: ["tool/finished"],
                run: (event, r) => Effect.orDie(r.emit("audit/tool", { tool: (event.data as { name: string }).name }))
              })
            })
        })
      ]
    ))
})

describe("the SDK guard", () => {
  it.live("writes inside the installed SDK are denied", () => {
    const home = testHome("guard")
    const target = path.join(import.meta.dirname, "..", "..", "sdk", "src", "index.ts")
    return Effect.gen(function*() {
      const pie = yield* Pie.Pie
      const session = yield* pie.create({ cwd: home, model: FAKE_MODEL })
      yield* session.prompt("edit the sdk")
      yield* session.awaitIdle
      const [result] = data<{ isError: boolean; content: string }>(yield* session.events, "tool/finished")
      expect(result).toMatchObject({ isError: true })
      expect(result?.content).toContain("read-only")
    }).pipe(
      Effect.provide(Pie.layer({
        plugins: [
          codingTools,
          fakeModelPlugin((messages) =>
            toolResults(messages).length === 0
              ? { tools: [{ name: "write", params: { path: target, content: "oops" } }] }
              : { text: "ok" }
          )
        ]
      })),
      Effect.scoped
    )
  })
})
