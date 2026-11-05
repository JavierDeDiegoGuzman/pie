# @pie-agent/plugins

The official extensions for [Pie](https://javierdediegoguzman.github.io/pie/). The SDK
([`pie-agent`](https://www.npmjs.com/package/pie-agent)) has none of its own: you pass the ones
you want, in code.

```ts
import { Pie, Storage } from "pie-agent"
import { codingTools, contextFiles, opencodeGo, systemPrompt } from "@pie-agent/plugins"

const PieLive = Pie.layer({
  storage: Storage.sqlite("pie.db"),
  plugins: [opencodeGo, systemPrompt, contextFiles, codingTools]   // or: defaults
})
```

| Export | What it does |
|---|---|
| `opencodeGo` | Models from OpenCode Go (`OPENCODE_GO_API_KEY`, or the credential pi stores) |
| `systemPrompt` | The base prompt and the session environment |
| `contextFiles` | `AGENTS.md` / `CLAUDE.md` from `~/.pie` and from the repo root down to the cwd |
| `codingTools` | pi's tools: `read`, `write`, `edit`, `bash` |
| `todo` | Example: a todo list as events, with a projection (`session.projection("todo")`) |
| `defaults` | `[opencodeGo, systemPrompt, contextFiles, codingTools]` |
| `OpenCodeGo` | The provider client, to build your own model extension on top |

Options go with the extension: `{ plugin: opencodeGo, options: { models: ["kimi-k3"] } }`.
