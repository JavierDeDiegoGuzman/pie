import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Schema } from "effect"
import { defineTool, type Entry, Pie, Plugin, PluginHost, Storage } from "../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, last, lastUserText, type Reply, toolResults } from "./support/fake-model.ts"

const addTool = Plugin.define({
  id: "math",
  setup: (ctx) =>
    ctx.tools.transform((tools) => {
      tools.set(
        "add",
        defineTool({
          name: "add",
          description: "Add two integers",
          parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
          idempotent: true,
          execute: ({ a, b }) => Effect.succeed({ content: String(a + b) })
        })
      )
    })
})

/** Calls `add` once per user message, then answers with the sum. */
const mathScript = (messages: Parameters<Parameters<typeof fakeModelPlugin>[0]>[0]): Reply => {
  const results = toolResults(messages)
  if (last(messages).role === "tool") return { text: `result ${String(results[results.length - 1]?.result)}` }
  return { tools: [{ name: "add", params: { a: 19, b: 23 } }] }
}

const run = <A, E>(effect: Effect.Effect<A, E, Pie.Pie | PluginHost>, plugins: ReadonlyArray<Plugin.Plugin>) =>
  effect.pipe(
    Effect.provide(Pie.layer({ storage: Storage.memory, plugins })),
    Effect.scoped
  )

const kinds = (entries: ReadonlyArray<Entry>) => entries.map((e) => e.kind)

describe("AgentRun (memory storage)", () => {
  it.live("prompt → tool call → tool result → answer, all persisted as entries", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("sum please")
        const outcome = yield* session.awaitIdle
        expect(outcome).toEqual({ status: "completed" })
        const entries = yield* session.entries
        expect(kinds(entries)).toEqual(["user", "assistant", "toolResult", "assistant", "runEnd"])
        const final = entries[3]!
        expect(final.kind === "assistant" && final.data.text).toBe("result 42")
      }),
      [fakeModelPlugin(mathScript), addTool]
    ))

  it.live("a second prompt while running fails; followUp is absorbed into the same run", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("first")
        const busy = yield* Effect.flip(session.prompt("second"))
        expect(busy._tag).toBe("SessionBusy")
        yield* session.prompt("and then this", { streamingBehavior: "followUp" })
        yield* session.awaitIdle
        const entries = yield* session.entries
        const users = entries.flatMap((e) => (e.kind === "user" ? [e.data.text] : []))
        expect(users).toEqual(["first", "and then this"])
        expect(entries.filter((e) => e.kind === "runEnd")).toHaveLength(1)
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
              execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as({ content: "waited" }))
            }))
          })
      })
      const seen: Array<string> = []
      const script = (messages: Parameters<typeof mathScript>[0]): Reply => {
        seen.push(lastUserText(messages))
        return last(messages).role === "user" && lastUserText(messages) === "go" ? { tools: [{ name: "wait", params: {} }] } : { text: "ok" }
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
          expect(kinds(yield* session.entries)).toEqual(["user", "assistant", "toolResult", "user", "assistant", "runEnd"])
          expect(seen).toEqual(["go", "change of plans"])
        }),
        [fakeModelPlugin(script), slow]
      )
    }))

  it.live("optional parameters sent as null (strict-schema providers) are accepted", () =>
    run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("x")
        yield* session.awaitIdle
        const results = (yield* session.entries).flatMap((e) => (e.kind === "toolResult" ? [e.data] : []))
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
        const results = (yield* session.entries).flatMap((e) => (e.kind === "toolResult" ? [e.data] : []))
        expect(results.map((r) => [r.toolName, r.isError, r.content])).toEqual([
          ["ghost", true, `Tool "ghost" is not available (its plugin may have been removed).`],
          ["add", true, "Denied: no adding today"]
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

  it.live("self-modification: a tool installs a plugin and the next model call can use its tool", () => {
    const offered: Array<ReadonlyArray<string>> = []
    return run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const host = yield* PluginHost
        // A plugin whose tool installs another plugin (as the agent would by writing a file).
        yield* host.replace(Plugin.define({
          id: "installer",
          setup: (ctx) =>
            ctx.tools.transform((tools) => {
              tools.set("install_add", defineTool({
                name: "install_add",
                description: "installs the math plugin",
                parameters: Schema.Struct({}),
                idempotent: true,
                execute: () => Effect.as(Effect.orDie(host.replace(addTool)), { content: "installed" })
              }))
            })
        }))
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("teach yourself to add")
        yield* session.awaitIdle
        expect(offered[0]).not.toContain("add")
        expect(offered[1]).toContain("add")
        const results = (yield* session.entries).flatMap((e) => (e.kind === "toolResult" ? [e.data.content] : []))
        expect(results).toEqual(["installed", "42"])
      }),
      [
        fakeModelPlugin((messages, tools) => {
          offered.push(tools)
          const results = toolResults(messages)
          if (results.length === 0) return { tools: [{ name: "install_add", params: {} }] }
          if (results.length === 1) return { tools: [{ name: "add", params: { a: 20, b: 22 } }] }
          return { text: "now I can add" }
        })
      ]
    )
  })

  it.live("abort interrupts a running tool and releases the session", () =>
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
          // The session is usable again.
          yield* session.prompt("again")
        }),
        [fakeModelPlugin(() => ({ tools: [{ name: "hang", params: {} }] })), stuck]
      )
    }))
})

