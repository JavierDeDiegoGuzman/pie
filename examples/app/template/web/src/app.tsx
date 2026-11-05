/**
 * The page: one chat with the agent, and a button for the list of threads.
 * Everything comes from the server's API and its live events (SSE).
 */
import { render } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"

interface LogEvent { id: string; sessionId: string; type: string; data: any; createdAt: number }
interface Thread { id: string; title: string; updatedAt: number }

const api = {
  get: (url: string) => fetch(url).then((r) => r.json()),
  post: (url: string, body?: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json())
}

const toolLabel = (call: { name: string; params: any }) => {
  const p = call.params ?? {}
  const arg = p.path ?? p.command ?? p.reason ?? ""
  return `${call.name}${arg ? ` ${String(arg).slice(0, 60)}` : ""}`
}

function Message({ event }: { event: LogEvent }) {
  const d = event.data
  switch (event.type) {
    case "user":
      return <div class="msg user">{d.text}</div>
    case "input/queued":
      // Sent while the agent was working: shown at once, replaced by the real message when the agent gets it.
      return <div class="msg user queued">{d.text}</div>
    case "model/responded":
      return (
        <>
          {d.text ? <div class="msg agent">{d.text}</div> : null}
          {d.toolCalls?.map((c: any) => <div key={c.id} class="tool">{toolLabel(c)}</div>)}
        </>
      )
    case "tool/finished":
      return d.isError ? <div class="tool error">{d.name}: {String(d.content).split("\n")[0]}</div> : null
    case "notice":
      return <div class="tool">{d.text}</div>
    case "run/ended":
      return d.status === "completed" ? null : <div class="tool error">{d.status}{d.message ? `: ${d.message}` : ""}</div>
    default:
      return null
  }
}

/** Queued inputs already delivered (a `user` event with the same inputId) are not shown twice. */
const visible = (events: Array<LogEvent>) => {
  const delivered = new Set(events.filter((e) => e.type === "user" && e.data.inputId).map((e) => e.data.inputId))
  return events.filter((e) => e.type !== "input/queued" || !delivered.has(e.data.inputId))
}

function App() {
  const [threads, setThreads] = useState<Array<Thread>>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [events, setEvents] = useState<Array<LogEvent>>([])
  const [streaming, setStreaming] = useState("")
  const [text, setText] = useState("")
  const [showThreads, setShowThreads] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const currentRef = useRef<string | null>(null)
  currentRef.current = current

  const loadThreads = async () => {
    const list: Array<Thread> = await api.get("/api/threads")
    setThreads(list)
    return list
  }
  const open = async (id: string) => {
    setCurrent(id)
    setStreaming("")
    setEvents(await api.get(`/api/threads/${id}`))
    setShowThreads(false)
  }
  const newThread = async () => {
    const { id } = await api.post("/api/threads")
    await loadThreads()
    await open(id)
  }

  useEffect(() => {
    void loadThreads().then((list) => (list[0] ? open(list[0].id) : newThread()))
    let version: string | undefined
    const live = new EventSource("/api/live")
    live.addEventListener("hello", (e) => {
      const v = JSON.parse((e as MessageEvent).data).version
      if (version && v !== version) location.reload() // the app restarted with a new UI
      version = v
      if (currentRef.current) void api.get(`/api/threads/${currentRef.current}`).then(setEvents) // catch up after a reconnect
    })
    live.addEventListener("pie", (e) => {
      const msg = JSON.parse((e as MessageEvent).data)
      if (msg.sessionId !== currentRef.current) return
      if (msg.type === "text_delta") setStreaming((s) => s + msg.delta)
      if (msg.type === "event") {
        setEvents((list) => (list.some((x) => x.id === msg.event.id) ? list : [...list, msg.event]))
        if (msg.event.type === "model/responded" || msg.event.type === "run/ended") setStreaming("")
      }
    })
    return () => live.close()
  }, [])

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [events, streaming])

  const running = (() => {
    const started = events.filter((e) => e.type === "run/started").length
    const ended = events.filter((e) => e.type === "run/ended").length
    return started > ended
  })()

  const send = async () => {
    const value = text.trim()
    if (!value || !current) return
    setText("")
    await api.post(`/api/threads/${current}/messages`, { text: value })
  }

  return (
    <div class="app">
      <header>
        <button class="icon" aria-label="Threads" onClick={() => { void loadThreads(); setShowThreads(!showThreads) }}>☰</button>
        <b>Pie</b>
        <span class="spacer" />
        {running ? <button class="link" onClick={() => current && api.post(`/api/threads/${current}/abort`)}>Stop</button> : null}
      </header>
      {showThreads ? (
        <nav class="threads">
          <button class="new" onClick={newThread}>+ New thread</button>
          {threads.map((t) => (
            <button key={t.id} class={t.id === current ? "thread active" : "thread"} onClick={() => open(t.id)}>{t.title}</button>
          ))}
        </nav>
      ) : null}
      <main>
        {visible(events).map((e) => <Message key={e.id} event={e} />)}
        {streaming ? <div class="msg agent">{streaming}</div> : running ? <div class="tool">…</div> : null}
        <div ref={bottom} />
      </main>
      <form class="composer" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <textarea
          value={text}
          rows={1}
          placeholder="Ask for anything, even changes to this app"
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); void send() } }}
        />
        <button type="submit" aria-label="Send" onClick={(e) => (e.currentTarget as HTMLElement).blur()}>↑</button>
      </form>
    </div>
  )
}

render(<App />, document.getElementById("app")!)
