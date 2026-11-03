import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { Composition, Core, defineTool, Plugin, PluginHost, PluginLoader, Registries } from "../src/index.ts"

const TestLayer = Core.layer.pipe(Layer.provideMerge(NodeServices.layer))

const echo = (name: string, suffix = "") =>
  defineTool({
    name,
    description: `echo ${name}`,
    parameters: Schema.Struct({ text: Schema.String }),
    idempotent: true,
    execute: ({ text }) => Effect.succeed({ content: text + suffix })
  })

const toolsPlugin = (id: string, names: ReadonlyArray<string>, suffix = "") =>
  Plugin.define({
    id,
    setup: (ctx) => ctx.tools.transform((tools) => names.forEach((n) => tools.set(n, echo(n, suffix))))
  })

const toolNames = Effect.gen(function*() {
  const registries = yield* Registries
  return [...(yield* registries.tools.get).keys()]
})

describe("State", () => {
  it.effect("replays transforms in order from a fresh value, exactly once each", () =>
    Effect.gen(function*() {
      const composition = yield* Composition
      const catalog = yield* composition.make({ name: "catalog", initial: () => ({ limit: 0, items: [] as string[] }) })
      let source = ["a", "b"]
      const scope = yield* Scope.make()
      yield* catalog.transform((c) => {
        c.limit = 128
        c.items.push(...source)
      }).pipe(Scope.provide(scope))
      yield* catalog.transform((c) => {
        c.limit /= 2
      }).pipe(Scope.provide(scope))
      expect(yield* catalog.get).toEqual({ limit: 64, items: ["a", "b"] })

      // External data changes: reload re-runs everything once; halving is not compounded.
      source = ["c"]
      yield* catalog.reload
      yield* catalog.reload
      expect(yield* catalog.get).toEqual({ limit: 64, items: ["c"] })

      // Closing the owner scope removes its transforms.
      yield* Scope.close(scope, Exit.void)
      expect(yield* catalog.get).toEqual({ limit: 0, items: [] })
    }).pipe(Effect.provide(TestLayer)))

  it.effect("a throwing transform is skipped and reported, the rest still apply", () =>
    Effect.gen(function*() {
      const composition = yield* Composition
      const list = yield* composition.make({ name: "list", initial: (): string[] => [] })
      yield* list.transform((l) => void l.push("ok"))
      yield* list.transform(() => {
        throw new Error("boom")
      })
      expect(yield* list.get).toEqual(["ok"])
      expect((yield* list.diagnostics).map((d) => d.message)).toEqual(["boom"])
    }).pipe(Effect.scoped, Effect.provide(TestLayer)))
})

describe("PluginHost", () => {
  it.effect("load registers, unload removes everything the plugin registered", () =>
    Effect.gen(function*() {
      const host = yield* PluginHost
      yield* host.load(toolsPlugin("a", ["read", "write"]))
      yield* host.load(toolsPlugin("b", ["grep"]))
      expect(yield* toolNames).toEqual(["read", "write", "grep"])
      yield* host.unload("a")
      expect(yield* toolNames).toEqual(["grep"])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("a failing setup leaves nothing behind", () =>
    Effect.gen(function*() {
      const host = yield* PluginHost
      const broken = Plugin.define({
        id: "broken",
        setup: (ctx) =>
          Effect.gen(function*() {
            yield* ctx.tools.transform((t) => void t.set("half", echo("half")))
            return yield* Effect.fail("setup failed after registering")
          })
      })
      const error = yield* Effect.flip(host.load(broken))
      expect(error._tag).toBe("PluginLoadError")
      expect(yield* toolNames).toEqual([])
      expect(yield* host.list).toEqual([])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("replace is atomic, keeps the plugin position, and rolls back on failure", () =>
    Effect.gen(function*() {
      const host = yield* PluginHost
      const registries = yield* Registries
      const composition = yield* Composition
      yield* host.load(toolsPlugin("first", ["a"]))
      yield* host.load(toolsPlugin("second", ["b"]))

      const before = yield* composition.version
      yield* host.replace(toolsPlugin("first", ["a2"]))
      expect(yield* composition.version).toBe(before + 1) // one observable change, not two
      expect(yield* toolNames).toEqual(["a2", "b"]) // still before "second"

      const failing = Plugin.define({ id: "first", setup: () => Effect.die("syntax-ish error") })
      yield* Effect.flip(host.replace(failing))
      expect(yield* toolNames).toEqual(["a2", "b"]) // old version still running
      const tool = (yield* registries.tools.get).get("a2")!
      expect((yield* tool.execute({ text: "hi" }, { sessionId: "s", runId: "r", toolCallId: "t", cwd: "/", emit: () => Effect.void })).content).toBe("hi")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("plugin finalizers and forked fibers end with the plugin", () =>
    Effect.gen(function*() {
      const host = yield* PluginHost
      const events: string[] = []
      yield* host.load(Plugin.define({
        id: "lifecycle",
        setup: () => Effect.addFinalizer(() => Effect.sync(() => events.push("closed")))
      }))
      expect(events).toEqual([])
      yield* host.unload("lifecycle")
      expect(events).toEqual(["closed"])
    }).pipe(Effect.provide(TestLayer)))
})

describe("PluginLoader", () => {
  const dir = path.join(import.meta.dirname, ".tmp", "plugins")
  const sdkIndex = path.join(import.meta.dirname, "..", "src", "index.ts")
  const pluginSource = (id: string, tool: string) => `
import { Effect, Schema } from "effect"
import { Plugin, defineTool } from ${JSON.stringify(sdkIndex)}
export default Plugin.define({
  id: ${JSON.stringify(id)},
  setup: (ctx) => ctx.tools.transform((tools) => {
    tools.set(${JSON.stringify(tool)}, defineTool({
      name: ${JSON.stringify(tool)},
      description: "written by the agent",
      parameters: Schema.Struct({}),
      idempotent: true,
      execute: () => Effect.succeed({ content: ${JSON.stringify(tool)} })
    }))
  })
})
`

  it.effect("loads new files, replaces edited ones, keeps the old version on errors, unloads deleted ones", () =>
    Effect.gen(function*() {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      const loader = yield* PluginLoader
      const file = path.join(dir, "word-count.ts")

      fs.writeFileSync(file, pluginSource("word-count", "word_count"))
      yield* loader.sync(dir)
      expect(yield* toolNames).toEqual(["word_count"])

      fs.writeFileSync(file, pluginSource("word-count", "word_count_v2"))
      yield* loader.sync(dir)
      expect(yield* toolNames).toEqual(["word_count_v2"])

      fs.writeFileSync(file, "export default {{ this is not typescript")
      const [status] = yield* loader.sync(dir)
      expect(status?.error).toBeDefined()
      expect(yield* toolNames).toEqual(["word_count_v2"])

      fs.rmSync(file)
      yield* loader.sync(dir)
      expect(yield* toolNames).toEqual([])
    }).pipe(Effect.provide(TestLayer)))
})
