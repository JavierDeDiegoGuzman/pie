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
- An SDK first: the agent is a library you embed, with the extensions you choose; the interfaces are built on top.

## What Effect adds

| | pi | Pie |
|---|---|---|
| Sessions | Saved as a tree of messages; the loop runs in memory | A tree of events that is the truth; the loop is written over it (`evolve`/`decide`) |
| A crash in the middle of a run | You continue the conversation | The run resumes by itself: finished steps are not repeated, and a tool that may have run is reported as "outcome unknown" |
| Extensions | Loaded from folders, reloaded with `/reload` | Passed in code, each in its own Effect scope; a program changes them like any of its code and restarts |
| Restarting in the middle of a run | The run is lost | Safe: the run resumes on the new code, so a program can let its agent change it |
| Extension state | Up to each extension | Events plus projections (state folded from events), so branching a session branches its state |
| Long processes | Up to each extension | Effect workflows (activities, durable timers, approvals) journaled in the same database |

## What Pie does not have yet

pi is mature: many providers, a polished terminal interface, compaction, skills, packages. Pie
0.1 ships one provider extension (OpenCode Go; others are a few lines of code), an example app
with a web chat and no terminal UI, and no compaction yet. See the [changelog](../changelog/) and the
[pending list](../docs/core/#pending).
