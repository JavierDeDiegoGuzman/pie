# References: how pi, OpenCode 2.0 and DeepSeek Harness split core and extensions

Reviewed on 2026-11-03 against the source code: pi-coding-agent 0.73 (npm),
OpenCode `anomalyco/opencode@79c80c7`, DeepSeek Harness
`deepseek-ai/deepseek-harness@8bd0733` (0.2.1-rc.5).

## pi: minimal core, everything else is extensions or packages

- Core: agent loop, session as a tree (JSONL, custom entries with
  `appendEntry`), 7 tools, compaction, skills, prompt templates, model
  registry, settings.
- Extensions: TS modules that subscribe to lifecycle events (`tool_call` to
  block or modify, `context`, `before_provider_request`,
  `session_before_compact`, `session_before_fork`/`_tree`, `input`,
  `model_select`…) and register tools, commands, providers, shortcuts and flags.
  Reload with `/reload`.
- Deliberately outside the core: MCP, subagents, permissions, plan mode, to-dos
  and background bash. They are built with extensions or packages (there are
  examples: `permission-gate`, `plan-mode`, `subagent`, `todo`,
  `custom-compaction`, `git-checkpoint`, `protected-paths`, `sandbox`…).

## OpenCode 2.0: services in the core, 80+ internal plugins

- Core = services with state, persistence or control: session loop, compaction
  execution, permission engine, subagent jobs, scheduling, shell/PTY,
  snapshots, worktrees, MCP, bus, storage.
- Internal plugins: every tool, every provider and the model catalog, the agents
  (plan, goal), the system prompt, the commands and **all configuration
  loading** (each section of `opencode.json` is a plugin that feeds a service
  via `transform`).
- Services expose `State` (`transform`/`reload`). Tools enforce policy by
  calling the core service (`permission.assert`).
- Protected plugins: policy and the connection to OpenCode cannot be removed
  from the repo configuration.

## DeepSeek Harness: «there is no privileged core» (on Cordis)

- Everything is a Cordis plugin, including the LLM adapter, the tool registry,
  the session log and the agent loop itself (`dsh-agent-loop` is swappable).
  There is a «backbone» of `core/*` packages, but each one can be replaced from
  the configuration.
- **Capability seams**: each capability has a service definition, a provider
  and a consumer (usually a tool). Consumers depend on the definition, never on
  the provider. Changing the filesystem and subprocess provider (for example to
  a remote sandbox) moves bash, PTY and LSP at once.
- **«Model-visible means logged»**: the session is an append-only event log
  (`turn/*`, `step/*`, `system/message`, `user/message`, `assistant/message`,
  `assistant/attempt`, `tool/*`). Every request to the model can be rebuilt from
  the log; compaction keeps the original content in the log and replay
  reproduces the same context.
- Composition: profiles made of layers of bundles plus YAML patches; per-session
  presets.
- Self-modification in levels: read-only tools to inspect the runtime;
  process-local dynamic definitions (in `node:vm`, lost on restart); persistent
  changes via the Plugin Manager with hot reload.
- Notable capability families: compaction with several backends (summary,
  pruning of tool results, image offloading); guard (warning on repeated calls,
  timeouts); interaction (`ask`/`never` approval that fails closed and is
  audited, permission presets, `ask_user`); sandbox (bwrap, Landlock,
  Seatbelt); spill (large results to storage with a locator); PTC (the model
  writes a program that calls tools); `workflow` (script with `agent()`,
  `parallel()`, `pipeline()`, `phase()` that hands work out to subagents); team
  (shared task board); goal (durable objective with automatic continuation);
  jobs, schedule and session search (SQLite FTS).

## What Pie takes from each

| Idea | From | For Pie |
|---|---|---|
| Minimal core; MCP, subagents, permissions, plan and to-dos as extensions | pi | Same: they are built as plugins |
| Rich lifecycle events (input, tool_call, context, compaction, fork) | pi | Extend the current hooks |
| Core services with `State`; internal plugins; configuration loaded by plugins | OpenCode | `State` is there; configuration and protected plugins are missing |
| Seams: definition / provider / consumer | DeepSeek | `fs`, `subprocess`, `sandbox`, `llm`, compaction, approval as seams |
| «Model-visible means logged» | DeepSeek | Record in the session what was sent to the model, not only the response |
| Self-modification in levels (inspect / experiment / persist) | DeepSeek | Separate trying a change from persisting it |
| Swappable loop | DeepSeek | No: in Pie the loop is the durable Workflow and stays fixed |

## How a plugin persists state

- **pi**: two ways. `pi.appendEntry(customType, data)` stores a custom entry in
  the session that does not go to the model. The `todo` example stores the full
  state in the `details` of its tool result and rebuilds it by walking **the
  current branch** on `session_start` and `session_tree`, so after forking or
  navigating the state is that of the branch.
- **DeepSeek Harness**: «durable session state = extend `SessionEventMap`» and
  render and replay from the log; registered projections that fold already
  committed events (`ctx.sessionProjections`).
- **canica** (design in the threads «Artifacts de Doconda y Canica» and its fork
  «YepCode», October 2026): commands, models as state machines, events that come
  out of transitions, append-only `_log`, `_outbox`/`_inbox` and dedupe by
  `commandId`. A plugin only adds, with a ladder of power: `ui`, `derive`
  (fields computed on read), `extend` (its own namespaced fields, stored
  separately, and its own commands that only touch those fields), `react`
  (after commit) and `warn` (warns, never blocks). `override`, `guard` and
  `enrich` are left out: what blocks belongs to the core, at «policy points» the
  core declares. Everything a plugin adds is commutative; when it is removed,
  its data is archived, not deleted. The log is never migrated.
