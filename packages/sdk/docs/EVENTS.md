# Pie: everything is events

What is durable is always events; what is live is always effects derived from
them. Diagrams in `docs/architecture.html`.

## Two logs, one database

| Log | Table | What it stores | Shape |
|---|---|---|---|
| Session | `pie_events` | Everything that happens in a session: core and plugins | Tree; the current branch goes from the root to `leaf_id` |
| Configuration | `pie_config` | Snapshots of the plugins folder (`plugins/snapshot`) and good-configuration marks (`config/good`) | Linear |

Every event has a deterministic id and is appended idempotently: repeating a
step after a restart never duplicates anything.

## The agent as an Elm program (`core/Agent.ts`)

```
evolve(state, event) → state       pure
decide(state, now)   → commands    pure
```

Core events:

| Event | Meaning |
|---|---|
| `run/started`, `user` | A run starts with the prompt |
| `input/queued` | A steer or followUp waiting; `decide` delivers it as `user` at the right time |
| `model/requested` | What was sent to the model: system prompt and offered tools («model-visible means logged»); the messages are the preceding branch |
| `model/responded` / `model/failed` | Full response, or failure with a retry time |
| `tool/started` / `tool/finished` | A tool started / finished |
| `abort/requested` | Durable abort |
| `run/ended` | `completed`, `failed` or `aborted` (no turn limit: it stops with abort) |
| `model/selected` | Model change |
| `notice` | Something Pie tells the model before a step (plugin changes applied or refused); the model sees it as a message |

Commands returned by `decide`: `CallModel`, `RunTool`, `Deliver`, `EndRun` and
`WakeAt` (nothing to do until a given time: the runtime schedules a wake-up
timer; this is how retries with backoff work).

The durability rules come from the log itself:

| Situation after a restart | What `decide` sees | What happens |
|---|---|---|
| Model call without a response | `model/requested` without `model/responded` | The call is repeated (and paid again) |
| Idempotent tool half done | `tool/started` without `tool/finished` | It is repeated |
| Non-idempotent tool half done | The same | It is not repeated: «outcome unknown» |
| Model failure with a pending retry | `model/failed` with `retryAt` | It waits until that time |
| Abort requested while the process was down | `abort/requested` | Pending work is closed and the run ends `aborted` |

## The tick (`core/Runtime.ts`)

```
tick(session) = fold the branch → decide → execute what is pending → results come back as events
```

It fires when an event is appended, when a `WakeAt` is due and when the process
starts (all open runs resume). It is *level-triggered*: work in progress is
tracked in memory and every event has a deterministic id, so repeating a tick
never duplicates work. A lock in the database (`pie_lock`) guarantees a single
runtime per database.

## Plugins: effects that register functions over events

A plugin is an `Effect` with its own `Scope`. What it registers goes away with
it; the events it emitted stay in the log.

| Level | API | What it does | Can it change what the core does? |
|---|---|---|---|
| extend | `ctx.events({ added: schema })` | Its own event types (`<plugin>/added`) | No |
| derive | `ctx.projection({ id, initial, on })` | State as a fold of the branch; recomputed, never stored | No |
| react | `ctx.react({ id, on, run })` | Acts after the event is in the log; durable cursor per session | No |
| view | `ctx.hook("context", …)` | What it adds to the model's context | No |
| policy | `ctx.hook("tool.before", …)` | Allow or deny a tool | Yes: trusted plugins only |

Tools emit with `tool.emit(type, data)`; reactions, with `r.emit`. Events record
**facts**, not values computed from the state: tools in the same step run in
parallel, so ids, counters and totals are derived in the projection (the `todo`
plugin is the example).

## Self-modification and rollback

**The SDK is fixed; every plugin can be modified.** Each Pie installation has a
home (`.pie`): `pie.db` (sessions and configuration log) and `plugins/`, one
folder per plugin with its `index.ts` and whatever it needs (the `web` plugin
keeps its `shell.html` and `ui-sdk.js` there). A new home is seeded from the
SDK templates (`packages/sdk/plugins/`).

As in pi, the prompt tells the agent where its plugins, the SDK (read-only), the
templates and the documentation are. The agent reads and edits them with its
normal tools (`read`, `edit`, `write`). There is no tool to apply them and no
restart: as in OpenCode or the DeepSeek Harness, Pie applies the changes by
itself at a clean point (before the next step of any session, never in the
middle of a tool):

```
before each model call: did the folder change?
  → validate the changed plugins in a throwaway composition
  → if they load: plugins/snapshot (the whole folder) and they are applied in this process
  → if not: nothing is applied
  → in both cases, a `notice` event in the session: the agent reads it as a
    message from Pie (applied, or the errors) and the chat shows it
```

`plugins.json` sets the order and the disabled plugins. A host plugin
(`sdk-guard`, outside the folder) denies `write`/`edit` inside the SDK; `bash`
could get around it, so it is a barrier for the normal path, not a sandbox.

Ways to roll back (all of them restore a snapshot of the folder and record it as
a new snapshot, so they can be undone too):

| Path | How | Depends on plugins |
|---|---|---|
| Automatic | After running fine for a while, or when a run completes, `config/good` is appended. If the process crashes twice in a row right after starting, the supervisor restores the last good one | No |
| Agent | `pie explain` / `pie rollback` with bash; applied before its next step | No (bash only) |
| Web interface | «Plugins & undo» menu and broken-module banner («Disable») | Yes (`web`) |
| Terminal | `pie explain`, `pie rollback --to N` or `--last-good` (with `--home`) | No |
| Safe mode | `PIE_SAFE=1`: loads the SDK templates instead of the folder | No |

Changes made by hand while Pie is off are recorded at startup.

## Web interface (`web` and `web-chat` plugins)

- The `web` plugin serves on 127.0.0.1 with a token: the base page (`header`,
  `sidebar`, `main` and `panel` slots and the recovery menu), the browser SDK
  (`@pie/ui`), Preact + htm with no build step, and the API with SSE.
- Each plugin contributes a browser module with `ctx.ui(fn)`; `fn` is serialized
  and receives the SDK. Each module is isolated: if it fails, the page says so
  and offers to remove it or undo. Changes reach the page live.
- The chat is another plugin (`web-chat`) and the task panel comes from `todo`.
- The base page (header included) is `plugins/web/shell.html`: to change it,
  edit that file; do not cover it from another plugin with CSS.
- How to build UI with plugins: `plugins/web/README.md`. Browser module errors are stored in `<home>/web-errors.log`.
- `pie serve --home .pie --cwd .` launches the app under the supervisor.

## Effect workflows on the same database (`core/LogWorkflowEngine.ts`)

For multi-step processes written as code (`Activity`, `DurableDeferred`,
`DurableClock`): it is Effect's in-memory engine plus a journal
(`pie_workflow`) of executions, activity results, deferreds, clocks and final
results. Registering a workflow resumes its pending executions; a clock keeps
its original time across a restart.

## Known limits

- The workflow journal is not part of the session tree: forking a session does
  not fork the workflows it started.
- Postgres/MySQL: the client is missing and `INSERT OR IGNORE` needs adapting.
- Projections: recomputed by folding the whole branch on every read; very long
  sessions will need snapshots.
- Hot reloading keeps old module versions in memory (Node does not unload ESM);
  restarting Pie now and then frees them.
- UI modules are not validated before they are installed (there is no browser on
  the server): an error shows up on the page, which offers to remove it or undo.
- The web interface is for one person, locally: a UI module has the same power
  as the agent.
