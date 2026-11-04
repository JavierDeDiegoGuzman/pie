# Changelog

All notable changes to `pie-agent` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (before 1.0, minor versions may break).

## [0.1.0] - 2026-11-04

First public release.

### Core

- Sessions as an append-only tree of events (SQLite by default, in memory for tests);
  branching with `navigate`.
- The agent as a pure program: `evolve(state, event)` and `decide(state, now)` returning
  commands (`CallModel`, `RunTool`, `Deliver`, `EndRun`, `WakeAt`), run by a level-triggered
  tick with deterministic, idempotent event ids.
- Durability: resumes open runs after a crash or restart without repeating model calls or
  side effects; tools that are not idempotent report "outcome unknown" instead of running
  twice; model retries with durable backoff; idle timeout for stalled model streams;
  cooperative abort; one runtime per database.
- "Model-visible means logged": every model request records its system prompt and tools.
- `steer` and `followUp` inputs, model selection per session, live stream of events and
  text deltas.
- Effect workflows (`Activity`, `DurableDeferred`, `DurableClock`) journaled in the same
  database.

### Plugins

- Every feature outside the core is a plugin: an Effect with its own scope that registers
  tools, models, prompt parts, hooks (`context`, `tool.before`, `tool.after`), event types,
  projections, reactions and web UI modules.
- Plugins live as editable folders in the Pie home (`<home>/plugins/<id>/`), seeded from
  the package's templates. Edits apply by themselves before the agent's next step, after
  being validated in a throwaway composition; refused edits are reported to the agent.
- Every applied change is recorded as a snapshot; rollback from the CLI (`pie rollback`),
  the web page, or automatically by the supervisor when Pie crashes twice in a row at
  startup. Safe mode (`PIE_SAFE=1`) runs the templates.
- The package itself is read-only for the agent's `write` and `edit` tools.

### Built-in plugins

- `opencode-go` (DeepSeek, Kimi, GLM and Qwen models through OpenCode Go),
  `system-prompt`, `context-files` (`AGENTS.md` / `CLAUDE.md`), `coding-tools`
  (`read`, `write`, `edit`, `bash`), `self`, `web` and `web-chat` (web interface on
  127.0.0.1 with a token), and `todo` as an example.

### CLI

- `pie serve`, `pie explain`, `pie rollback`.

[0.1.0]: https://github.com/JavierDeDiegoGuzman/pie/releases/tag/v0.1.0
