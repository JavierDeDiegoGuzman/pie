import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Schema } from "effect"
import type { Prompt } from "effect/ai"
import * as fs from "node:fs"
import * as path from "node:path"
import { Attachments, defineTool, type LogEvent, Pie, Plugin, Storage } from "../src/index.ts"
import { testHome } from "./support/home.ts"
import { FAKE_MODEL, fakeModelPlugin, last, lastUserText, type Reply } from "./support/fake-model.ts"

type Messages = ReadonlyArray<Prompt.Message>

const run = <A, E>(effect: Effect.Effect<A, E, Pie.Pie>, plugins: ReadonlyArray<Plugin.Plugin>) =>
  effect.pipe(Effect.provide(Pie.layer({ plugins })), Effect.scoped)

/** A tool that waits until the test opens the gate: keeps a run active while the test acts on it. */
const waiting = Effect.gen(function*() {
  const gate = yield* Deferred.make<void>()
  const started = yield* Deferred.make<void>()
  const plugin = Plugin.define({
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
  return { gate, started, plugin }
})

const userTexts = (events: ReadonlyArray<LogEvent>) =>
  events.filter((e) => e.type === "user").map((e) => (e.data as { text: string }).text)

describe("attachments", () => {
  it.live("an image sent with a prompt is stored once and the model gets it as a file part", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const files: Array<{ mediaType: string; size: number; text: string }> = []
    const script = (messages: Messages): Reply => {
      const user = last(messages)
      if (user.role === "user" && Array.isArray(user.content)) {
        for (const part of user.content) {
          if (part.type === "file") {
            const data = part.data instanceof Uint8Array ? part.data : new Uint8Array()
            files.push({ mediaType: part.mediaType, size: data.byteLength, text: lastUserText(messages) })
          }
        }
      }
      return { text: "a pie" }
    }
    return run(
      Effect.gen(function*() {
        const pie = yield* Pie.Pie
        const session = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
        yield* session.prompt("what is this?", { attachments: [{ mediaType: "image/png", data: png, name: "pie.png" }] })
        yield* session.awaitIdle
        expect(files).toEqual([{ mediaType: "image/png", size: png.byteLength, text: "what is this?" }])

        // The event keeps a reference; the bytes are stored once, by hash.
        const user = (yield* session.events).find((e) => e.type === "user")!
        const [attachment] = (user.data as { attachments: Array<{ blob: string; mediaType: string; name: string; size: number }> }).attachments
        expect(attachment).toMatchObject({ mediaType: "image/png", name: "pie.png", size: png.byteLength })
        expect([...(yield* session.attachment(attachment!.blob))!.data]).toEqual([...png])

        // Base64 works too, and the same bytes are the same blob.
        yield* session.prompt("and this?", { attachments: [{ mediaType: "image/png", data: Buffer.from(png).toString("base64") }] })
        yield* session.awaitIdle
        const blobs = (yield* session.events).filter((e) => e.type === "user").map((e) => (e.data as any).attachments[0].blob)
        expect(new Set(blobs).size).toBe(1)
      }),
      [fakeModelPlugin(script)]
    )
  })
})

describe("attachments on disk", () => {
  it.live("with SQLite the bytes are a file in attachments/ next to the database, the table keeps the reference", () =>
    Effect.gen(function*() {
      const dir = testHome("attachments")
      const db = path.join(dir, "pie.db")
      const jpg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70])
      const withPie = <A, E>(effect: Effect.Effect<A, E, Pie.Pie>) =>
        effect.pipe(Effect.provide(Pie.layer({ storage: Storage.sqlite(db), plugins: [fakeModelPlugin(() => ({ text: "ok" }))] })), Effect.scoped)
      const { blob, sessionId } = yield* withPie(Effect.gen(function*() {
        const session = yield* (yield* Pie.Pie).create({ cwd: dir, model: FAKE_MODEL })
        yield* session.prompt("look", { attachments: [{ mediaType: "image/jpeg", data: jpg }] })
        yield* session.awaitIdle
        const user = (yield* session.events).find((e) => e.type === "user")!
        return { blob: (user.data as any).attachments[0].blob as string, sessionId: session.id }
      }))
      expect([...fs.readFileSync(path.join(dir, "attachments", blob))]).toEqual([...jpg])
      expect(fs.readdirSync(path.join(dir, "attachments"))).toEqual([blob])
      // Another process later: the reference in the database finds the file again.
      const again = yield* withPie(Effect.gen(function*() {
        const session = yield* Effect.orDie((yield* Pie.Pie).open(sessionId))
        return yield* session.attachment(blob)
      }))
      expect(again).toMatchObject({ hash: blob, mediaType: "image/jpeg" })
      expect([...again!.data]).toEqual([...jpg])
    }))
})

describe("your own attachments store", () => {
  it.live("Pie.layer({ attachments }) replaces the folder next to the database", () =>
    Effect.gen(function*() {
      const dir = testHome("own-store")
      const stored = new Map<string, Uint8Array>()
      const store = Layer.succeed(Attachments.Attachments, Attachments.Attachments.of({
        write: (hash, data) => Effect.sync(() => (stored.set(`bucket/${hash}`, data), `bucket/${hash}`)),
        read: (name) => Effect.sync(() => stored.get(name))
      }))
      const png = new Uint8Array([137, 80, 78, 71, 1])
      const file = yield* Effect.gen(function*() {
        const session = yield* (yield* Pie.Pie).create({ cwd: dir, model: FAKE_MODEL })
        yield* session.prompt("look", { attachments: [{ mediaType: "image/png", data: png }] })
        yield* session.awaitIdle
        const user = (yield* session.events).find((e) => e.type === "user")!
        return yield* session.attachment((user.data as any).attachments[0].blob)
      }).pipe(
        Effect.provide(Pie.layer({
          storage: Storage.sqlite(path.join(dir, "pie.db")),
          attachments: store,
          plugins: [fakeModelPlugin(() => ({ text: "ok" }))]
        })),
        Effect.scoped
      )
      expect([...stored.keys()]).toEqual([`bucket/${file!.hash}`])
      expect([...file!.data]).toEqual([...png])
      expect(fs.existsSync(path.join(dir, "attachments"))).toBe(false)
    }))
})

describe("queued messages", () => {
  it.live("listed while the agent works; one delivered now (at the next step), one withdrawn", () =>
    Effect.gen(function*() {
      const { gate, plugin, started } = yield* waiting
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
          yield* session.followUp("how is it going?")
          yield* session.followUp("never mind")
          const queued = yield* session.queued
          expect(queued.map((q) => [q.text, q.kind])).toEqual([["how is it going?", "followUp"], ["never mind", "followUp"]])

          yield* session.deliverNow(queued[0]!.inputId)
          yield* session.cancelQueued(queued[1]!.inputId)
          expect((yield* session.queued).map((q) => [q.text, q.kind])).toEqual([["how is it going?", "steer"]])

          yield* Deferred.succeed(gate, undefined)
          yield* session.awaitIdle
          // Delivered right after the tool, as a steer, not at the end; the withdrawn one never reaches the model.
          expect(userTexts(yield* session.events)).toEqual(["go", "how is it going?"])
          expect(seen).toEqual(["go", "how is it going?"])
          expect(yield* session.queued).toEqual([])
          // Acting on an input that is gone does nothing.
          yield* session.cancelQueued(queued[0]!.inputId)
        }),
        [fakeModelPlugin(script), plugin]
      )
    }))
})

describe("editing a queued message", () => {
  it.live("the model sees the new text and files; once delivered, an edit does nothing", () =>
    Effect.gen(function*() {
      const { gate, plugin, started } = yield* waiting
      const seen: Array<{ text: string; files: number }> = []
      const script = (messages: Messages): Reply => {
        const user = last(messages)
        const files = user.role === "user" && Array.isArray(user.content) ? user.content.filter((p) => p.type === "file").length : 0
        seen.push({ text: lastUserText(messages), files })
        return user.role === "user" && lastUserText(messages) === "go" ? { tools: [{ name: "wait", params: {} }] } : { text: "ok" }
      }
      const png = new Uint8Array([137, 80, 78, 71, 2])
      yield* run(
        Effect.gen(function*() {
          const session = yield* (yield* Pie.Pie).create({ cwd: "/repo", model: FAKE_MODEL })
          yield* session.prompt("go")
          yield* Deferred.await(started)
          yield* session.followUp("tpyo")
          const [queued] = yield* session.queued
          yield* session.editQueued(queued!.inputId, "typo fixed, and a picture", {
            attachments: [{ mediaType: "image/png", data: png }]
          })
          expect((yield* session.queued).map((q) => [q.text, q.kind, q.attachments?.length])).toEqual([
            ["typo fixed, and a picture", "followUp", 1]
          ])
          // Without attachments the files stay as they are.
          yield* session.editQueued(queued!.inputId, "typo fixed")
          expect((yield* session.queued)[0]).toMatchObject({ text: "typo fixed", attachments: [{ mediaType: "image/png" }] })

          yield* Deferred.succeed(gate, undefined)
          yield* session.awaitIdle
          expect(seen.at(-1)).toEqual({ text: "typo fixed", files: 1 })
          expect(userTexts(yield* session.events)).toEqual(["go", "typo fixed"])
          yield* session.editQueued(queued!.inputId, "too late")
          expect(userTexts(yield* session.events)).toEqual(["go", "typo fixed"])
        }),
        [fakeModelPlugin(script), plugin]
      )
    }))
})

describe("pie.list", () => {
  it.live("each session with its title, status, last outcome and activity, most recent first", () =>
    Effect.gen(function*() {
      const { gate, plugin, started } = yield* waiting
      const script = (messages: Messages): Reply =>
        last(messages).role === "user" && lastUserText(messages) === "slow one" ? { tools: [{ name: "wait", params: {} }] } : { text: "ok" }
      yield* run(
        Effect.gen(function*() {
          const pie = yield* Pie.Pie
          const empty = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
          const done = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
          yield* done.prompt("quick one")
          yield* done.awaitIdle
          yield* Effect.sleep("5 millis")
          const busy = yield* pie.create({ cwd: "/repo", model: FAKE_MODEL })
          yield* busy.prompt("slow one")
          yield* Deferred.await(started)

          const list = yield* pie.list
          expect(list.map((s) => [s.id, s.title, s.status, s.lastOutcome])).toEqual([
            [busy.id, "slow one", "running", undefined],
            [done.id, "quick one", "idle", "completed"],
            [empty.id, undefined, "idle", undefined]
          ])
          yield* Deferred.succeed(gate, undefined)
          yield* busy.awaitIdle
          expect((yield* pie.list)[0]).toMatchObject({ id: busy.id, status: "idle", lastOutcome: "completed" })
        }),
        [fakeModelPlugin(script), plugin]
      )
    }))
})
