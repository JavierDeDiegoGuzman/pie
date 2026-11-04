# Architecture

What is durable is always events (the session log and the configuration log);
what is live is effects derived from them. If something can be a plugin, it is
a plugin. Details in [EVENTS.md](EVENTS.md).

## 1 · Fixed core and plugins

![Core and plugins](diagrams/layers.svg)

## 2 · The tick

The agent is an Elm program: `evolve(state, event)` and `decide(state, now)` are
pure. The runtime folds the branch, asks `decide` what is missing and executes
it; the results come back to the log as events. Resuming after a restart is the
same as any other tick.

![The tick](diagrams/tick.svg)

## 3 · A prompt from start to finish

![A prompt from start to finish](diagrams/prompt-flow.svg)

`model/requested` stores the system prompt and the offered tools: what the model
sees is in the log. Event ids are deterministic (run, turn, call), so repeating a
step never duplicates anything.

## 4 · Self-modification

The SDK is fixed; each plugin is a folder in `.pie/plugins/` that the agent edits
with its normal tools. Pie applies the changes by itself before the next step, or
tells the agent why not with a `notice` event. Each applied change stores a full
snapshot of the folder; going back to any of them is `pie rollback` (the agent
runs it with bash; also from the web page, or by the supervisor if Pie does not
start).

![Self-modification](diagrams/self-modification.svg)

## 5 · What is persisted

![Data model](diagrams/persistence.svg)

| Table | What it stores |
|---|---|
| `pie_events` | The whole session, as a tree: core and plugin events |
| `pie_sessions` | cwd, initial model and leaf of the current branch |
| `pie_config` | Snapshots of the plugins folder and good-configuration marks |
| `pie_cursors` | How far each reaction has processed in each session |
| `pie_workflow` | Journal of the Effect workflows: executions, activities, deferreds, clocks, results |
| `pie_lock` | One runtime per database |

Streaming deltas are never stored: they go through `session.live`. Plugin
projections are not stored either: they are recomputed by folding the branch.

## 6 · States of a run

![States of a run](diagrams/states.svg)

## 7 · Environments

![Environments](diagrams/environments.svg)

## 8 · Edge cases

| Case | What happens | Status |
|---|---|---|
| SIGKILL with a model turn already answered | The model is not called again. | tested |
| SIGKILL during an idempotent tool | It is repeated. | tested |
| SIGKILL during a non-idempotent tool | It is not repeated: "outcome unknown". | tested |
| SIGKILL in the middle of the model stream | `model/requested` without a response: the call is repeated. | implemented |
| Provider failure | `model/failed` with a retry time; 3 attempts with backoff; then `failed`. | tested |
| prompt with an active run / steer / followUp | SessionBusy; steer after the tools; followUp at the end, in the same run. | tested |
| abort during a tool | The tool is cut off, the run ends `aborted`, the session is free. | tested |
| Tool ids repeated across turns | Event ids include the turn. | tested |
| Parallel plugin tools that read state | Events record facts; ids and counters are derived by the projection. | tested |
| Forking (navigate) with plugin state | The projection is that of the branch. | tested |
| A plugin edit that does not load | Refused at validation; nothing changes; the agent gets the errors. | tested |
| A new plugin in the middle of a run | Applied before the next step; its tool appears in that call. | tested |
| Pie crashes twice in a row at startup | The supervisor restores the last good snapshot. | tested |
| Effect workflow with SIGKILL | Completed activities are not repeated; the clock keeps its time; the approval resumes it; the result is stored. | tested |
| Two processes on the same database | Lock with a 3 s expiry; the second one waits up to 10 s and fails. | implemented |
| New reaction on existing sessions | It starts from now, not from the history. | implemented |
| Very long sessions | Projections fold the whole branch on every read; snapshots will be needed. | pending |
| Forking a session with running workflows | The workflow journal is not part of the session tree. | risk |
| Changing core event types or payloads | They are the durable contract: compatible changes only. | risk |

## 9 · SDK API

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Stream } from "effect"
import { Pie } from "pie-agent"

const PieLive = Pie.layer({
  home: ".pie",                     // sessions (pie.db) and the editable plugins folder
  seed: [...Pie.DEFAULT_SEED, "web", "web-chat"],
  pluginOptions: { web: { port: 4100 } }
})

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: "/repo", model: "opencode-go/deepseek-v4.1-flash" })
  yield* session.live.pipe(Stream.runForEach((event) => Effect.log(event.type)), Effect.forkScoped)
  yield* session.prompt("fix the test")
  const outcome = yield* session.awaitIdle   // completed | failed | aborted
  const events = yield* session.events       // the current branch: the whole truth
  yield* session.navigate(events[1]!.id)     // the next prompt branches from there
})

NodeRuntime.runMain(program.pipe(Effect.provide(PieLive), Effect.scoped))
```

Writing plugins: [PLUGINS.md](PLUGINS.md).
