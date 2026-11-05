/**
 * The HTTP side of the app: the page (web/dist), a small JSON API over Pie's
 * sessions ("threads"), and every live event by SSE.
 *
 *   GET  /api/threads               threads, most recent first
 *   POST /api/threads               a new thread
 *   GET  /api/threads/:id           its events (the current branch)
 *   POST /api/threads/:id/messages  { text }: a prompt, or a follow-up if it is busy
 *   POST /api/threads/:id/abort
 *   GET  /api/live                  SSE: "hello" { version }, then "pie" events and text deltas
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { Effect, Stream } from "effect"
import { Pie } from "pie-agent"
import { MODEL } from "./agent.ts"

export interface ServeOptions {
  readonly appDir: string
  readonly host: string
  readonly port: number
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
}

export const serve = (options: ServeOptions) =>
  Effect.gen(function*() {
    const pie = yield* Pie.Pie
    const context = yield* Effect.context<Pie.Pie>()
    const run = <A, E>(effect: Effect.Effect<A, E, Pie.Pie>) => Effect.runPromiseWith(context)(effect)
    const dist = path.join(options.appDir, "web", "dist")
    // The page reloads itself when this changes (after a restart with a new UI).
    const version = createHash("sha256")
      .update(fs.existsSync(dist)
        ? (fs.readdirSync(dist, { recursive: true }) as Array<string>).sort()
          .filter((f) => fs.statSync(path.join(dist, f)).isFile())
          .map((f) => `${f}\0${fs.readFileSync(path.join(dist, f), "utf8")}`).join("\0")
        : "")
      .digest("hex").slice(0, 12)

    const clients = new Set<http.ServerResponse>()
    const send = (res: http.ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    yield* pie.live.pipe(
      Stream.runForEach((event) => Effect.sync(() => { for (const c of clients) send(c, "pie", event) })),
      Effect.forkScoped
    )

    const json = (res: http.ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const body = async (req: http.IncomingMessage) => {
      let data = ""
      for await (const chunk of req) data += chunk
      return data ? JSON.parse(data) : {}
    }

    const threads = Effect.gen(function*() {
      const list = yield* pie.list
      const rows = []
      for (const info of list) {
        const events = yield* (yield* Effect.orDie(pie.open(info.id))).events
        const first = events.find((e) => e.type === "user")
        rows.push({
          id: info.id,
          title: first ? String((first.data as { text: string }).text).slice(0, 80) : "New thread",
          updatedAt: events.at(-1)?.createdAt ?? info.createdAt
        })
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt)
    })

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x")
      const method = req.method ?? "GET"
      if (url.pathname === "/api/live") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
        send(res, "hello", { version })
        clients.add(res)
        req.on("close", () => clients.delete(res))
        return
      }
      if (url.pathname === "/api/threads") {
        if (method === "POST") {
          const session = await run(pie.create({ cwd: options.appDir, model: MODEL }))
          return json(res, 200, { id: session.id })
        }
        return json(res, 200, await run(threads))
      }
      const match = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/(messages|abort))?$/)
      if (match) {
        const session = await run(Effect.orDie(pie.open(match[1]!)))
        if (match[2] === "messages" && method === "POST") {
          const { text } = await body(req)
          await run(Effect.orDie(session.prompt(String(text), { streamingBehavior: "followUp" })))
          return json(res, 200, { ok: true })
        }
        if (match[2] === "abort" && method === "POST") {
          await run(session.abort)
          return json(res, 200, { ok: true })
        }
        return json(res, 200, await run(session.events))
      }
      // Static files from web/dist; anything else is the page.
      const file = path.join(dist, url.pathname === "/" ? "index.html" : path.normalize(url.pathname))
      const target = file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, "index.html")
      res.writeHead(200, { "content-type": TYPES[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" })
      res.end(fs.readFileSync(target))
    }

    const server = yield* Effect.acquireRelease(
      Effect.callback<http.Server, Error>((resume) => {
        const s = http.createServer((req, res) =>
          void handle(req, res).catch((error) => {
            if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) })
            else res.end()
          })
        )
        s.once("error", (error) => resume(Effect.fail(error)))
        s.listen(options.port, options.host, () => resume(Effect.succeed(s)))
      }),
      (s) => Effect.callback<void>((resume) => {
        for (const c of clients) c.end()
        s.close(() => resume(Effect.void))
        s.closeAllConnections()
      })
    ).pipe(Effect.orDie)
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : options.port
    console.log(`app: http://${options.host}:${port}`)
  })
