# Changelog

All notable changes to Pie (`pie-agent`, `@pie-agent/plugins`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (before 1.0, minor versions may break).

## [Unreleased]

Pie becomes an SDK you embed: extensions are passed in code, and a program that embeds Pie
changes itself by restarting, which is safe at any moment.

### Changed

- Two packages. `pie-agent` is only the SDK: no extensions, no model, no CLI. The official
  extensions (and the OpenCode Go provider) are `@pie-agent/plugins`.
- Extensions are passed in code only: `Pie.layer({ storage, plugins: [opencodeGo, codingTools] })`.
  An extension that fails to load fails the boot.
- `Pie.layer` takes `storage` (default `Storage.memory`) instead of `home`.
- One process per database is enforced by SQLite's exclusive locking mode instead of a heartbeat
  row. A second process fails at startup with `StorageLocked`; before, a single failed heartbeat
  let it take over a database another process was still using. Nothing else can open the file
  while Pie runs, not even to read.

### Added

- `session.projection(id)`: the value of an extension's projection on the session's branch, so a
  program can show it.
- Images (any file) in messages: `prompt`, `steer` and `followUp` take `attachments` (bytes or
  base64). Stored once by hash: the bytes in `attachments/` next to the database, the reference in
  `pie_attachments`. The model gets them as file parts; `session.attachment(blob)` reads them back.
- `Pie.layer({ attachments })`: where attached files go, like `storage` for the database.
  `Attachments.folder(dir)`, `Attachments.memory`, or any layer that provides `Attachments`.
- `session.editQueued(inputId, text, { attachments })`: rewrite a queued message before it is
  delivered (event `input/edited`).
- The queue of messages sent while a run is active: `session.queued`, `session.deliverNow(inputId)`
  (a follow-up becomes a steer) and `session.cancelQueued(inputId)`, as the events `input/changed`
  and `input/cancelled`.
- `pie.list` returns each session's title (its first message), last activity, status (`running` or
  `idle`) and last outcome, most recent first.
- `examples/app`: a phone-first chat whose agent changes the app itself (`npm run apply`: check,
  commit, restart), run as a systemd service.

### Removed

- The editable plugins folder and everything around it: seeding from templates, validation in a
  throwaway composition, applying edits before the next step, safe mode, `required`, module
  resolution for plugins without `node_modules`, `PluginLoader`.
- `ctx.pie` and `ctx.ui`, the `web`, `web-chat` and `self` plugins, and the `pie` CLI
  (`@pie-agent/cli`).
- Undo: snapshots, the configuration log, rollback, the supervisor and `reload: "restart"`.

### Fixed

- A delivered `followUp` (or a steer delivered when the run would stop) ended the run without the
  model answering it. Now the model is called again; a steer that arrives just as the model
  finishes without tools is delivered instead of staying queued.
- The exclusive lock on the database is taken with an empty `BEGIN EXCLUSIVE` transaction; the
  `pie_meta` table, written only to take it, is gone.

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
