---
title: Why Pie
description: What Pie keeps from pi, and what rebuilding it on Effect adds.
---

[pi](https://pi.dev) is a minimal terminal coding harness: a small core, four tools, and
extensions, skills and prompt templates for everything else. Pie is a reimplementation of that
idea on [Effect](https://effect.website). It is not a port of pi's code and not affiliated with it.

## What Pie keeps from pi

- A minimal core and a small default tool set: `read`, `write`, `edit`, `bash`.
- Everything else as extensions written in TypeScript, which the agent itself can write.
- `AGENTS.md` / `CLAUDE.md` context files, from the home folder and from the repo root down.
- Sessions as trees you can branch from any point.
- An SDK first: the agent is a library you embed; the interfaces are built on top.

## What Effect adds

| | pi | Pie |
|---|---|---|
| Sessions | Saved as a tree of messages | A tree of events; the agent is a pure `evolve`/`decide` program over it |
| A crash in the middle of a run | You continue the conversation | The run resumes by itself: finished steps are not repeated, and a tool that may have run is reported as "outcome unknown" |
| Extensions | Loaded from folders, reloaded with `/reload` | Plugins with their own Effect scope; edits apply before the next step, after being validated |
| A broken extension | Its errors are logged and the agent goes on | Refused before it is applied; every applied change is a snapshot you can roll back to, automatically if Pie stops starting |
| Plugin state | Up to each extension | Events plus projections (state folded from events), so branching a session branches its state |
| Long processes | Up to each extension | Effect workflows (activities, durable timers, approvals) journaled in the same database |

## What Pie does not have yet

pi is mature: many providers, a polished terminal interface, compaction, skills, packages. Pie
0.1 has one provider plugin (OpenCode Go), a web interface and no terminal UI, and no
compaction yet. See the [changelog](../changelog/) and the
[pending list](../docs/core/#pending).
