// @pie/ui: the browser SDK every UI module receives. Served by the web plugin.
// A UI module's default export gets { ...this module, ui } where ui registers
// components into named slots: ui.slot(name, Component, { order }), renderers
// for event types: ui.event(type, Component), and CSS: ui.style(css).
import { Component, h, render } from "preact"
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks"
import { html } from "htm/preact"

export { Component, h, html, render, useCallback, useEffect, useMemo, useRef, useState }

// -- server ---------------------------------------------------------------------
const parse = (r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.statusText))))
export const api = {
  get: (path) => fetch(path).then(parse),
  post: (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(parse)
}

// -- live events (SSE) ------------------------------------------------------------
const liveListeners = new Set()
export function connect() {
  const source = new EventSource("/api/live")
  for (const type of ["pie", "ui", "config"]) {
    source.addEventListener(type, (e) => {
      const data = JSON.parse(e.data)
      for (const listener of liveListeners) listener(type, data)
    })
  }
  return source
}
/** listener(type, data); type is "pie" (log events and deltas), "ui" (modules changed) or "config". */
export function onLive(listener) {
  liveListeners.add(listener)
  return () => liveListeners.delete(listener)
}

// -- current session ---------------------------------------------------------------
let currentSession = localStorage.getItem("pie.session")
const sessionListeners = new Set()
export function setSession(id) {
  currentSession = id
  if (id) localStorage.setItem("pie.session", id)
  else localStorage.removeItem("pie.session")
  for (const listener of sessionListeners) listener(id)
}
export function useSession() {
  const [session, set] = useState(currentSession)
  useEffect(() => {
    sessionListeners.add(set)
    return () => sessionListeners.delete(set)
  }, [])
  return session
}

// -- data hooks --------------------------------------------------------------------
/** Events of the session's current branch, kept live. */
export function useEvents(sessionId) {
  const [events, setEvents] = useState([])
  useEffect(() => {
    if (!sessionId) return setEvents([])
    let alive = true
    const load = () => api.get(`/api/sessions/${sessionId}/events`).then((e) => alive && setEvents(e))
    load()
    const off = onLive((type, d) => {
      if (type !== "pie" || d.type !== "event" || d.sessionId !== sessionId) return
      setEvents((prev) => (prev.some((x) => x.id === d.event.id) ? prev : [...prev, d.event]))
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return events
}

/** Text streaming in right now (not persisted); cleared when the response is logged. */
export function useStreaming(sessionId) {
  const [text, setText] = useState("")
  useEffect(() => {
    setText("")
    return onLive((type, d) => {
      if (type !== "pie" || d.sessionId !== sessionId) return
      if (d.type === "text_delta") setText((t) => t + d.delta)
      else if (d.type === "event" && (d.event.type === "model/responded" || d.event.type === "model/requested")) setText("")
    })
  }, [sessionId])
  return text
}

/** Value of a plugin projection for the session, refetched on each new event. */
export function useProjection(sessionId, projectionId) {
  const [value, setValue] = useState(undefined)
  useEffect(() => {
    if (!sessionId) return setValue(undefined)
    let alive = true
    const load = () =>
      api.get(`/api/sessions/${sessionId}/projections/${encodeURIComponent(projectionId)}`).then((v) => alive && setValue(v.value))
    load()
    const off = onLive((type, d) => type === "pie" && d.type === "event" && d.sessionId === sessionId && load())
    return () => {
      alive = false
      off()
    }
  }, [sessionId, projectionId])
  return value
}

/** Re-renders when anything is appended to the session (for components that read state via api). */
export function useTick(sessionId) {
  const [tick, setTick] = useState(0)
  useEffect(() => onLive((type, d) => type === "pie" && d.type === "event" && (!sessionId || d.sessionId === sessionId) && setTick((t) => t + 1)), [sessionId])
  return tick
}

// -- slots ---------------------------------------------------------------------------
const slots = new Map() // name -> [{ owner, Component, order }]
const renderers = new Map() // event type -> { owner, Component }
const styles = new Map() // owner -> <style>
const errors = new Map() // owner -> message
let version = 0
const registryListeners = new Set()
const changed = () => {
  version++
  for (const listener of registryListeners) listener(version)
}
function useRegistry() {
  const [, set] = useState(version)
  useEffect(() => {
    registryListeners.add(set)
    return () => registryListeners.delete(set)
  }, [])
}

export function registrar(owner) {
  return {
    slot(name, Component, options = {}) {
      const list = (slots.get(name) ?? []).filter((s) => !(s.owner === owner && s.Component === Component))
      list.push({ owner, Component, order: options.order ?? 0 })
      list.sort((a, b) => a.order - b.order)
      slots.set(name, list)
      changed()
    },
    event(type, Component) {
      renderers.set(type, { owner, Component })
      changed()
    },
    style(css) {
      let el = styles.get(owner)
      if (!el) {
        el = document.createElement("style")
        el.dataset.owner = owner
        document.head.appendChild(el)
        styles.set(owner, el)
      }
      el.textContent += css
    }
  }
}

/** Removes everything a module registered (before reloading it, or when its plugin is gone). */
export function clearOwner(owner) {
  for (const [name, list] of slots) slots.set(name, list.filter((s) => s.owner !== owner))
  for (const [type, r] of renderers) if (r.owner === owner) renderers.delete(type)
  styles.get(owner)?.remove()
  styles.delete(owner)
  errors.delete(owner)
  changed()
}

export function reportError(owner, error) {
  const message = error?.stack || String(error)
  errors.set(owner, message)
  changed()
  api.post("/api/client-errors", { owner, message }).catch(() => {})
}

export function useErrors() {
  useRegistry()
  return [...errors]
}

export function rendererFor(type) {
  return renderers.get(type)
}

class Boundary extends Component {
  componentDidCatch(error) {
    reportError(this.props.owner, error)
    this.setState({ failed: true })
  }
  render() {
    if (this.state.failed) return html`<div class="pie-failed">“${this.props.owner}” failed to render</div>`
    return this.props.children
  }
}

/** Renders every component registered in a slot, each isolated by an error boundary. */
export function Slot({ name, fallback, ...props }) {
  useRegistry()
  const list = slots.get(name) ?? []
  if (list.length === 0) return fallback ?? null
  return html`${list.map((s) => html`<${Boundary} key=${s.owner + name} owner=${s.owner}><${s.Component} ...${props} /><//>`)}`
}

/** Renders an event with the renderer a plugin registered for its type (or nothing). */
export function EventView({ event, ...props }) {
  useRegistry()
  const r = renderers.get(event.type)
  if (!r) return null
  return html`<${Boundary} owner=${r.owner}><${r.Component} event=${event} ...${props} /><//>`
}
