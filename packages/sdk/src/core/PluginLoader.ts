/**
 * Loads plugins from files and keeps a directory in sync with the PluginHost.
 * This is how the agent modifies itself: it writes, edits or deletes a plugin
 * file and the loader reconciles.
 *
 * - New file: imported and loaded.
 * - Changed file (content hash): imported again and replaced transactionally;
 *   if the new version fails to import or set up, the previous one keeps
 *   running and the error is reported in `status`.
 * - Deleted file: its plugin is unloaded.
 *
 * Each import uses a content-hash query string, so Node's ESM cache never
 * serves a stale module.
 */
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { Context, Effect, FileSystem, Path, Ref, Semaphore, Stream } from "effect"
import { isPlugin, type Plugin } from "./Plugin.ts"
import { PluginHost } from "./PluginHost.ts"

export interface FileStatus {
  readonly file: string
  readonly pluginId: string | undefined
  readonly hash: string
  /** Error of the last attempt, if it failed. The previous version (if any) is still loaded. */
  readonly error: string | undefined
}

const PLUGIN_FILE = /\.(ts|mts|js|mjs)$/

/** Imports a plugin module; the hash in the URL defeats Node's ESM cache. */
export const importPluginModule = (file: string, hash: string) =>
  Effect.tryPromise({
    try: () => import(`${pathToFileURL(file).href}?v=${hash}`) as Promise<{ default?: unknown }>,
    catch: (error) => error instanceof Error ? error.message : String(error)
  }).pipe(
    Effect.flatMap((module) =>
      isPlugin(module.default)
        ? Effect.succeed(module.default as Plugin)
        : Effect.fail("default export is not a plugin (expected Plugin.define({ id, setup }))")
    )
  )

export class PluginLoader extends Context.Service<PluginLoader, {
  readonly sync: (directory: string) => Effect.Effect<ReadonlyArray<FileStatus>>
  /** Syncs now and then on every change in the directory, for the lifetime of the scope. */
  readonly watch: (directory: string) => Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly status: Effect.Effect<ReadonlyArray<FileStatus>>
}>()("pie/PluginLoader") {
  static readonly make = Effect.gen(function*() {
    const host = yield* PluginHost
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files = yield* Ref.make(new Map<string, FileStatus>())
    const lock = yield* Semaphore.make(1)

    const importPlugin = importPluginModule
    const loadFile = (file: string, content: string) =>
      Effect.gen(function*() {
        const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
        const previous = (yield* Ref.get(files)).get(file)
        if (previous?.hash === hash) return previous
        const result = yield* importPlugin(file, hash).pipe(
          Effect.tap((plugin) => host.replace(plugin, { source: file }).pipe(Effect.mapError((e) => e.message))),
          Effect.tap((plugin) =>
            previous?.pluginId !== undefined && previous.pluginId !== plugin.id
              ? Effect.ignore(host.unload(previous.pluginId))
              : Effect.void
          ),
          Effect.result
        )
        const status: FileStatus = result._tag === "Success"
          ? { file, hash, pluginId: result.success.id, error: undefined }
          : { file, hash, pluginId: previous?.pluginId, error: result.failure }
        yield* Ref.update(files, (map) => new Map(map).set(file, status))
        return status
      })

    const sync = (directory: string) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const exists = yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false))
        const names = exists ? yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])) : []
        const present = new Set(
          names.filter((name) => PLUGIN_FILE.test(name) && !name.endsWith(".d.ts")).map((name) =>
            path.join(directory, name)
          )
        )
        for (const [file, status] of yield* Ref.get(files)) {
          if (path.dirname(file) !== directory || present.has(file)) continue
          if (status.pluginId !== undefined) yield* Effect.ignore(host.unload(status.pluginId))
          yield* Ref.update(files, (map) => {
            const next = new Map(map)
            next.delete(file)
            return next
          })
        }
        for (const file of [...present].sort()) {
          const content = yield* fs.readFileString(file).pipe(Effect.option)
          if (content._tag === "Some") yield* loadFile(file, content.value)
        }
        return [...(yield* Ref.get(files)).values()].filter((s) => path.dirname(s.file) === directory)
      }))

    const watch = (directory: string) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore)
        yield* sync(directory)
        yield* fs.watch(directory).pipe(
          Stream.debounce("100 millis"),
          Stream.runForEach(() => sync(directory)),
          Effect.ignore,
          Effect.forkScoped
        )
      })

    return PluginLoader.of({
      sync,
      watch,
      status: Effect.map(Ref.get(files), (map) => [...map.values()])
    })
  })
}
