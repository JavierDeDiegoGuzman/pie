# pie-agent

**Pie** is a durable, self-modifying coding agent built on [Effect](https://effect.website).
It follows [pi](https://pi.dev)'s idea of a minimal core, and adds two
things:

- **Durable.** Everything a session does is an event in an append-only log (SQLite by
  default). The agent is a pure `evolve`/`decide` program over that log, so a crash, a
  `kill -9` or a restart resumes exactly where it stopped: no repeated model calls, no
  repeated side effects, and tools that cannot be safely repeated report "outcome unknown".
- **Self-modifying, with undo.** Everything except the small core is a plugin, and every
  plugin is a folder of TypeScript the agent can read and edit with its ordinary tools.
  Edits apply by themselves before the agent's next step; a plugin that does not load is
  refused with its errors. Every applied change is a snapshot you can roll back to from the
  web page, the terminal, or automatically when Pie stops starting.

> **Status: 0.1, experimental.** The event format and the plugin API may still change.

## Quick start

Requires Node.js 22.18 or newer.

```sh
npx pie-agent serve --home .pie --cwd .
```

This creates a Pie home in `.pie/` (sessions in `pie.db`, plugins in `plugins/`) and prints
a URL with an access token for the web interface (served on 127.0.0.1 only). `--port` picks
the port.

The default model is DeepSeek v4.1 Flash through [OpenCode Go](https://opencode.ai). Pie
reads the key from `OPENCODE_GO_API_KEY`, or from the credential pi stores in
`~/.pi/agent/auth.json`. Other providers are plugins (see `plugins/opencode-go`).

## What the agent gets

Like pi, the model sees few tools: `read`, `write`, `edit` and `bash`. The rest is plugins:

| Plugin | What it does |
|---|---|
| `opencode-go` | Models from OpenCode Go |
| `system-prompt` | The base prompt and the session environment |
| `context-files` | `AGENTS.md` / `CLAUDE.md` from `~/.pie` and from the repo root down to the cwd |
| `coding-tools` | `read`, `write`, `edit`, `bash` |
| `self` | Tells the agent where its plugins, the SDK and the docs are, and how to undo changes |
| `web`, `web-chat` | The web interface: a page with slots that plugins fill, and the chat |
| `todo` | Example: a todo list as events, with a projection and a web panel (not seeded by default) |

## Undoing changes

```sh
pie explain  --home .pie            # loaded plugins and the history of snapshots
pie rollback --home .pie --to 12    # put the plugins folder back to snapshot #12
pie rollback --home .pie --last-good
PIE_SAFE=1 pie serve --home .pie    # start with the SDK's templates, ignoring the folder
```

`pie serve` runs Pie under a supervisor: if Pie crashes twice in a row right after starting,
it restores the last snapshot that ran well.

## Using the SDK

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

A session also has `steer`, `followUp`, `abort`, `navigate` (branch from an earlier event),
`setModel` and `live` (a stream of events and text deltas).

## Writing plugins

A plugin is a folder with an `index.ts`:

```ts
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from "pie-agent"

export default Plugin.define({
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

Plugins can add event types, projections (state folded from events), reactions, prompt
parts, context hooks, tool policies, models and web UI. See
[docs/PLUGINS.md](packages/sdk/docs/PLUGINS.md).

## Documentation

The website is at **https://javierdediegoguzman.github.io/pie/**. The same docs are in this repo:


- [docs/PLUGINS.md](packages/sdk/docs/PLUGINS.md): the plugin API, with examples
- [docs/EVENTS.md](packages/sdk/docs/EVENTS.md): the event model, the tick, durability and undo
- [docs/CORE.md](packages/sdk/docs/CORE.md): what is core and what is a plugin
- [docs/architecture.md](packages/sdk/docs/architecture.md): diagrams, edge cases and the SDK API
- [docs/REFERENCES.md](packages/sdk/docs/REFERENCES.md): ideas taken from pi, OpenCode and the DeepSeek Harness

## Development

```sh
pnpm install
pnpm check        # types
pnpm test         # unit, durability (real SIGKILLs) and web tests
pnpm build && pnpm pack:smoke   # pack, install with npm in an empty folder, run
PIE_LIVE=1 pnpm test            # also against the real model
pnpm site:dev                   # the website (apps/site; Astro needs Node 22.23.4+)
```

## License

[MIT](LICENSE)
