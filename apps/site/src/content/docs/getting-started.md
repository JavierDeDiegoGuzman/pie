---
title: Getting started
description: Install Pie, connect a model, and use the web interface or the SDK.
---

## Requirements

- Node.js 22.18 or newer.
- A model. The default is DeepSeek v4.1 Flash through [OpenCode Go](https://opencode.ai). Pie
  reads the key from `OPENCODE_GO_API_KEY`, or from the credential pi stores in
  `~/.pi/agent/auth.json` if you use pi.

## Run it

```sh
npx pie-agent serve --home .pie --cwd .
```

- `--home` is Pie's home: sessions in `pie.db` and the plugins in `plugins/`. A new home is
  seeded from the templates that ship with the package.
- `--cwd` is the folder the agent works in.
- `--port` picks the port of the web interface (127.0.0.1 only).

Pie prints a URL with an access token. Open it, type a task and send it.

Or install it once with `npm install -g pie-agent` and use the `pie` command.

## Change it

Ask the agent to change itself: "show the model name in the header", "add a tool that runs the
tests", "remove the todo plugin". It edits the plugin that owns that part, and the change applies
before its next step. You see a "Pie: …" notice in the chat: applied, or refused with the errors.

## Undo

```sh
pie explain  --home .pie            # loaded plugins and the history of snapshots
pie rollback --home .pie --to 12    # put the plugins folder back to snapshot #12
pie rollback --home .pie --last-good
PIE_SAFE=1 pie serve --home .pie    # start with the templates, ignoring the folder
```

The web page has the same in its "Plugins & undo" menu. `pie serve` also rolls back by itself
if Pie crashes twice in a row right after starting.

## Use the SDK

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie } from "pie-agent"

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: process.cwd(), model: "opencode-go/deepseek-v4.1-flash" })
  yield* session.prompt("Add a test for src/math.ts")
  const outcome = yield* session.awaitIdle // { status: "completed" | "failed" | "aborted" }
  for (const event of yield* session.events) console.log(event.type)
})

NodeRuntime.runMain(program.pipe(Effect.provide(Pie.layer({ home: ".pie" })), Effect.scoped))
```

Next: [write a plugin](../docs/plugins/).
