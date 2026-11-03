/**
 * Keeps the loaded plugins equal to the configuration log folded over the
 * built-ins. Everything above the kernel is modifiable by the agent, built-ins
 * included; what makes that safe is that every change can be undone:
 *
 *   install(source)  validate in a throwaway composition → plugin/installed → apply
 *   try(source)      load in this process only; keep(id) makes it permanent
 *   rollback(seq)    config/reset: the composition of an earlier point (undoable too)
 *   markGood()       config/good: target of the supervisor's automatic rollback
 *
 * apply is hot (this process, visible from the next model call) or restart
 * (drain to a safe point, then signal the supervisor). Safe mode loads the
 * built-ins only. Required plugins must load or the boot fails, which the
 * supervisor turns into an automatic rollback.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path } from "effect"
import { type ConfigEvent, ConfigLog, type ConfigState, hashSource } from "./ConfigLog.ts"
import * as Core from "./Core.ts"
import type { Plugin } from "./Plugin.ts"
import { type PluginInfo, PluginHost } from "./PluginHost.ts"
import { importPluginModule } from "./PluginLoader.ts"
import { Runtime } from "./Runtime.ts"

export class PluginRejected extends Data.TaggedError("PluginRejected")<{ readonly message: string }> {}

export interface BuiltinEntry {
  readonly plugin: Plugin
  readonly options?: Readonly<Record<string, unknown>> | undefined
}

export interface PluginsOptions {
  readonly builtins: ReadonlyArray<BuiltinEntry>
  /** Plugin ids the agent cannot change. Empty by default: rollback is the safety net. */
  readonly protected: ReadonlySet<string>
  /** Plugin ids that must load; otherwise the boot fails. */
  readonly required: ReadonlySet<string>
  readonly cacheDirectory: string
  /** hot: apply in this process. restart: drain and request a restart. */
  readonly reload: "hot" | "restart"
  /** Load the built-ins only, ignoring what the agent installed or disabled. */
  readonly safe: boolean
}

export interface Explanation {
  readonly safe: boolean
  readonly reload: "hot" | "restart"
  readonly loaded: ReadonlyArray<PluginInfo>
  readonly installed: ReadonlyArray<{ readonly id: string; readonly version: string; readonly seq: number }>
  readonly disabled: ReadonlyArray<string>
  /** In this process only (plugin try). */
  readonly trial: ReadonlyArray<{ readonly id: string; readonly version: string }>
  readonly lastGood: number
  readonly head: number
  readonly history: ReadonlyArray<{ readonly seq: number; readonly type: string; readonly id?: string; readonly version?: string; readonly at: string; readonly note?: string }>
}

export const describe = (event: ConfigEvent) => {
  const data = event.data as { id?: string; hash?: string; toSeq?: number; reason?: string; seq?: number }
  return {
    seq: event.seq,
    type: event.type,
    ...(data.id === undefined ? {} : { id: data.id }),
    ...(data.hash === undefined ? {} : { version: data.hash }),
    at: new Date(event.createdAt).toISOString(),
    ...(event.type === "config/reset" ? { note: `back to #${data.toSeq}: ${data.reason}` } : {}),
    ...(event.type === "config/good" ? { note: `good up to #${data.seq}` } : {})
  }
}

export class Plugins extends Context.Service<Plugins, {
  /** Validates and installs (or updates) a plugin; a built-in's id replaces the built-in. */
  readonly install: (source: string) => Effect.Effect<{ readonly id: string; readonly hash: string }, PluginRejected>
  /** Validates and loads a plugin in this process only (hot reload only). */
  readonly try: (source: string) => Effect.Effect<{ readonly id: string; readonly hash: string }, PluginRejected>
  /** Makes a tried plugin permanent. */
  readonly keep: (id: string) => Effect.Effect<void, PluginRejected>
  readonly remove: (id: string) => Effect.Effect<void, PluginRejected>
  readonly enable: (id: string) => Effect.Effect<void, PluginRejected>
  /** Installs again the source of an earlier version. */
  readonly restore: (id: string, hash: string) => Effect.Effect<void, PluginRejected>
  /** Composition of right after config event `toSeq` (0: built-ins only). Recorded, so it can be undone. */
  readonly rollback: (toSeq: number, reason: string) => Effect.Effect<void, PluginRejected>
  /** Marks the current composition as good (target of automatic rollbacks). */
  readonly markGood: Effect.Effect<void>
  readonly explain: Effect.Effect<Explanation>
  readonly config: Effect.Effect<ConfigState>
  readonly reload: "hot" | "restart"
  /** Completes when a restart was requested and work in flight has drained. */
  readonly restartRequested: Effect.Effect<void>
}>()("pie/Plugins") {
  static readonly make = (options: PluginsOptions) =>
    Effect.gen(function*() {
      const host = yield* PluginHost
      const config = yield* ConfigLog
      const runtime = yield* Effect.serviceOption(Runtime)
      const restart = yield* Deferred.make<void>()
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const loadedVersions = new Map<string, string>()
      const trial = new Map<string, { readonly hash: string; readonly source: string }>()

      const fileOf = (hash: string) => path.join(options.cacheDirectory, `${hash}.ts`)
      const importSource = (source: string) =>
        Effect.gen(function*() {
          const hash = hashSource(source)
          yield* Effect.promise(async () => {
            await fs.mkdir(options.cacheDirectory, { recursive: true })
            await fs.writeFile(fileOf(hash), source)
          })
          const plugin = yield* importPluginModule(fileOf(hash), hash).pipe(
            Effect.mapError((message) => new PluginRejected({ message }))
          )
          return { plugin, hash }
        })

      /** Runs setup in a fresh, throwaway composition: catches errors without touching the live one. */
      const validate = (plugin: Plugin) =>
        PluginHost.use((scratch) => scratch.load(plugin, { trusted: false })).pipe(
          Effect.provide(Layer.fresh(Core.layer)),
          Effect.scoped,
          Effect.provideContext(services),
          Effect.mapError((e) => new PluginRejected({ message: e.message }))
        )

      const builtinOrder = new Map(options.builtins.map((b, i) => [b.plugin.id, (i + 1) * 1000]))
      const isLoaded = (id: string) => Effect.map(host.list, (list) => list.some((p) => p.id === id))

      const loadBuiltin = (entry: BuiltinEntry) =>
        host.replace(entry.plugin, { options: entry.options, order: builtinOrder.get(entry.plugin.id), source: `builtin:${entry.plugin.id}` }).pipe(
          Effect.catchTag("PluginLoadError", (e) => Effect.logWarning(`plugin ${e.id} failed: ${e.message}`))
        )

      const apply = Effect.gen(function*() {
        const state = options.safe ? { installed: new Map(), disabled: new Set<string>() } as const : yield* config.state
        // Agent-installed versions (a built-in's id replaces the built-in).
        for (const [id, entry] of state.installed) {
          if (trial.has(id)) continue
          if (loadedVersions.get(id) === entry.hash) continue
          const result = yield* importSource(entry.source).pipe(
            Effect.flatMap(({ plugin }) =>
              host.replace(plugin, {
                order: builtinOrder.get(id) ?? 1_000_000 + entry.seq,
                source: `config:${entry.hash}`,
                trusted: false
              })
            ),
            Effect.result
          )
          if (result._tag === "Success") loadedVersions.set(id, entry.hash)
          else yield* Effect.logWarning(`plugin ${id} failed to load: ${String(result.failure)}`)
        }
        // Built-ins: loaded unless disabled or replaced.
        for (const entry of options.builtins) {
          const id = entry.plugin.id
          if (state.installed.has(id) || trial.has(id)) continue
          const loaded = yield* isLoaded(id)
          if (state.disabled.has(id)) {
            if (loaded) yield* Effect.ignore(host.unload(id))
            loadedVersions.delete(id)
          } else if (!loaded || loadedVersions.has(id)) {
            loadedVersions.delete(id)
            yield* loadBuiltin(entry)
          }
        }
        // Installed versions that are no longer in the composition.
        for (const id of [...loadedVersions.keys()]) {
          if (state.installed.has(id) || builtinOrder.has(id)) continue
          loadedVersions.delete(id)
          yield* Effect.ignore(host.unload(id))
        }
      })

      const requestChange = Effect.gen(function*() {
        if (options.reload === "hot") return yield* apply
        yield* Effect.forkDetach(Effect.gen(function*() {
          if (runtime._tag === "Some") yield* runtime.value.drain()
          yield* Deferred.succeed(restart, undefined)
        }))
      })

      const guard = (id: string) =>
        options.protected.has(id) ? Effect.fail(new PluginRejected({ message: `"${id}" is protected` })) : Effect.void

      yield* apply
      for (const id of options.required) {
        if (!(yield* isLoaded(id))) return yield* Effect.die(new Error(`required plugin "${id}" did not load`))
      }

      return Plugins.of({
        install: (source) =>
          Effect.gen(function*() {
            const { hash, plugin } = yield* importSource(source)
            yield* guard(plugin.id)
            yield* validate(plugin)
            trial.delete(plugin.id)
            yield* config.append("plugin/installed", { id: plugin.id, source, hash })
            yield* requestChange
            return { id: plugin.id, hash }
          }),
        try: (source) =>
          Effect.gen(function*() {
            if (options.reload !== "hot") {
              return yield* new PluginRejected({ message: "trying a plugin needs hot reload; install it instead" })
            }
            const { hash, plugin } = yield* importSource(source)
            yield* guard(plugin.id)
            yield* validate(plugin)
            yield* host.replace(plugin, { order: builtinOrder.get(plugin.id) ?? 2_000_000, source: `trial:${hash}`, trusted: false }).pipe(
              Effect.mapError((e) => new PluginRejected({ message: e.message }))
            )
            trial.set(plugin.id, { hash, source })
            // Marks the slot as taken, so dropping the trial reloads a replaced built-in.
            loadedVersions.set(plugin.id, `trial:${hash}`)
            return { id: plugin.id, hash }
          }),
        keep: (id) =>
          Effect.gen(function*() {
            const tried = trial.get(id)
            if (!tried) return yield* new PluginRejected({ message: `"${id}" is not being tried` })
            trial.delete(id)
            yield* config.append("plugin/installed", { id, source: tried.source, hash: tried.hash })
            loadedVersions.set(id, tried.hash)
          }),
        remove: (id) =>
          Effect.gen(function*() {
            yield* guard(id)
            if (trial.delete(id)) {
              yield* Effect.ignore(host.unload(id))
              return yield* apply
            }
            const state = yield* config.state
            if (state.installed.has(id)) yield* config.append("plugin/removed", { id })
            if (builtinOrder.has(id) || !state.installed.has(id)) yield* config.append("plugin/disabled", { id })
            yield* requestChange
          }),
        enable: (id) => Effect.andThen(config.append("plugin/enabled", { id }), requestChange),
        restore: (id, hash) =>
          Effect.gen(function*() {
            yield* guard(id)
            const version = (yield* config.history).find((e) =>
              e.type === "plugin/installed" && (e.data as { id: string }).id === id && (e.data as { hash: string }).hash === hash
            )
            if (!version) return yield* new PluginRejected({ message: `no version ${hash} of "${id}" in the history` })
            yield* config.append("plugin/installed", version.data as { id: string; source: string; hash: string })
            yield* requestChange
          }),
        rollback: (toSeq, reason) =>
          Effect.gen(function*() {
            const history = yield* config.history
            if (toSeq !== 0 && !history.some((e) => e.seq === toSeq)) {
              return yield* new PluginRejected({ message: `no configuration event #${toSeq}` })
            }
            for (const id of [...trial.keys()]) {
              trial.delete(id)
              yield* Effect.ignore(host.unload(id))
            }
            yield* config.append("config/reset", { toSeq, reason })
            yield* requestChange
          }),
        markGood: Effect.gen(function*() {
          if (options.safe) return
          const state = yield* config.state
          if (state.head > state.lastGood) yield* config.append("config/good", { seq: state.head })
        }),
        explain: Effect.gen(function*() {
          const history = yield* config.history
          const state = yield* config.state
          return {
            safe: options.safe,
            reload: options.reload,
            loaded: yield* host.list,
            installed: [...state.installed.values()].map(({ hash, id, seq }) => ({ id, version: hash, seq })),
            disabled: [...state.disabled],
            trial: [...trial].map(([id, { hash }]) => ({ id, version: hash })),
            lastGood: state.lastGood,
            head: state.head,
            history: history.map(describe)
          }
        }),
        config: config.state,
        reload: options.reload,
        restartRequested: Deferred.await(restart)
      })
    })

  static readonly layer = (options: PluginsOptions) => Layer.effect(Plugins, Plugins.make(options))
}
