import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Schema } from "effect"
import * as path from "node:path"
import { defineTool, type LogEvent, Pie, Plugin, Storage, TodoPlugin } from "../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, last, lastUserText, type Reply, toolResults } from "./support/fake-model.ts"

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

const cacheDirectory = path.join(import.meta.dirname, ".tmp", "plugin-cache")

const run = <A, E>(effect: Effect.Effect<A, E, Pie.Pie>, plugins: ReadonlyArray<Plugin.Plugin>, selfModify = false) =>
  effect.pipe(
    Effect.provide(Pie.layer({ storage: Storage.memory, plugins, selfModify, pluginCacheDirectory: cacheDirectory })),
    Effect.scoped
  )

const CONVERSATION = new Set(["user", "model/responded", "tool/finished", "run/ended"])
const conversation = (events: ReadonlyArray<LogEvent>) => events.filter((e) => CONVERSATION.has(e.type)).map((e) => e.type)
const data = <T>(events: ReadonlyArray<LogEvent>, type: string) => events.filter((e) => e.type === type).map((e) => e.data as T)

describe("agent loop over the event log", () => {
  it.live("prompt → tool call → tool result → answer; every step is an event", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("sum please")
        expect(yield* session.awaitIdle).toMatchObject({ status: "completed" })
        const events = yield* session.events
        expect(events.map((e) => e.type)).toEqual([
          "run/started",
          "user",
          "model/requested",
          "model/responded",
          "tool/started",
          "tool/finished",
          "model/requested",
          "model/responded",
          "run/ended"
        ])
        const [, second] = data<{ text: string }>(events, "model/responded")
        expect(second?.text).toBe("result 42")
        // model-visible means logged: the request records the tools that were offered
        expect(data<{ tools: Array<string> }>(events, "model/requested")[0]?.tools).toEqual(["add"])
      }),
      [fakeModelPlugin(mathScript), addTool]
    ))

  it.live("a second prompt while running fails; followUp is absorbed into the same run", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("first")
        expect((yield* Effect.flip(session.prompt("second")))._tag).toBe("SessionBusy")
        yield* session.prompt("and then this", { streamingBehavior: "followUp" })
        yield* session.awaitIdle
        const events = yield* session.events
        expect(data<{ text: string }>(events, "user").map((u) => u.text)).toEqual(["first", "and then this"])
        expect(data(events, "run/ended")).toHaveLength(1)
      }),
      [fakeModelPlugin(mathScript), addTool]
    ))

  it.live("steering is delivered after the current tool calls, before the next model call", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const slow = Plugin.define({
        id: "slow",
        setup: (ctx) =>
          ctx.tools.transform((tools) => {
            tools.set("wait", defineTool({
              name: "wait",
              description: "waits",
              parameters: Schema.Struct({}),
              idempotent: true,
              execute: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as({ content: "waited" }))
            }))
          })
      })
      const seen: Array<string> = []
      const script = (messages: Messages): Reply => {
        seen.push(lastUserText(messages))
        return last(messages).role === "user" && lastUserText(messages) === "go"
          ? { tools: [{ name: "wait", params: {} }] }
          : { text: "ok" }
      }
      yield* run(
        Effect.gen(function*() {
          const pie = yield* Pie.Pie
          const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
          yield* session.prompt("go")
          yield* Deferred.await(started)
          yield* session.steer("change of plans")
          yield* Deferred.succeed(gate, undefined)
          yield* session.awaitIdle
          expect(conversation(yield* session.events)).toEqual([
            "user",
            "model/responded",
            "tool/finished",
            "user",
            "model/responded",
            "run/ended"
          ])
          expect(seen).toEqual(["go", "change of plans"])
        }),
        [fakeModelPlugin(script), slow]
      )
    }))

  it.live("tool-call ids repeated across turns (some providers do) do not collide", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("twice")
        expect(yield* session.awaitIdle).toMatchObject({ status: "completed" })
        expect(data(yield* session.events, "tool/finished")).toHaveLength(2)
      }),
      [
        fakeModelPlugin((messages) =>
          toolResults(messages).length < 2 ? { tools: [{ name: "add", params: { a: 1, b: 1 }, id: "same" }] } : { text: "done" }
        ),
        addTool
      ]
    ))

  it.live("a tool that throws synchronously becomes an error result instead of blocking the run", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("crash")
        expect(yield* session.awaitIdle.pipe(Effect.timeout("5 seconds"))).toMatchObject({ status: "completed" })
        const [result] = data<{ isError: boolean; content: string }>(yield* session.events, "tool/finished")
        expect(result).toMatchObject({ isError: true })
        expect(result?.content).toContain("Tool crashed: kaput")
      }),
      [
        fakeModelPlugin((messages) => (last(messages).role === "tool" ? { text: "done" } : { tools: [{ name: "explode", params: {} }] })),
        Plugin.define({
          id: "explode",
          setup: (ctx) =>
            ctx.tools.transform((tools) => {
              tools.set("explode", defineTool({
                name: "explode",
                description: "throws",
                parameters: Schema.Struct({}),
                idempotent: true,
                execute: () => {
                  throw new Error("kaput")
                }
              }))
            })
        })
      ]
    ))

  it.live("optional parameters sent as null (strict-schema providers) are accepted", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("x")
        yield* session.awaitIdle
        const results = data<{ isError: boolean; content: string }>(yield* session.events, "tool/finished")
        expect(results.map((r) => [r.isError, r.content])).toEqual([[false, "hi!"]])
      }),
      [
        fakeModelPlugin((messages) =>
          last(messages).role === "tool" ? { text: "done" } : { tools: [{ name: "shout", params: { text: "hi", suffix: null } }] }
        ),
        Plugin.define({
          id: "shout",
          setup: (ctx) =>
            ctx.tools.transform((tools) => {
              tools.set("shout", defineTool({
                name: "shout",
                description: "shout",
                parameters: Schema.Struct({ text: Schema.String, suffix: Schema.optional(Schema.String) }),
                idempotent: true,
                execute: ({ suffix, text }) => Effect.succeed({ content: text + (suffix ?? "!") })
              }))
            })
        })
      ]
    ))

  it.live("unknown tools and denying hooks become error results for the model", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("x")
        yield* session.awaitIdle
        const results = data<{ name: string; isError: boolean; content: string }>(yield* session.events, "tool/finished")
        expect(results.map((r) => [r.name, r.isError, r.content]).sort()).toEqual([
          ["add", true, "Denied: no adding today"],
          ["ghost", true, `Tool "ghost" is not available (its plugin may have been removed).`]
        ])
      }),
      [
        fakeModelPlugin((messages) =>
          last(messages).role === "tool"
            ? { text: "done" }
            : { tools: [{ name: "ghost", params: {} }, { name: "add", params: { a: 1, b: 2 } }] }
        ),
        addTool,
        Plugin.define({
          id: "guardian",
          setup: (ctx) =>
            ctx.hook("tool.before", (event) =>
              Effect.sync(() => {
                if (event.tool === "add") event.decision = { _tag: "Deny", reason: "no adding today" }
              }))
        })
      ]
    ))

  it.live("a failing model call is retried with backoff; a run fails after 3 attempts", () => {
    let calls = 0
    return run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const ok = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* ok.prompt("hello")
        expect(yield* ok.awaitIdle).toMatchObject({ status: "completed" })
        expect(data(yield* ok.events, "model/failed")).toHaveLength(1) // first attempt failed, second succeeded

        const broken = yield* pie.create({ cwd: "/repo", model: "fake/missing" })
        yield* broken.prompt("hello")
        const outcome = yield* broken.awaitIdle
        expect(outcome).toMatchObject({ status: "failed" })
        expect(outcome?.message).toContain("not registered")
        expect(data(yield* broken.events, "model/failed")).toHaveLength(3)
      }),
      [
        fakeModelPlugin(() => {
          calls++
          if (calls === 1) throw new Error("rate limited")
          return { text: "hi" }
        })
      ]
    )
  }, 15_000)

  it.live("abort interrupts a running tool, ends the run and releases the session", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const stuck = Plugin.define({
        id: "stuck",
        setup: (ctx) =>
          ctx.tools.transform((tools) => {
            tools.set("hang", defineTool({
              name: "hang",
              description: "never returns",
              parameters: Schema.Struct({}),
              idempotent: false,
              execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            }))
          })
      })
      yield* run(
        Effect.gen(function*() {
          const pie = yield* Pie.Pie
          const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
          yield* session.prompt("hang")
          yield* Deferred.await(started)
          yield* session.abort
          const outcome = yield* session.awaitIdle.pipe(Effect.timeout("5 seconds"))
          expect(outcome?.status).toBe("aborted")
          const [result] = data<{ isError: boolean; content: string }>(yield* session.events, "tool/finished")
          expect(result?.content).toContain("Aborted")
          yield* session.prompt("again") // usable again
        }),
        [fakeModelPlugin(() => ({ tools: [{ name: "hang", params: {} }] })), stuck]
      )
    }))
})

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

describe("self-modification through the configuration log", () => {
  const sdk = path.join(import.meta.dirname, "..", "src", "index.ts")
  const source = (body: string) => `
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from ${JSON.stringify(sdk)}
export default Plugin.define({ id: "word-count", setup: (ctx) => ${body} })
`
  const valid = source(`ctx.tools.transform((tools) => {
    tools.set("word_count", defineTool({
      name: "word_count", description: "Count words", parameters: Schema.Struct({ text: Schema.String }), idempotent: true,
      execute: ({ text }) => Effect.succeed({ content: String(text.split(/\\s+/).filter(Boolean).length) })
    }))
  })`)
  const notEffect = source(`(() => {})`)
  const policy = source(`ctx.hook("tool.before", (e) => Effect.sync(() => { e.decision = { _tag: "Deny", reason: "mine" } }))`)

  it.live("installs a plugin mid-run (hot); rejects a broken one, one using a policy point, one whose setup is not an Effect", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("teach yourself to count words")
        yield* session.awaitIdle
        const results = data<{ name: string; isError: boolean; content: string }>(yield* session.events, "tool/finished")
        expect(results.map((r) => [r.name, r.isError])).toEqual([
          ["plugin_install", true],
          ["plugin_install", true],
          ["plugin_install", true],
          ["plugin_install", false],
          ["word_count", false]
        ])
        expect(results[1]?.content).toContain("policy point")
        expect(results[2]?.content).toContain("setup must return an Effect")
        expect(results[4]?.content).toBe("3")
      }),
      [
        fakeModelPlugin((messages) => {
          const n = toolResults(messages).length
          if (n === 0) return { tools: [{ name: "plugin_install", params: { source: "export default {{ broken" } }] }
          if (n === 1) return { tools: [{ name: "plugin_install", params: { source: policy } }] }
          if (n === 2) return { tools: [{ name: "plugin_install", params: { source: notEffect } }] }
          if (n === 3) return { tools: [{ name: "plugin_install", params: { source: valid } }] }
          if (n === 4) return { tools: [{ name: "word_count", params: { text: "uno dos tres" } }] }
          return { text: "done" }
        })
      ],
      true
    ))
})
