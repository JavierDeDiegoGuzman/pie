import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as path from "node:path"
import { Pie, Plugins, Storage, TodoPlugin, WebChatPlugin, WebPlugin } from "../src/index.ts"
import { FAKE_MODEL, fakeModelPlugin, last, lastUserText } from "./support/fake-model.ts"

const PORT = 4150
const base = `http://127.0.0.1:${PORT}`
const headers = { "x-pie-token": "t", "content-type": "application/json" }
const get = (p: string) => Effect.promise(() => fetch(base + p, { headers }).then((r) => r.json() as Promise<any>))
const post = (p: string, body: unknown = {}) =>
  Effect.promise(() => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>))

/** Replacing the web plugin closes the old server's keep-alive connections: retry like a browser would. */
const page = () =>
  Effect.promise(async () => {
    for (let i = 0; ; i++) {
      try {
        return await fetch(base + "/", { headers }).then((r) => r.text())
      } catch (error) {
        if (i >= 3) throw error
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  })

const sdk = path.join(import.meta.dirname, "..", "src", "index.ts")
const uiPlugin = `
import { Plugin } from ${JSON.stringify(sdk)}
export default Plugin.define({ id: "status-badge", setup: (ctx) => ctx.ui(({ html, ui }) => ui.slot("header", () => html\`<b>ok</b>\`)) })
`

describe("web plugin", () => {
  it.live("serves the shell behind a token, the API, live events, projections and UI modules; UI changes can be undone", () =>
    Effect.gen(function*() {
      // auth
      expect((yield* Effect.promise(() => fetch(base + "/"))).status).toBe(401)
      const login = yield* Effect.promise(() => fetch(base + "/?token=t", { redirect: "manual" }))
      expect(login.status).toBe(302)
      expect(login.headers.get("set-cookie")).toContain("pie_token=t")

      const state = yield* get("/api/state")
      expect(state.ui.map((m: any) => m.id).sort()).toEqual(["todo", "web-chat"])
      const chatModule = yield* Effect.promise(() => fetch(`${base}/ui/web-chat.mjs`, { headers }).then((r) => r.text()))
      expect(chatModule).toContain('import * as sdk from "@pie/ui"')

      // live events over SSE
      const received: Array<string> = []
      const controller = new AbortController()
      const live = yield* Effect.promise(() => fetch(base + "/api/live", { headers, signal: controller.signal }))
      const reader = live.body!.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
          if (done) break
          received.push(decoder.decode(value))
        }
      })()

      // a prompt from the API, end to end
      const session = yield* post("/api/sessions", { cwd: "/repo", model: FAKE_MODEL })
      yield* post(`/api/sessions/${session.id}/prompt`, { text: "add buy milk" })
      for (let i = 0; i < 100 && (yield* get(`/api/sessions/${session.id}/state`)).running !== false; i++) yield* Effect.sleep("20 millis")
      const events = yield* get(`/api/sessions/${session.id}/events`)
      expect(events.map((e: any) => e.type)).toContain("todo/added")
      const todo = yield* get(`/api/sessions/${session.id}/projections/todo`)
      expect(todo.value.items.map((i: any) => i.text)).toEqual(["buy milk"])
      expect(received.join("")).toContain('"todo/added"')

      // the agent changes the UI; the page is told; undo brings it back
      const plugins = yield* Plugins
      yield* Effect.orDie(plugins.install(uiPlugin))
      yield* Effect.sleep("100 millis")
      expect(received.join("")).toContain('"status-badge"')
      expect((yield* get("/api/state")).ui.map((m: any) => m.id)).toContain("status-badge")
      yield* post("/api/plugins/undo")
      yield* Effect.sleep("100 millis")
      expect((yield* get("/api/state")).ui.map((m: any) => m.id)).not.toContain("status-badge")

      // The agent reads the built-in web plugin and replaces it with its own page, keeping port and token.
      const files = yield* Effect.orDie(plugins.source("web"))
      expect(Object.keys(files)).toEqual(expect.arrayContaining(["web.ts", "shell.html", "ui-sdk.js"]))
      controller.abort()
      yield* Effect.orDie(plugins.install(`
import { Plugin, WebPlugin } from ${JSON.stringify(sdk)}
export default Plugin.define({ id: "web", setup: (ctx) => WebPlugin.setup({ ...ctx, options: { ...ctx.options, shell: "<p>mine</p>" } }) })
`))
      expect(yield* page()).toBe("<p>mine</p>")
      yield* page() // settle the connection pool on the new server
      yield* post("/api/plugins/undo") // answered before it is applied, so never retried
      yield* Effect.sleep("200 millis")
      expect(yield* page()).toContain("importmap")
    }).pipe(
      Effect.provide(Pie.layer({
        storage: Storage.memory,
        plugins: [
          fakeModelPlugin((messages) => {
            const text = lastUserText(messages)
            if (last(messages).role === "tool") return { text: "ok" }
            return text.startsWith("add ") ? { tools: [{ name: "todo", params: { action: "add", text: text.slice(4) } }] } : { text: "?" }
          }),
          TodoPlugin,
          { plugin: WebPlugin, options: { port: PORT, token: "t" } },
          WebChatPlugin
        ],
        pluginCacheDirectory: path.join(import.meta.dirname, ".tmp", "plugin-cache")
      })),
      Effect.scoped
    ), 20_000)
})
