# Using the SDK

`pie-agent` is the SDK: the event log, the agent loop, the runtime and the
extension API. It has **no extensions of its own**, not even a model. You
choose them, in code. The official ones are in `@pie-agent/plugins`.

```sh
npm install pie-agent @pie-agent/plugins effect @effect/platform-node
```

## The smallest agent

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

`defaults` from `@pie-agent/plugins` is that same list. Without `storage`,
sessions live in memory and nothing survives the process.

## Pick your plugins

Each plugin does one thing; leave out what you do not want.

| You want | Pass |
|---|---|
| A model | `opencodeGo`, or your own (below) |
| The base prompt and the environment (cwd, date, OS) | `systemPrompt` |
| `AGENTS.md` / `CLAUDE.md` in the prompt | `contextFiles` |
| pi's tools: `read`, `write`, `edit`, `bash` | `codingTools` |
| Your own tools, prompts, policies | your extension (see [PLUGINS.md](PLUGINS.md)) |

Options go with the extension: `{ plugin: opencodeGo, options: { models: ["kimi-k3"] } }`.
Extensions load in order, and one that fails to load fails the boot.

## Your own model, no OpenCode Go

A model is a plugin that adds an entry to the model registry: an id and a layer
that builds an Effect `LanguageModel`. Any provider Effect supports works. With
OpenAI (or any OpenAI-compatible endpoint, through `apiUrl`):

```ts
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Config, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Plugin } from "pie-agent"

const openai = Plugin.define({
  id: "openai",
  setup: (ctx) =>
    ctx.models.transform((models) => {
      models.set("openai/gpt-5.2", {
        id: "openai/gpt-5.2",
        provider: "openai",
        model: "gpt-5.2",
        layer: () =>
          OpenAiLanguageModel.layer({ model: "gpt-5.2" }).pipe(
            Layer.provide(OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") })),
            Layer.provide(FetchHttpClient.layer)
          )
      })
    })
})

const PieLive = Pie.layer({ plugins: [openai, systemPrompt, codingTools] })
// pie.create({ cwd, model: "openai/gpt-5.2" })
```

The `opencode-go` plugin is the same idea with a few more details (the API key from
pi, a session header); its code is in `@pie-agent/plugins`.

## Storage, and restarting without losing anything

`Storage.sqlite(file)` keeps every session in one SQLite file. Pie opens it in
**exclusive** mode: while the process lives, nothing else can open the file, and
a second Pie on it fails at startup with `StorageLocked`. When the process ends,
however it ends, the operating system releases the file.

Restarting is safe at any moment. On startup Pie folds each session's log and
carries on with what was pending: a model call that never answered is made
again, an idempotent tool is run again, a tool that is not idempotent reports
"outcome unknown" to the model instead of running twice.

## Programs that change themselves

That is what makes this work: a program that embeds Pie can let its agent edit
the program's own source, check it, and restart into it, even in the middle of
the run that made the change.

1. The agent's working folder is the program's source (`cwd` of the session).
2. It edits files with `write` and `edit`, and when a change is ready it runs a
   script with `bash` that checks it (types, build, a boot test), commits it and
   ends the process a second later.
3. A service manager (systemd, Docker, a shell loop) starts the new version.
4. Pie resumes the run in the new process; the agent sees its script's output
   and goes on.

[`examples/app`](https://github.com/JavierDeDiegoGuzman/pie/tree/main/examples/app)
is a complete one: a phone-first chat whose agent works on the app itself, with
the `npm run apply` script and a systemd unit. A built-in guard denies `write`
and `edit` inside the installed SDK, so the agent changes the program, not Pie.

## Following a session

```ts
const session = yield* pie.create({ cwd: "/repo", model: "opencode-go/deepseek-v4.1-flash" })
yield* session.live.pipe(Stream.runForEach((event) => Effect.log(event.type)), Effect.forkScoped)
yield* session.prompt("fix the test")
yield* session.steer("use vitest, not jest")     // delivered after the current tool calls
yield* session.followUp("then run the linter")  // delivered when it would otherwise stop
const outcome = yield* session.awaitIdle
const events = yield* session.events             // the current branch: the whole truth
const todo = yield* session.projection("todo")   // state an extension folds from the events
yield* session.navigate(events[1]!.id)           // the next prompt branches from there
```

### Images

Any message can carry files: bytes or base64. Each is stored once, by content hash: with
`Storage.sqlite("…/pie.db")` the bytes are a file in `…/attachments/` and the database keeps
the reference; the events only carry that reference. The model gets them as file parts, so
it needs a model that takes images (DeepSeek v4.1 Flash through OpenCode Go does).

```ts
yield* session.prompt("what is wrong in this screenshot?", {
  attachments: [{ mediaType: "image/png", data: pngBytes, name: "screen.png" }]
})
const user = (yield* session.events).find((e) => e.type === "user")!
const file = yield* session.attachment(user.data.attachments[0].blob)   // { mediaType, data } to show it
```

### Messages sent while the agent works

A `steer` is delivered after the current tool calls; a `followUp`, when the run would
otherwise stop. Until then they are queued, and you can act on them:

```ts
const queued = yield* session.queued              // [{ inputId, kind, text, attachments }]
yield* session.deliverNow(queued[0].inputId)      // a follow-up becomes a steer: the next step sees it
yield* session.cancelQueued(queued[1].inputId)    // withdrawn: the model never sees it
```

Both are events in the log (`input/changed`, `input/cancelled`), so a page that renders the
log can show the queue, and a restart keeps it.

### The list of sessions

```ts
const sessions = yield* pie.list   // most recent first
// [{ id, cwd, model, title, updatedAt, status: "running" | "idle", lastOutcome, ... }]
```

| `Pie.layer` option | |
|---|---|
| `plugins` | Extensions, in order. An extension or `{ plugin, options }` |
| `storage` | `Storage.sqlite(file)` (durable, exclusive) or `Storage.memory` (the default) |

Next: [write an extension](PLUGINS.md), or read how [events and durability](EVENTS.md) work.
