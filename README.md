# pie-agent

**Pie** is a durable coding agent you embed in your own program, built on
[Effect](https://effect.website). It follows [pi](https://pi.dev)'s idea of a minimal core:
four tools, and everything else as extensions you pass in code.

- **Durable.** Everything a session does is an event in an append-only log (SQLite). After a
  crash, a `kill -9` or a restart, open runs resume where they stopped: no repeated model
  calls, no repeated side effects, and tools that cannot be safely repeated report "outcome
  unknown".
- **Made to be restarted.** Because restarting loses nothing, a program that embeds Pie can let
  its agent change the program itself, check it, and restart into the new version in the middle
  of a run. The agent carries on in the new process.

> **Status: 0.1, experimental.** The event format and the extension API may still change.

| Package | |
|---|---|
| [`pie-agent`](packages/sdk) | The SDK: the event log, the agent loop, the runtime, the extension API. No extensions of its own |
| [`@pie-agent/plugins`](packages/plugins) | The official extensions: OpenCode Go models, pi's tools, the base prompt, `AGENTS.md` files |

## Quick start

Requires Node.js 22.18 or newer.

```sh
npm install pie-agent @pie-agent/plugins effect @effect/platform-node
```

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { Pie, Storage } from "pie-agent"
import { codingTools, contextFiles, opencodeGo, systemPrompt } from "@pie-agent/plugins"

const program = Effect.gen(function*() {
  const pie = yield* Pie.Pie
  const session = yield* pie.create({ cwd: process.cwd(), model: "opencode-go/deepseek-v4.1-flash" })
  yield* session.prompt("Add a test for src/math.ts")
  const outcome = yield* session.awaitIdle // { status: "completed" | "failed" | "aborted" }
  for (const event of yield* session.events) console.log(event.type)
})

const PieLive = Pie.layer({
  storage: Storage.sqlite("pie.db"),
  plugins: [opencodeGo, systemPrompt, contextFiles, codingTools]
})

NodeRuntime.runMain(program.pipe(Effect.provide(PieLive), Effect.scoped))
```

The default model is DeepSeek v4.1 Flash through [OpenCode Go](https://opencode.ai): set
`OPENCODE_GO_API_KEY`, or log in with pi (Pie reads `~/.pi/agent/auth.json`). Any other model
is an extension of a dozen lines; see [Using the SDK](packages/sdk/docs/SDK.md).

A session also has `steer`, `followUp`, `abort`, `navigate` (branch from an earlier event),
`setModel`, `projection` (state an extension folds from events) and `live` (a stream of events
and text deltas).

## A program that changes itself

[`examples/app`](examples/app) is a personal app built this way: a chat (one thread at a time
and a list of threads) whose agent works on the app's own source. Ask it, from your phone, for
a new page or a different header; it edits the code and runs `npm run apply`, which checks the
change (types, build, a boot test), commits it and restarts the app. systemd starts the new
version, the agent's run continues in it, and the open page reloads by itself.

```sh
pnpm build && examples/app/create.sh ~/pie-app
cd ~/pie-app && npm start          # or run it as a service: examples/app/pie-app.service
```

## Extensions

Like pi, the model sees few tools: `read`, `write`, `edit` and `bash`. The rest is extensions:

| Extension | What it does |
|---|---|
| `opencodeGo` | Models from OpenCode Go |
| `systemPrompt` | The base prompt and the session environment |
| `contextFiles` | `AGENTS.md` / `CLAUDE.md` from `~/.pie` and from the repo root down to the cwd |
| `codingTools` | `read`, `write`, `edit`, `bash` |
| `todo` | Example: a todo list as events, with a projection the program can show |

An extension is a value you pass to `Pie.layer`:

```ts
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "pie-agent"

export const wordCount = Plugin.define({
  id: "word-count",
  setup: (ctx) =>
    ctx.tools.transform((tools) => {
      tools.set("word_count", defineTool({
        name: "word_count",
        description: "Count the words of a text",
        parameters: Schema.Struct({ text: Schema.String }),
        idempotent: true,
        execute: ({ text }) => Effect.succeed({ content: String(text.split(/\s+/).filter(Boolean).length) })
      }))
    })
})
```

Extensions can also add event types, projections (state folded from events), reactions, prompt
parts, context hooks, tool policies and models. See [docs/PLUGINS.md](packages/sdk/docs/PLUGINS.md).

## Documentation

The website is at **https://javierdediegoguzman.github.io/pie/**. The same docs are in this repo:

- [docs/SDK.md](packages/sdk/docs/SDK.md): using Pie from code, choosing extensions, your own model, restarting safely
- [docs/PLUGINS.md](packages/sdk/docs/PLUGINS.md): the extension API, with examples
- [docs/EVENTS.md](packages/sdk/docs/EVENTS.md): the event model, the tick and durability
- [docs/CORE.md](packages/sdk/docs/CORE.md): what is core and what is an extension
- [docs/architecture.md](packages/sdk/docs/architecture.md): diagrams, edge cases and the SDK API
- [docs/REFERENCES.md](packages/sdk/docs/REFERENCES.md): ideas taken from pi, OpenCode and the DeepSeek Harness

## Development

```sh
pnpm install
pnpm check        # types
pnpm test         # unit, durability (real SIGKILLs), two processes on one database
pnpm build && pnpm pack:smoke   # pack both packages, install with npm in an empty folder, run
PIE_LIVE=1 pnpm test            # also against the real model
pnpm site:dev                   # the website (apps/site; Astro needs Node 22.23.4+)
```

## License

[MIT](LICENSE)
