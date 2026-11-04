# Pie: fixed core and plugins

Rule: if something can be a plugin, it is a plugin. The core is what the agent
uses but cannot modify: recovering from a faulty self-modification depends on
it. The data model is in `docs/EVENTS.md`.

## Core (fixed)

| Piece | File |
|---|---|
| Session log as a tree (single source of truth) | `core/Log.ts` |
| Agent program: events, `evolve`, `decide`, view for the model | `core/Agent.ts` |
| Runtime: tick, command execution, reactions, per-database lock, draining | `core/Runtime.ts` |
| Plugin configuration log | `core/ConfigLog.ts` |
| Plugin manager: folder + host, seeding, validation, apply before each step, snapshots, rollback, safe mode, required plugins | `core/Plugins.ts`, `core/PluginFolder.ts` |
| Recovery without plugins (CLI and supervisor) | `core/Recovery.ts`, `cli.ts` |
| `State` and `Composition`: registries that are rebuilt | `core/State.ts` |
| Registries: tools, models, prompt, hooks, event types, projections, reactions | `core/Registry.ts` |
| `PluginHost` (load / replace / unload per `Scope`), `PluginLoader` (directories) | `core/PluginHost.ts`, `core/PluginLoader.ts` |
| Effect workflow engine on the database | `core/LogWorkflowEngine.ts` |
| Live events, in-memory abort, module resolution, storage | `core/Events.ts`, `core/AbortSignals.ts`, `core/ModuleResolution.ts`, `core/Storage.ts` |
| Public API and supervisor | `Pie.ts`, `Supervisor.ts` |

## Plugins

As in pi, the model sees few tools (read, write, edit and bash) and does the rest with bash. Changes in the plugins folder apply by themselves before the next step. How to write a plugin: `docs/PLUGINS.md`.

They live in `<home>/plugins/<id>/` (editable by the agent; they apply by
themselves before the next step). A new home is seeded from `packages/sdk/plugins/<id>/`.

| Template | Seeded by default | What it does |
|---|---|---|
| `opencode-go` | Yes | OpenCode Go models |
| `system-prompt` | Yes | Base prompt and session environment |
| `context-files` | Yes | `~/.pie/AGENTS.md` and `AGENTS.md`/`CLAUDE.md` from the root to the cwd |
| `coding-tools` | Yes | The model's tools, as in pi: read, write, edit and bash (300 s by default) |
| `self` | Yes | No tools: the guide with the paths (plugins, SDK, docs) and how to see or undo changes with the `pie` CLI |
| `todo` | No (example template) | Task list as events, with projection, view and web panel |
| `web` | The app | Local server with token, API, SSE, `shell.html` with slots and recovery menu; guide in its `README.md` |
| `web-chat` | The app | The web interface chat |

Host plugins (in memory, not editable from the folder): `sdk-guard` and the ones
passed by whoever embeds Pie (`Pie.layer({ plugins })`, e.g. fake models in
tests). Ready-to-use app: `pie serve --home .pie --cwd .`.

## Pending

Compaction, approvals (the engine already has `DurableDeferred`), skills,
subagents (child workflows), visible retry events, Postgres, projection
snapshots.

## Tests

| File | What it tests |
|---|---|
| `test/core.test.ts` | `State`, `PluginHost`, loading from files |
| `test/agent.test.ts` | Loop over the log: tools, busy, followUp, steer, nulls, repeated ids, missing tool, denying hook, model retries, abort; `todo` with forking and parallel adds; reactions; self-modification (editing the folder, applied before the next step; refusal of a broken plugin; write to the SDK denied) |
| `test/coding-tools.test.ts` | read, write, edit, bash and `AGENTS.md` |
| `test/durability.test.ts` | SIGKILL with SQLite in a real process: model not repeated, idempotent tool repeated, non-idempotent «outcome unknown» |
| `test/self-modify.test.ts` | Real process, plugins outside the repo: a broken change is refused and a valid one is used in the same run, without restarting |
| `test/recovery.test.ts` | Snapshots, rollback and undoing it, safe mode, required plugins, changes made while Pie was off; the supervisor reverts by itself a plugin that breaks startup; the CLI shows and undoes |
| `test/web.test.ts` | Token, API, end-to-end prompt, SSE, projections, adding a UI plugin, editing `web/shell.html`, and undoing both |
| `test/workflow.test.ts` | Effect workflow with SIGKILL: activities not repeated, clock keeps its time, approval, stored result |
| `test/OpenCodeGo.live.test.ts` | Only with `PIE_LIVE=1`: real DeepSeek v4.1 Flash |

Manual test: `node --no-warnings packages/sdk/test/support/live-run.ts <cwd> "<prompt>"`.
