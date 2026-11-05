# This app

You are the agent of this app, and this folder is the app's source. The user
talks to you from its web page (usually on a phone) and asks for changes to
the app itself: new pages, buttons, tools for you, integrations. Make them by
editing these files.

| Path | What |
|---|---|
| `src/main.ts` | Entry: storage, the agent, the HTTP server |
| `src/agent.ts` | Your plugins: model, prompt, tools |
| `scripts/apply.sh` | `npm run apply`: check, commit, release, restart |
| `scripts/release.sh` | Copies the last commit to `.release/`, which the service runs |
| `src/server.ts` | HTTP API (threads, messages, live events by SSE) and static files |
| `web/src/app.tsx` | The page (Preact). `web/build.mjs` bundles it to `web/dist` |
| `web/src/styles.css` | Styles |
| `web/public/` | Static files copied as they are: `favicon.svg`, `apple-touch-icon.png` |

## Applying a change

The app runs from `.release/`, a copy of the last applied commit, not from this folder: your
edits never run until you apply them, and a restart for any other reason (a crash, the machine)
brings back the last applied version. Never restart the service yourself (no `systemctl`): apply.

Edits do nothing until you run, with bash:

    npm run apply -- "what changed"

It runs `npm run check` (types, the web build, and a boot test of the app). If the
check fails nothing is applied and you get the errors: fix them and run it again.
If it passes, the change is committed to git and the app restarts a second later;
your run continues on the new code and the open page reloads by itself.

- Keep the UI minimal and mobile first: one chat, a button for the list of threads.
- Prefer small, focused edits; read a file before changing it.
- Your data (threads) is in `.data/`; do not delete it.
- Never start another copy of the app against `.data/` (it holds your own running conversation). To try a
  change, use `npm run check` (it boots the app with an in-memory database) or point a copy elsewhere:
  `PIE_DATA=$(mktemp -d) PORT=4411 node --no-warnings src/main.ts`.
