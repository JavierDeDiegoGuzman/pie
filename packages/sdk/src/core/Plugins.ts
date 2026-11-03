/**
 * Plugins come from two places:
 *
 *   - the plugins folder, `<home>/plugins`: one subfolder per plugin, all of
 *     them editable by the agent with ordinary tools. A new home is seeded
 *     from the SDK's templates. This is where every built-in lives too.
 *   - host plugins passed to Pie.layer in memory (tests, embedding apps, the
 *     SDK guard): not editable from the folder.
 *
 * Changes to the folder apply by themselves before the next step of any
 * session (`sync`, called by the runtime): the changed plugins are validated
 * in a throwaway composition; if they load, a snapshot of the whole folder is
 * recorded in the configuration log and the change is applied in this
 * process; if not, nothing is applied and the session is told why. `restart`
 * does the same on demand (and, with reload "restart", drains and lets the
 * supervisor restart Pie: for embedders). `rollback` restores the files of an
 * earlier snapshot. Safe mode loads the SDK templates instead of the folder.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path, Semaphore } from "effect"
import { type ConfigEvent, ConfigLog, type ConfigState, type Files, hashFiles } from "./ConfigLog.ts"
import * as Core from "./Core.ts"
import type { Plugin } from "./Plugin.ts"
import * as Folder from "./PluginFolder.ts"
import { type PluginInfo, PluginHost } from "./PluginHost.ts"
import { importPluginModule } from "./PluginLoader.ts"
import { Runtime } from "./Runtime.ts"

export class PluginRejected extends Data.TaggedError("PluginRejected")<{ readonly message: string }> {}

export interface HostEntry {
  readonly plugin: Plugin
  readonly options?: Readonly<Record<string, unknown>> | undefined
}

export interface PluginsOptions {
  /** Pie's home; plugins live in `<home>/plugins`. Without it, only host plugins load. */
  readonly home: string | undefined
  /** Templates copied into a new home, in load order. */
  readonly seed: ReadonlyArray<string>
  readonly host: ReadonlyArray<HostEntry>
  /** Options for folder plugins, by id (e.g. web: port, cwd). */
  readonly pluginOptions: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly reload: "hot" | "restart"
  /** Load the SDK templates (the `seed` list) instead of the plugins folder. */
  readonly safe: boolean
  /** Plugin ids that must load, or the boot fails (the supervisor then rolls back). */
  readonly required: ReadonlySet<string>
}

export interface Explanation {
  readonly safe: boolean
  readonly reload: "hot" | "restart"
  /** Where the plugins live; edit these files and call restart to apply. */
  readonly folder: string | undefined
  readonly plugins: ReadonlyArray<{ readonly id: string; readonly from: string; readonly path?: string; readonly files?: ReadonlyArray<string> }>
  /** Plugins whose files changed since the last applied snapshot (pending restart). */
  readonly pending: ReadonlyArray<string>
  readonly lastGood: number
  readonly head: number
  readonly history: ReadonlyArray<{ readonly seq: number; readonly type: string; readonly at: string; readonly note: string }>
}

export const describe = (event: ConfigEvent) => ({
  seq: event.seq,
  type: event.type,
  at: new Date(event.createdAt).toISOString(),
  note: event.type === "plugins/snapshot"
    ? `${(event.data as { reason: string }).reason} (${Object.keys((event.data as { files: Files }).files).length} files)`
    : `good up to #${(event.data as { seq: number }).seq}`
})

export class Plugins extends Context.Service<Plugins, {
  readonly folder: string | undefined
  /** Validates what changed in the plugins folder, records a snapshot and applies it. */
  readonly restart: (reason: string) => Effect.Effect<{ readonly changed: ReadonlyArray<string> }, PluginRejected>
  /**
   * Applies edits to the plugins folder, in this process, if there are any: runs before every step of every
   * session. Returns what the session's model should be told (applied, or refused with the errors), once per
   * change and session; undefined when there is nothing new to say.
   */
  readonly sync: (sessionId: string) => Effect.Effect<string | undefined>
  /** Restores the plugins folder of snapshot `toSeq` and applies it (recorded, so it can be undone). */
  readonly rollback: (toSeq: number, reason: string) => Effect.Effect<void, PluginRejected>
  /** Disables a folder plugin in plugins.json and applies it. */
  readonly disable: (id: string, reason: string) => Effect.Effect<void, PluginRejected>
  /** Marks the current snapshot as good (target of automatic rollbacks). */
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
      const restartSignal = yield* Deferred.make<void>()
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const folder = options.home === undefined ? undefined : path.join(options.home, "plugins")
      const loaded = new Map<string, string>() // folder plugin id -> hash of its files

      const read = folder === undefined ? Effect.succeed({} as Files) : Effect.promise(() => Folder.readFiles(folder))

      const importFolderPlugin = (base: string, id: string, files: Files) => {
        const hash = hashFiles(Folder.pluginFiles(files, id))
        return importPluginModule(path.join(base, id, "index.ts"), hash).pipe(
          Effect.flatMap((plugin) =>
            plugin.id === id
              ? Effect.succeed({ plugin, hash })
              : Effect.fail(`the plugin in folder "${id}" declares id "${plugin.id}"; they must match`)
          )
        )
      }

      /** Runs setup in a fresh, throwaway composition: catches errors without touching the live one. */
      const validate = (plugin: Plugin) =>
        PluginHost.use((scratch) =>
          Effect.gen(function*() {
            const api = yield* host.getApi
            if (api) yield* scratch.setApi(api)
            yield* scratch.load(plugin, { options: options.pluginOptions[plugin.id] })
          })
        ).pipe(
          Effect.provide(Layer.fresh(Core.layer)),
          Effect.scoped,
          Effect.provideContext(services),
          Effect.mapError((e) => e.message)
        )

      for (const [i, entry] of options.host.entries()) {
        yield* host.load(entry.plugin, { options: entry.options, order: 100 + i, source: "host" }).pipe(
          Effect.catchTag("PluginLoadError", (e) => Effect.logWarning(`plugin ${e.id} failed: ${e.message}`))
        )
      }

      let appliedHash: string | undefined // hash of the folder as last applied
      /** Makes the loaded folder plugins match `files` (or the templates in safe mode). */
      const apply = (files: Files) =>
        Effect.gen(function*() {
          appliedHash = hashFiles(files)
          const base = options.safe ? Folder.TEMPLATES : folder
          if (base === undefined) return
          const source = options.safe ? yield* Effect.promise(() => Folder.templateFiles(options.seed)) : files
          const ids = Folder.enabledPlugins(source)
          for (const [i, id] of ids.entries()) {
            const hash = hashFiles(Folder.pluginFiles(source, id))
            if (loaded.get(id) === hash) continue
            const result = yield* importFolderPlugin(base, id, source).pipe(
              Effect.flatMap(({ plugin }) =>
                host.replace(plugin, { options: options.pluginOptions[id], order: 1000 * (i + 1), source: `folder:${id}` }).pipe(
                  Effect.mapError((e) => e.message)
                )
              ),
              Effect.result
            )
            if (result._tag === "Success") loaded.set(id, hash)
            else yield* Effect.logWarning(`plugin ${id} failed to load: ${result.failure}`)
          }
          for (const id of [...loaded.keys()]) {
            if (ids.includes(id)) continue
            loaded.delete(id)
            yield* Effect.ignore(host.unload(id))
          }
        })

      const requestChange = (files: Files) =>
        Effect.gen(function*() {
          if (options.reload === "hot") return yield* apply(files)
          yield* Effect.forkDetach(Effect.gen(function*() {
            if (runtime._tag === "Some") yield* runtime.value.drain()
            yield* Deferred.succeed(restartSignal, undefined)
          }))
        })

      // -- boot: seed a new home, record changes made while Pie was down, load ----------
      if (folder !== undefined && !options.safe) {
        let files = yield* read
        if (Object.keys(files).length === 0) {
          files = yield* Effect.promise(() => Folder.templateFiles(options.seed))
          yield* Effect.promise(() => Folder.writeFiles(folder, files))
          yield* config.append("plugins/snapshot", { files, hash: hashFiles(files), reason: "seeded from the SDK templates" })
        } else if ((yield* config.state).current?.hash !== hashFiles(files)) {
          yield* config.append("plugins/snapshot", { files, hash: hashFiles(files), reason: "changes found at startup" })
        }
        yield* apply(files)
      } else if (options.safe) {
        yield* apply({})
      }
      const loadedIds = (yield* host.list).map((p) => p.id)
      for (const id of options.required) {
        if (!loadedIds.includes(id)) return yield* Effect.die(new Error(`required plugin "${id}" did not load`))
      }

      const changedPlugins = (files: Files) =>
        Folder.enabledPlugins(files).filter((id) => loaded.get(id) !== hashFiles(Folder.pluginFiles(files, id)))

      /** Validates the changed plugins of `files`; nothing is applied. */
      const check = (files: Files) =>
        Effect.gen(function*() {
          const changed = changedPlugins(files)
          const errors: Array<string> = []
          if (files[Folder.MANIFEST] !== undefined) {
            try {
              JSON.parse(files[Folder.MANIFEST]!)
            } catch (error) {
              errors.push(`${Folder.MANIFEST}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          for (const id of changed) {
            const result = yield* importFolderPlugin(folder!, id, files).pipe(
              Effect.flatMap(({ plugin }) => validate(plugin)),
              Effect.result
            )
            if (result._tag === "Failure") errors.push(`${id}: ${result.failure}`)
          }
          return { changed, errors }
        })

      const snapshot = (files: Files, reason: string) =>
        Effect.gen(function*() {
          const hash = hashFiles(files)
          if ((yield* config.state).current?.hash !== hash) yield* config.append("plugins/snapshot", { files, hash, reason })
          return (yield* config.state).head
        })

      const lock = yield* Semaphore.make(1)

      const restart = (reason: string) =>
        lock.withPermits(1)(Effect.gen(function*() {
          if (folder === undefined) return yield* new PluginRejected({ message: "this Pie has no plugins folder" })
          if (options.safe) return yield* new PluginRejected({ message: "safe mode: the plugins folder is not loaded" })
          const files = yield* read
          const { changed, errors } = yield* check(files)
          if (errors.length > 0) {
            return yield* new PluginRejected({ message: `Nothing applied; fix these and call restart again:\n${errors.join("\n")}` })
          }
          yield* snapshot(files, reason)
          yield* requestChange(files)
          return { changed }
        }))

      // What each session was last told, by folder hash: say each result once per session.
      const told = new Map<string, string>()
      let refused: { readonly hash: string; readonly text: string } | undefined
      const sync = (sessionId: string) =>
        lock.withPermits(1)(Effect.gen(function*() {
          if (folder === undefined || options.safe) return undefined
          const files = yield* read
          const hash = hashFiles(files)
          if (hash === appliedHash) return undefined
          if (refused?.hash !== hash) {
            const { changed, errors } = yield* check(files)
            if (errors.length === 0) {
              const what = changed.length > 0 ? changed.join(", ") : "plugins.json"
              const seq = yield* snapshot(files, `applied before the next step: ${what} changed`)
              yield* apply(files)
              refused = undefined
              told.set(sessionId, hash)
              return `Your edits to the plugins folder are applied (${what}; snapshot #${seq}, undoable with pie rollback).`
            }
            refused = {
              hash,
              text: `Your edits to the plugins folder were NOT applied; Pie keeps running the previous version of every ` +
                `plugin. Fix these and they apply before your next step:\n${errors.join("\n")}`
            }
          }
          if (told.get(sessionId) === hash) return undefined
          told.set(sessionId, hash)
          return refused.text
        })).pipe(
          Effect.catchCause((cause) => Effect.as(Effect.logWarning("plugins: applying the folder failed", cause), undefined))
        )

      const rollback = (toSeq: number, reason: string) =>
        lock.withPermits(1)(Effect.gen(function*() {
          if (folder === undefined) return yield* new PluginRejected({ message: "this Pie has no plugins folder" })
          const event = yield* config.get(toSeq)
          if (!event || event.type !== "plugins/snapshot") {
            return yield* new PluginRejected({ message: `#${toSeq} is not a snapshot of the plugins folder` })
          }
          const { files, hash } = event.data as { files: Files; hash: string }
          yield* Effect.promise(() => Folder.writeFiles(folder, files))
          yield* config.append("plugins/snapshot", { files, hash, reason: `rollback to #${toSeq}: ${reason}` })
          yield* requestChange(files)
        }))

      return Plugins.of({
        folder,
        restart,
        sync,
        rollback,
        disable: (id, reason) =>
          Effect.gen(function*() {
            if (folder === undefined) return yield* new PluginRejected({ message: "this Pie has no plugins folder" })
            const files = yield* read
            let manifest: Folder.Manifest = { order: Folder.enabledPlugins(files), disabled: [] }
            try {
              if (files[Folder.MANIFEST]) manifest = { ...manifest, ...JSON.parse(files[Folder.MANIFEST]!) }
            } catch {
              // rewritten below
            }
            const next = { ...manifest, disabled: [...new Set([...manifest.disabled, id])] }
            yield* Effect.promise(() => fs.writeFile(path.join(folder, Folder.MANIFEST), JSON.stringify(next, null, 2) + "\n"))
            yield* restart(reason)
          }),
        markGood: Effect.gen(function*() {
          if (options.safe) return
          const state = yield* config.state
          if (state.head > state.lastGood) yield* config.append("config/good", { seq: state.head })
        }),
        explain: Effect.gen(function*() {
          const history = yield* config.history
          const state = yield* config.state
          const files = yield* read
          const list = yield* host.list
          return {
            safe: options.safe,
            reload: options.reload,
            folder,
            plugins: list.map((p: PluginInfo) =>
              p.source.startsWith("folder:") && folder
                ? {
                  id: p.id,
                  from: options.safe ? "SDK template (safe mode)" : "plugins folder",
                  path: path.join(options.safe ? Folder.TEMPLATES : folder, p.id),
                  files: Object.keys(Folder.pluginFiles(files, p.id))
                }
                : { id: p.id, from: p.source === "host" ? "host (not editable)" : p.source }
            ),
            pending: options.safe ? [] : changedPlugins(files),
            lastGood: state.lastGood,
            head: state.head,
            history: history.map(describe)
          }
        }),
        config: config.state,
        reload: options.reload,
        restartRequested: Deferred.await(restartSignal)
      })
    })

  static readonly layer = (options: PluginsOptions) => Layer.effect(Plugins, Plugins.make(options))
}
