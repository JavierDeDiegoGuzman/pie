# Experiment: an app that is its own agent

No plugins and no slots: the app is ordinary code wrapping the Pie SDK, and its
agent edits that code from the app's own chat. The service manager keeps it up.

```sh
pnpm build                                   # pack-able pie-agent and @pie-agent/plugins
examples/app/create.sh ~/pie-app     # an instance: its own folder and git repo
cd ~/pie-app && HOST=127.0.0.1 PORT=4400 npm start
```

On a VPS, run it as a service with `pie-app.service` (copy it, adjust the folder
and `HOST`, `systemctl --user enable --now pie-app`).

## How it works

| Piece | |
|---|---|
| `template/src/agent.ts` | Pie with the official plugins (OpenCode Go, prompt, AGENTS.md, read/write/edit/bash) and a short prompt that tells the agent it is this app. No extra tools |
| `template/scripts/apply.sh` | `npm run apply`: check, commit, release, restart. The agent runs it with bash |
| `template/scripts/release.sh` | Copies the last commit to `.release/`: the service runs that, never the working copy |
| `template/src/server.ts` | The page, a JSON API over threads and SSE with every event |
| `template/web/src/app.tsx` | The page: one chat and a button for the list of threads |
| `template/AGENTS.md` | Where things are, for the agent |

The cycle of a change:

1. The user asks, in the chat, for a change to the app.
2. The agent edits the files (its working folder is the app).
3. It runs `npm run apply -- "what changed"` with bash. That runs `npm run
   check`: types, the web build, and a boot test of the whole app on a free
   port with an in-memory database. If it fails, nothing is applied and the
   agent reads the errors in the command's output.
4. If it passes: `git commit`, a copy of that commit in `.release/` (with its
   web build), and a second later (from its own session, so
   bash returns first and its result is in the log) the app's process gets a
   SIGTERM.
5. systemd starts the new version from `.release/`. Pie is durable, so the
   agent's run continues in the new process.
6. The open page notices the new version when its live connection comes back
   and reloads itself.

A crash, a `kill -9`, a reboot or a manual `systemctl restart` go through step
5 too, and always start the last applied commit: edits the agent has not
applied never run. (Before `.release/`, a restart in the middle of an edit
loaded the half-written code and the app crash-looped.)

## Results (5 Nov 2026, DeepSeek v4.1 Flash)

Asked from a phone-sized page: "add a small grey text next to the title".
In 19 s the agent read the code, edited `app.tsx` and `styles.css`, called
`restart` (check passed, commit `restart: Add small gray version text…`),
systemd restarted the process, the run finished in the new process with the
answer, and the open page reloaded with the new header. `kill -9` of the
process: systemd had it back in under a second.

Then without the tool, with `npm run apply` through bash: "show the time under
each of my messages". 23 s, same cycle; after the restart the agent went on
(it double-checked where `createdAt` comes from) and answered in the new
process.

## Open questions

- A change that passes the check but breaks the page at runtime (a click
  handler that throws) is not caught. The agent can fix it if the chat still
  works; `git revert` from a shell otherwise.
- The check's boot test uses an in-memory database: a change that only fails
  with real data would get through.
- Several threads running when the agent restarts are all interrupted and
  resumed; fine for one user, worth watching.
