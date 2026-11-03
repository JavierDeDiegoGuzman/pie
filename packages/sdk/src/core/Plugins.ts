/**
 * Keeps the loaded plugins equal to the configuration log folded over the
 * built-ins. Self-modification goes through here:
 *
 *   install(source) → validate in a throwaway composition → append to the
 *   config log → apply: hot (replace now; visible from the next model call)
 *   or restart (drain to a safe point, then signal the supervisor).
 *
 * Protected plugins cannot be removed, disabled or overwritten by the agent.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path } from "effect"
import { ConfigLog, type ConfigState, hashSource } from "./ConfigLog.ts"
import * as Core from "./Core.ts"
import type { Plugin } from "./Plugin.ts"
import { PluginHost } from "./PluginHost.ts"
import { importPluginModule } from "./PluginLoader.ts"
import { Runtime } from "./Runtime.ts"

export class PluginRejected extends Data.TaggedError("PluginRejected")<{ readonly message: string }> {}

export interface BuiltinEntry {
  readonly plugin: Plugin
  readonly options?: Readonly<Record<string, unknown>> | undefined
}

export interface PluginsOptions {
  readonly builtins: ReadonlyArray<BuiltinEntry>
  readonly protected: ReadonlySet<string>
  readonly cacheDirectory: string
  /** hot: apply in this process. restart: drain and request a restart. */
  readonly reload: "hot" | "restart"
}

export class Plugins extends Context.Service<Plugins, {
  /** Validates and installs (or updates) an agent plugin. */
  readonly install: (source: string) => Effect.Effect<{ readonly id: string; readonly hash: string }, PluginRejected>
  readonly remove: (id: string) => Effect.Effect<void, PluginRejected>
  readonly enable: (id: string) => Effect.Effect<void, PluginRejected>
  /** Installs again the source of an earlier version. */
  readonly restore: (id: string, hash: string) => Effect.Effect<void, PluginRejected>
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

      const fileOf = (hash: string) => path.join(options.cacheDirectory, `${hash}.ts`)
      const materialize = (source: string) =>
        Effect.promise(async () => {
          const hash = hashSource(source)
          await fs.mkdir(options.cacheDirectory, { recursive: true })
          await fs.writeFile(fileOf(hash), source)
          return hash
        })
      const importSource = (source: string) =>
        Effect.flatMap(materialize(source), (hash) =>
          importPluginModule(fileOf(hash), hash).pipe(
            Effect.map((plugin) => ({ plugin, hash })),
            Effect.mapError((message) => new PluginRejected({ message }))
          ))

      /** Runs setup in a fresh, throwaway composition: catches errors without touching the live one. */
      const validate = (plugin: Plugin) =>
        PluginHost.use((scratch) => scratch.load(plugin, { trusted: false })).pipe(
          Effect.provide(Core.layer),
          Effect.scoped,
          Effect.provideContext(services),
          Effect.mapError((e) => new PluginRejected({ message: e.message }))
        )

      const builtinOrder = new Map(options.builtins.map((b, i) => [b.plugin.id, (i + 1) * 1000]))

      const apply = Effect.gen(function*() {
        const state = yield* config.state
        for (const { options: pluginOptions, plugin } of options.builtins) {
          const loaded = (yield* host.list).some((p) => p.id === plugin.id)
          if (state.disabled.has(plugin.id) && !state.installed.has(plugin.id)) {
            if (loaded) yield* Effect.ignore(host.unload(plugin.id))
          } else if (!loaded && !state.installed.has(plugin.id)) {
            yield* host.load(plugin, { options: pluginOptions, order: builtinOrder.get(plugin.id), source: `builtin:${plugin.id}` }).pipe(
              Effect.catchTag("PluginLoadError", (e) => Effect.logWarning(`plugin ${e.id} failed: ${e.message}`))
            )
          }
        }
        for (const [id, entry] of state.installed) {
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
        for (const id of [...loadedVersions.keys()]) {
          if (state.installed.has(id)) continue
          loadedVersions.delete(id)
          const builtin = options.builtins.find((b) => b.plugin.id === id)
          if (builtin && !state.disabled.has(id)) {
            yield* Effect.ignore(host.replace(builtin.plugin, { options: builtin.options, order: builtinOrder.get(id), source: `builtin:${id}` }))
          } else {
            yield* Effect.ignore(host.unload(id))
          }
        }
      })

      const requestChange = Effect.gen(function*() {
        if (options.reload === "hot") return yield* apply
        // Restart mode: stop starting work, let the current step finish, then signal.
        yield* Effect.forkDetach(Effect.gen(function*() {
          if (runtime._tag === "Some") yield* runtime.value.drain()
          yield* Deferred.succeed(restart, undefined)
        }))
      })

      const guard = (id: string) =>
        options.protected.has(id) ? Effect.fail(new PluginRejected({ message: `"${id}" is protected` })) : Effect.void

      yield* apply

      return Plugins.of({
        install: (source) =>
          Effect.gen(function*() {
            const { hash, plugin } = yield* importSource(source)
            yield* guard(plugin.id)
            yield* validate(plugin)
            yield* config.append("plugin/installed", { id: plugin.id, source, hash })
            yield* requestChange
            return { id: plugin.id, hash }
          }),
        remove: (id) =>
          Effect.gen(function*() {
            yield* guard(id)
            const state = yield* config.state
            if (state.installed.has(id)) yield* config.append("plugin/removed", { id })
            if (builtinOrder.has(id) || !state.installed.has(id)) yield* config.append("plugin/disabled", { id })
            yield* requestChange
          }),
        enable: (id) => Effect.andThen(config.append("plugin/enabled", { id }), requestChange),
        restore: (id, hash) =>
          Effect.gen(function*() {
            const version = (yield* config.history).find((e) =>
              e.type === "plugin/installed" && (e.data as { id: string; hash: string }).id === id &&
              (e.data as { hash: string }).hash === hash
            )
            if (!version) return yield* new PluginRejected({ message: `no version ${hash} of "${id}" in the history` })
            yield* config.append("plugin/installed", version.data as { id: string; source: string; hash: string })
            yield* requestChange
          }),
        config: config.state,
        reload: options.reload,
        restartRequested: Deferred.await(restart)
      })
    })

  static readonly layer = (options: PluginsOptions) => Layer.effect(Plugins, Plugins.make(options))
}

