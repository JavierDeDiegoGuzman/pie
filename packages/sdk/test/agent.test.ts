import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Schema } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import { defineTool, type LogEvent, Pie, Plugin } from "../src/index.ts"
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

  it.live("a model that stops responding times out and the call is retried", () => {
    let calls = 0
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.PIE_MODEL_IDLE_TIMEOUT = "300"
      }),
      () =>
        run(
          Effect.gen(function*() {
            const pie = yield* Pie.Pie
            const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
            yield* session.prompt("hello")
            expect(yield* session.awaitIdle.pipe(Effect.timeout("10 seconds"))).toMatchObject({ status: "completed" })
            const [failure] = data<{ message: string }>(yield* session.events, "model/failed")
            expect(failure?.message).toContain("no response from the model")
          }),
          [fakeModelPlugin(() => (++calls === 1 ? HANG : { text: "hi" }))]
        ),
      () =>
        Effect.sync(() => {
          delete process.env.PIE_MODEL_IDLE_TIMEOUT
        })
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
