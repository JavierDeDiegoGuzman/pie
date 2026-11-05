# Pie: everything is events

What is durable is always events; what is live is always effects derived from
them. Diagrams in [architecture.md](architecture.md).

## One log

Everything that happens in a session, core and extensions, is an event in
`pie_events`: a tree, whose current branch goes from the root to the session's
`leaf_id`. Every event has a deterministic id and is appended idempotently:
repeating a step after a restart never duplicates anything.

## The agent loop, written over the log (`core/Agent.ts`)

pi's loop is ordinary code, with the conversation in memory and the session
file as a record of what happened:

```
loop: call the model → append its message → run its tool calls → append the results
      → deliver steering → stop when there are no tool calls and no follow-ups
```

Pie runs the same loop, but the log is the truth and the loop is two pure
functions over it:

```
evolve(state, event) → state       how each event changes the state
decide(state, now)   → commands    what is missing: call the model, run a tool, deliver, end, wait
```

The runtime executes the commands and their results come back as events. The
price is that the loop is spread over two functions instead of one `while`; what
it buys is that resuming after a crash is just another step (fold the log, ask
`decide`), and that the code of the loop may change between two steps of a run:
`decide` reads only the log, so a program that restarts into new code in the
middle of a run carries on.

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
| `notice` | Something the host told the model before a step; the model sees it as a message (written by earlier versions) |

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
never duplicates work. The database is opened in SQLite's exclusive mode: one process per database,
and a second one fails at startup.

## Extensions: effects that register functions over events

An extension is an `Effect` with its own `Scope`. What it registers goes away
with it; the events it emitted stay in the log.

| Level | API | What it does | Can it change what the core does? |
|---|---|---|---|
| extend | `ctx.events({ added: schema })` | Its own event types (`<extension>/added`) | No |
| derive | `ctx.projection({ id, initial, on })` | State as a fold of the branch; recomputed, never stored | No |
| react | `ctx.react({ id, on, run })` | Acts after the event is in the log; durable cursor per session | No |
| view | `ctx.hook("context", …)` | What it adds to the model's context | No |
| policy | `ctx.hook("tool.before", …)` | Allow or deny a tool | Yes |

Tools emit with `tool.emit(type, data)`; reactions, with `r.emit`. Events record
**facts**, not values computed from the state: tools in the same step run in
parallel, so ids, counters and totals are derived in the projection (the `todo`
extension is the example). A program reads a projection with
`session.projection(id)`.

## Restarts, and programs that change themselves

One process owns a database: `Storage.sqlite` opens the file in SQLite's
exclusive mode, so a second process fails at startup with `StorageLocked`, and
the operating system releases the file when the owner ends, however it ends.

Restarting is therefore always safe, and that is what lets a program that embeds
Pie change itself. Its agent edits the program's source, a script checks the
change (types, build, a boot test), commits it and ends the process; the service
manager starts the new version and Pie resumes the run there. The agent reads
the script's output and goes on. `sdk-guard` denies `write`/`edit` inside the
installed SDK, so the agent changes the program, not Pie (`bash` could get
around it: it is a barrier for the normal path, not a sandbox).
[`examples/app`](https://github.com/JavierDeDiegoGuzman/pie/tree/main/examples/app)
is a complete example.

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
- Data that is not part of a session (shared by every thread, like a project's
  tasks) has no home in Pie yet: it lives in the program, or in files.
- While Pie runs, nothing else can open its database, not even to read.
