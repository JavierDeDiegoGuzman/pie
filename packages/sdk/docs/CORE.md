# Pie: core and extensions

Rule: if something can be an extension, it is an extension. The core is what
makes a session durable; everything the agent can do comes from extensions
passed in code. The data model is in [EVENTS.md](EVENTS.md).

## Two packages

| Package | What it is |
|---|---|
| `pie-agent` | The SDK: everything in the table below. No extensions, no model |
| `@pie-agent/plugins` | The official extensions, imported and passed to `Pie.layer` |

## Core

| Piece | File |
|---|---|
| Session log as a tree (single source of truth) | `core/Log.ts` |
| The agent: events, `evolve`, `decide`, what the model sees | `core/Agent.ts` |
| Runtime: the tick, command execution, reactions, draining | `core/Runtime.ts` |
| `PluginHost`: loads each extension in its own `Scope` | `core/PluginHost.ts`, `core/Core.ts` |
| Registries: tools, models, prompt, hooks, event types, projections, reactions | `core/Registry.ts`, `core/State.ts` |
| Effect workflow engine on the database | `core/LogWorkflowEngine.ts` |
| Storage: SQLite opened exclusively (one process per database), or memory | `core/Storage.ts` |
| Live events, in-memory abort | `core/Events.ts`, `core/AbortSignals.ts` |
| Public API and the SDK guard | `Pie.ts` |

`Pie.layer` always loads one extension of its own first, `sdk-guard`: `write`
and `edit` inside the installed SDK are denied.

## Extensions

As in pi, the model sees few tools (read, write, edit and bash) and does the rest
with bash. How to write one: [PLUGINS.md](PLUGINS.md). How to choose them:
[SDK.md](SDK.md).

| Extension (`@pie-agent/plugins`) | In `defaults` | What it does |
|---|---|---|
| `opencodeGo` | Yes | OpenCode Go models (the provider client is `OpenCodeGo`) |
| `systemPrompt` | Yes | Base prompt and session environment |
| `contextFiles` | Yes | `~/.pie/AGENTS.md` and `AGENTS.md`/`CLAUDE.md` from the root to the cwd |
| `codingTools` | Yes | The model's tools, as in pi: read, write, edit and bash (300 s by default) |
| `todo` | No (example) | Task list as events, with a projection and a view for the model |

A program that wants its agent to change it does so with its own code, not
with Pie: see [`examples/app`](https://github.com/JavierDeDiegoGuzman/pie/tree/main/examples/app).

## Pending

Compaction, approvals (the engine already has `DurableDeferred`), skills,
subagents (child workflows), visible retry events, Postgres, projection
snapshots, durable data outside sessions (domains).

## Tests

| File | What it tests |
|---|---|
| `sdk/test/core.test.ts` | `State`, `PluginHost` |
| `sdk/test/agent.test.ts` | Loop over the log: tools, busy, followUp, steer, nulls, repeated ids, missing tool, denying hook, model retries, abort |
| `sdk/test/durability.test.ts` | SIGKILL with SQLite in a real process: model not repeated, idempotent tool repeated, non-idempotent «outcome unknown» |
| `sdk/test/storage.test.ts` | Two processes on one database: the second fails at once; after a kill -9 of the first it opens |
| `sdk/test/workflow.test.ts` | Effect workflow with SIGKILL: activities not repeated, clock keeps its time, approval, stored result |
| `plugins/test/sdk.test.ts` | Only the extensions passed in code load; a model that is not OpenCode Go |
| `plugins/test/plugins.test.ts` | `todo` with forking and parallel adds, read through `session.projection`; reactions; writes to the SDK denied |
| `plugins/test/coding-tools.test.ts` | read, write, edit, bash and `AGENTS.md` |
| `plugins/test/OpenCodeGo.live.test.ts` | Only with `PIE_LIVE=1`: real DeepSeek v4.1 Flash |
| `scripts/smoke.ts` | Both packages packed and installed with npm; the SDK with extensions and SQLite |

Manual test: `node --no-warnings --conditions=pie-source packages/plugins/test/support/live-run.ts <cwd> "<prompt>"`.
