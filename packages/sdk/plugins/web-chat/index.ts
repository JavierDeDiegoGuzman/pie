/**
 * Built-in plugin: the chat of the web interface, as a UI module (sidebar with
 * sessions, main with the conversation). Replaceable like any plugin.
 */
import { Plugin } from "@pie/sdk"

export default Plugin.define({
  id: "web-chat",
  setup: (ctx) =>
    ctx.ui((sdk: any) => {
      const { api, EventView, html, rendererFor, setSession, ui, useEffect, useEvents, useRef, useSession, useState, useStreaming, useTick } = sdk

      ui.style(`
        .chat { display:flex; flex-direction:column; height:100%; min-height:0 }
        .chat-log { flex:1; overflow:auto; padding:16px 20px; display:flex; flex-direction:column; gap:10px }
        .msg { max-width:820px; white-space:pre-wrap; line-height:1.5 }
        .msg.user { align-self:flex-end; background:#22304d; padding:8px 12px; border-radius:12px }
        .msg.assistant { align-self:flex-start }
        .msg.streaming { color:var(--muted) }
        .tool { align-self:flex-start; font-size:12px; color:var(--muted); max-width:820px }
        .tool summary { cursor:pointer }
        .tool pre { white-space:pre-wrap; max-height:240px; overflow:auto; background:var(--panel); padding:8px; border-radius:8px }
        .tool.error summary { color:var(--danger) }
        .run-end { align-self:center; font-size:11px; color:var(--muted) }
        .chat-input { display:flex; gap:8px; padding:12px 20px; border-top:1px solid var(--line) }
        .chat-input textarea { flex:1; resize:none; min-height:44px }
        .sessions button { width:100%; text-align:left; margin-bottom:6px }
        .sessions button.active { border-color:var(--accent) }
        .fork { font-size:11px; color:var(--muted); cursor:pointer; margin-left:6px }
      `)

      const touch = (globalThis as any).matchMedia("(pointer: coarse)").matches

      const Sessions = () => {
        const current = useSession()
        const tick = useTick(null)
        const [sessions, setSessions] = useState([])
        useEffect(() => {
          api.get("/api/sessions").then(setSessions)
        }, [tick])
        const create = () => api.post("/api/sessions", {}).then((s: any) => setSession(s.id))
        return html`<div class="sessions">
          <button onClick=${create}>+ Nueva sesión</button>
          ${[...sessions].reverse().map((s: any) => html`<button class=${s.id === current ? "active" : ""} onClick=${() => setSession(s.id)}>
            ${s.cwd.split("/").pop() || s.cwd}<br/><small style="color:var(--muted)">${new Date(s.createdAt).toLocaleString()}</small>
          </button>`)}
        </div>`
      }

      const Event = ({ event, session }: any) => {
        const d = event.data
        switch (event.type) {
          case "user":
            return html`<div class="msg user">${d.text}</div>`
          case "model/responded":
            return html`<div class="msg assistant">${d.text}${d.finishReason === "aborted" ? html` <i>(interrumpido)</i>` : ""}${
              d.toolCalls.map((c: any) => html`<div class="tool">→ ${c.name}</div>`)
            }</div>`
          case "tool/finished":
            return html`<details class=${"tool" + (d.isError ? " error" : "")}><summary>${d.name}${d.isError ? " · error" : ""}</summary><pre>${d.content}</pre></details>`
          case "notice":
            return html`<details class=${"tool notice" + (d.text.includes("NOT applied") ? " error" : "")}><summary>Pie: ${d.text.split("\n")[0].slice(0, 120)}</summary><pre>${d.text}</pre></details>`
          case "run/ended":
            return html`<div class="run-end">— ${d.status}${d.message ? `: ${d.message}` : ""} ·
              <span class="fork" onClick=${() => api.post(`/api/sessions/${session}/navigate`, { eventId: event.id })}>continuar desde aquí</span> —</div>`
          default:
            return rendererFor(event.type) ? html`<${EventView} event=${event} />` : null
        }
      }

      const Chat = () => {
        const session = useSession()
        const events = useEvents(session)
        const streaming = useStreaming(session)
        const tick = useTick(session)
        const [state, setState] = useState(null)
        const [text, setText] = useState("")
        const log = useRef(null)
        useEffect(() => {
          if (session) api.get(`/api/sessions/${session}/state`).then(setState).catch(() => setSession(null))
        }, [session, tick])
        useEffect(() => {
          if (log.current) log.current.scrollTop = log.current.scrollHeight
        }, [events.length, streaming])
        if (!session) return html`<div class="pie-empty">Crea una sesión en la barra lateral.</div>`
        const running = state?.running
        const send = () => {
          if (!text.trim()) return
          api.post(`/api/sessions/${session}/prompt`, { text, mode: running ? "steer" : "prompt" })
          setText("")
        }
        return html`<div class="chat">
          <div class="chat-log" ref=${log}>
            ${events.map((e: any) => html`<${Event} key=${e.id} event=${e} session=${session} />`)}
            ${streaming ? html`<div class="msg assistant streaming">${streaming}</div>` : ""}
          </div>
          <div class="chat-input">
            <textarea value=${text} placeholder=${running ? "Trabajando… lo que escribas se entrega como steer" : "Escribe una tarea"}
              onInput=${(e: any) => setText(e.target.value)}
              onKeyDown=${(e: any) => {
                // Phones: Enter is a new line (send with the button). Desktop: Enter sends, Shift+Enter is a new line.
                if (e.key === "Enter" && !e.shiftKey && !touch) { e.preventDefault(); send() }
              }} />
            ${running ? html`<button onClick=${() => api.post(`/api/sessions/${session}/abort`)}>Abortar</button>` : ""}
            <button onClick=${send}>Enviar</button>
          </div>
        </div>`
      }

      ui.slot("sidebar", Sessions)
      ui.slot("main", Chat)
    })
})
