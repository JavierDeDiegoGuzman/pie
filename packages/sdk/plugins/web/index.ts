/**
 * Plugin: the web interface. Like every plugin it is a folder the agent can
 * edit (this file, shell.html, ui-sdk.js) and apply with the restart tool; the
 * safety nets are rollback (also from the page's "Plugins y deshacer" menu),
 * `pie rollback` from the terminal and PIE_SAFE=1.
 *
 * Serves, on 127.0.0.1 only and behind a token:
 *   /            the shell: header, slots (sidebar, main, panel, header) and the recovery menu
 *   /ui.mjs      the browser SDK (@pie/ui); /vendor/* Preact + htm, no build step
 *   /ui/<id>.mjs each plugin's UI module (ctx.ui); reloaded live when it changes
 *   /api/*       sessions, events, prompts, projections, plugins; /api/live is SSE
 *
 * The chat itself is a UI module of another plugin (web-chat), so it can be
 * replaced too. Options: port, host, token, cwd, model.
 */
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema, Stream } from "effect"
import { Plugin, WebAssets, defineTool } from "@pie/sdk"

// The page and the browser SDK live next to this file: edit them like any plugin code.
const here = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.join(here, "shell.html")
const UI_SDK = path.join(here, "ui-sdk.js")

export const UI_GUIDE = `The web interface is made of plugins. A plugin adds a browser module with ctx.ui(fn); fn runs in the
browser (it is serialized with toString, so it cannot use server variables) and receives the UI SDK:

  html (htm tagged templates for Preact), useState, useEffect, useMemo, useRef, useCallback,
  api.get(path) / api.post(path, body), onLive((type, data) => ...),
  useSession(), setSession(id), useEvents(sessionId), useStreaming(sessionId), useProjection(sessionId, projectionId),
  useTick(sessionId), Slot, EventView, rendererFor(type),
  ui.slot(name, Component, { order }), ui.event(eventType, Component), ui.style(css)

Slots: "header", "sidebar", "main", "panel" (right column). A component receives no props in slots; read the
current session with useSession(). ui.event(type, C) renders events of that type where the chat shows events
(C gets { event }). Each module is isolated: if it throws, the page shows a banner with "remove" and "undo".

API: GET /api/state, GET /api/sessions, POST /api/sessions {cwd?, model?}, GET /api/sessions/:id/events,
GET /api/sessions/:id/state, POST /api/sessions/:id/prompt {text, mode: "prompt"|"steer"|"followUp"},
POST /api/sessions/:id/abort, POST /api/sessions/:id/navigate {eventId},
GET /api/sessions/:id/projections/:projectionId -> { value }, GET /api/plugins, POST /api/plugins/undo.

Example (a panel with the todo list of the todo plugin):

export default Plugin.define({
  id: "todo-panel",
  setup: (ctx) => ctx.ui(({ html, ui, useSession, useProjection }) => {
    const Todos = () => {
      const session = useSession()
      const state = useProjection(session, "todo")
      if (!state) return null
      return html\`<h3>Todos</h3><ul>\${state.items.map((i) => html\`<li>\${i.done ? "✓" : "○"} \${i.text}</li>\`)}</ul>\`
    }
    ui.slot("panel", Todos)
  })
})

You cannot see the page: after changing the UI, ask the user to check it.`

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })

const cookie = (req: http.IncomingMessage, name: string) =>
  (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1]

export default Plugin.define({
  id: "web",
  setup: (ctx) =>
    Effect.gen(function*() {
      const pie = ctx.pie
      const port = Number(ctx.options.port ?? process.env.PIE_PORT ?? 4100)
      const hostname = String(ctx.options.host ?? "127.0.0.1")
      const token = String(ctx.options.token ?? process.env.PIE_TOKEN ?? randomUUID())
      const defaults = {
        cwd: String(ctx.options.cwd ?? process.cwd()),
        model: String(ctx.options.model ?? "opencode-go/deepseek-v4.1-flash")
      }
      const context = yield* Effect.context<never>()
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect)

      // -- live: every event, delta and UI change to every open page ------------------
      const clients = new Set<http.ServerResponse>()
      const send = (type: string, data: unknown) => {
        const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        for (const client of clients) client.write(frame)
      }
      const uiList = (modules: ReadonlyMap<string, { id: string; hash: string }>) =>
        [...modules.values()].map(({ hash, id }) => ({ id, hash }))
      yield* pie.live.pipe(Stream.runForEach((event) => Effect.sync(() => send("pie", event))), Effect.forkScoped)
      yield* pie.registries.ui.changes.pipe(Stream.runForEach((modules) => Effect.sync(() => send("ui", uiList(modules)))), Effect.forkScoped)

      const authorized = (req: http.IncomingMessage) => cookie(req, "pie_token") === token || req.headers["x-pie-token"] === token

      const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
        const method = req.method ?? "GET"

        if (url.pathname === "/") {
          if (url.searchParams.get("token") === token) {
            res.writeHead(302, { "set-cookie": `pie_token=${token}; HttpOnly; SameSite=Strict; Path=/`, location: "/" })
            return res.end()
          }
          if (!authorized(req)) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" })
            return res.end("Open the URL with ?token=… printed by Pie.")
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          return res.end(typeof ctx.options.shell === "string" ? ctx.options.shell : fs.readFileSync(SHELL))
        }
        if (!authorized(req)) return json(res, 401, { error: "unauthorized" })

        if (parts[0] === "vendor" && parts[1] && WebAssets.vendor[parts[1]]) {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" })
          return res.end(fs.readFileSync(WebAssets.vendor[parts[1]]!))
        }
        if (url.pathname === "/ui.mjs") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
          return res.end(fs.readFileSync(UI_SDK))
        }
        if (parts[0] === "ui" && parts[1]?.endsWith(".mjs")) {
          const module = (await run(pie.registries.ui.get)).get(parts[1].slice(0, -4))
          if (!module) return json(res, 404, { error: "no such UI module" })
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=31536000, immutable" })
          return res.end(module.source)
        }
        if (url.pathname === "/api/live") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
          res.write(": connected\n\n")
          clients.add(res)
          req.on("close", () => clients.delete(res))
          return
        }
        if (url.pathname === "/api/state") {
          return json(res, 200, {
            ui: uiList(await run(pie.registries.ui.get)),
            sessions: await run(pie.sessions.list),
            models: [...(await run(pie.registries.models.get)).keys()],
            defaults
          })
        }
        if (url.pathname === "/api/sessions" && method === "GET") return json(res, 200, await run(pie.sessions.list))
        if (url.pathname === "/api/sessions" && method === "POST") {
          const body = await readBody(req)
          return json(res, 200, await run(pie.sessions.create({ cwd: body.cwd ?? defaults.cwd, model: body.model ?? defaults.model })))
        }
        if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
          const id = parts[2]
          const action = parts[3]
          if (action === "events") return json(res, 200, await run(pie.sessions.events(id)))
          if (action === "state") {
            const state = await run(Effect.orDie(pie.sessions.state(id)))
            return json(res, 200, { model: state.model, running: state.run !== undefined, queued: state.queued, lastOutcome: state.lastOutcome })
          }
          if (action === "projections" && parts[4]) return json(res, 200, { value: await run(pie.projection(parts[4], id)) })
          if (method === "POST") {
            const body = await readBody(req)
            const operation: Effect.Effect<void, { readonly _tag: string }> =
              action === "prompt"
                ? pie.sessions.prompt(id, String(body.text ?? ""), body.mode ?? "prompt")
                : action === "abort"
                ? pie.sessions.abort(id)
                : action === "navigate"
                ? pie.sessions.navigate(id, body.eventId ?? null)
                : action === "model"
                ? pie.sessions.setModel(id, String(body.model))
                : Effect.fail({ _tag: "UnknownAction" })
            const result = await run(Effect.result(operation))
            return result._tag === "Success" ? json(res, 200, { ok: true }) : json(res, 409, { error: (result.failure as { _tag: string })._tag })
          }
        }
        if (url.pathname === "/api/plugins") return json(res, 200, await run(pie.plugins.explain))
        if (url.pathname === "/api/plugins/undo" && method === "POST") {
          // Back to the snapshot before the current one.
          const { head, history } = await run(pie.plugins.explain)
          const previous = history.filter((h) => h.type === "plugins/snapshot" && h.seq < head).at(-1)
          if (!previous) return json(res, 409, { error: "nothing to undo" })
          json(res, 200, { toSeq: previous.seq })
          return applyAfterResponse(pie.plugins.rollback(previous.seq, "web: undo the last change"))
        }
        if (url.pathname === "/api/plugins/rollback" && method === "POST") {
          const body = await readBody(req)
          json(res, 200, { ok: true })
          return applyAfterResponse(pie.plugins.rollback(Number(body.toSeq), String(body.reason ?? "web: rollback")))
        }
        if (url.pathname === "/api/plugins/remove" && method === "POST") {
          const body = await readBody(req)
          json(res, 200, { ok: true })
          return applyAfterResponse(pie.plugins.disable(String(body.id), `web: disable ${String(body.id)} (its UI failed)`))
        }
        if (url.pathname === "/api/client-errors" && method === "POST") {
          const body = await readBody(req)
          await run(Effect.logWarning(`web: UI module "${body.owner}" failed in the browser: ${String(body.message).slice(0, 500)}`))
          clientErrors.push({ owner: String(body.owner), message: String(body.message).slice(0, 2000), at: Date.now() })
          if (clientErrors.length > 20) clientErrors.shift()
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: "not found" })
      }

      const clientErrors: Array<{ owner: string; message: string; at: number }> = []

      /**
       * Configuration changes may replace this very plugin (and close this server), so answer first and apply
       * right after: otherwise the client sees a dropped connection, retries, and a second "undo" undoes the first.
       */
      const applyAfterResponse = (change: Effect.Effect<void, { readonly message: string }>) =>
        void setImmediate(() =>
          run(change.pipe(Effect.catch((e) => Effect.logWarning(`web: configuration change failed: ${e.message}`))))
        )

      yield* Effect.acquireRelease(
        Effect.callback<http.Server, Error>((resume) => {
          const server = http.createServer((req, res) => {
            handle(req, res).catch((error) => {
              if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
              else res.end()
            })
          })
          server.once("error", (error) => resume(Effect.fail(error)))
          // reusePort: a new version of this plugin can start before the old one stops (atomic replace).
          server.listen({ port, host: hostname, reusePort: true }, () => resume(Effect.succeed(server)))
        }),
        (server) =>
          Effect.callback<void>((resume) => {
            for (const client of clients) client.end()
            clients.clear()
            server.close(() => resume(Effect.void))
            server.closeAllConnections()
          })
      ).pipe(Effect.orDie)
      const address = `http://${hostname}:${port}/?token=${token}`
      process.stderr.write(`Pie web: ${address}\n`)

      yield* ctx.tools.transform((tools) => {
        tools.set("web_inspect", defineTool({
          name: "web_inspect",
          description: "How the web interface is built and how to change it with a plugin: slots, UI SDK, API, current UI " +
            "modules, projections and event types, and errors the browser reported. Call it before changing the UI.",
          parameters: Schema.Struct({}),
          idempotent: true,
          execute: () =>
            Effect.gen(function*() {
              const registries = pie.registries
              return {
                content: [
                  UI_GUIDE,
                  `\nCurrent UI modules: ${[...(yield* registries.ui.get).keys()].join(", ") || "none"}`,
                  `Projections: ${[...(yield* registries.projections.get).keys()].join(", ") || "none"}`,
                  `Plugin event types: ${[...(yield* registries.eventTypes.get).keys()].join(", ") || "none"}`,
                  `Recent browser errors: ${clientErrors.length === 0 ? "none" : JSON.stringify(clientErrors.slice(-5), null, 2)}`
                ].join("\n")
              }
            })
        }))
      })
    })
})
