# The web plugin

The web interface is made of plugins. A plugin adds a browser module with ctx.ui(fn); fn runs in the
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

```ts
export default Plugin.define({
  id: "todo-panel",
  setup: (ctx) => ctx.ui(({ html, ui, useSession, useProjection }) => {
    const Todos = () => {
      const session = useSession()
      const state = useProjection(session, "todo")
      if (!state) return null
      return html`<h3>Todos</h3><ul>${state.items.map((i) => html`<li>${i.done ? "✓" : "○"} ${i.text}</li>`)}</ul>`
    }
    ui.slot("panel", Todos)
  })
})
```

You cannot see the page: after changing the UI, ask the user to check it.

Errors that UI modules throw in the browser are appended, one JSON line each,
to `web-errors.log` in the Pie home. Files of this plugin: `index.ts` (server and
API), `shell.html` (the page: header, slots, recovery menu), `ui-sdk.js` (the
browser SDK). Change the page by editing `shell.html`, not by hiding parts of it
from another plugin.
