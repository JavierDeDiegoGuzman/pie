/**
 * Loads, replaces and unloads plugins. Every operation runs inside a
 * Composition batch, so registries change atomically:
 *
 * - load: a plugin whose setup fails leaves nothing behind.
 * - replace: the new version is set up first; only if it succeeds is the old
 *   scope closed. If it fails, the old version keeps running (rollback).
 * - unload: closing the plugin scope drops all its transforms, fibers and
 *   finalizers.
 */
import { Cause, Context, Data, Effect, Exit, FileSystem, Path, Ref, Scope, Semaphore } from "effect"
import { createHash } from "node:crypto"
import type { PieApi, Plugin, PluginContext } from "./Plugin.ts"
import { EventLog, type LogEvent } from "./Log.ts"
import { type ProjectionDefinition, Registries } from "./Registry.ts"
import { Composition, PluginId, PluginOrder } from "./State.ts"

/** Folds a projection over a branch. Handlers that throw are skipped for that event. */
export const foldProjection = <S>(definition: ProjectionDefinition<S>, events: ReadonlyArray<LogEvent>): S => {
  let state = definition.initial()
  for (const event of events) {
    const handler = definition.on[event.type]
    if (!handler) continue
    try {
      state = handler(state, event.data, event)
    } catch {
      // A version of the plugin that cannot read an old event skips it.
    }
  }
  return state
}

export class PluginLoadError extends Data.TaggedError("PluginLoadError")<{
  readonly id: string
  readonly message: string
}> {}

export class PluginNotFound extends Data.TaggedError("PluginNotFound")<{
  readonly id: string
}> {}

export interface LoadOptions {
  readonly options?: Readonly<Record<string, unknown>> | undefined
  /** Position among plugins; transforms are ordered by it. Defaults to load order. */
  readonly order?: number | undefined
  /** Where it came from: "builtin:<name>" or a file path. Informational. */
  readonly source?: string | undefined
  /**
   * Untrusted plugins (installed by the agent) cannot use policy points:
   * registering a "tool.before" hook fails their setup. Default: trusted.
   */
  readonly trusted?: boolean | undefined
}

export interface PluginInfo {
  readonly id: string
  readonly order: number
  readonly source: string
}

interface Loaded extends PluginInfo {
  readonly scope: Scope.Closeable
}

export class PluginHost extends Context.Service<PluginHost, {
  readonly load: (plugin: Plugin, options?: LoadOptions) => Effect.Effect<void, PluginLoadError>
  /** Loads, or atomically replaces an already loaded plugin with the same id. */
  readonly replace: (plugin: Plugin, options?: LoadOptions) => Effect.Effect<void, PluginLoadError>
  readonly unload: (id: string) => Effect.Effect<void, PluginNotFound>
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  /** Gives plugins access to Pie (ctx.pie). Set by Pie.layer before plugins load. */
  readonly setApi: (api: PieApi) => Effect.Effect<void>
  readonly getApi: Effect.Effect<PieApi | undefined>
}>()("pie/PluginHost") {
  static readonly make = Effect.gen(function*() {
    const composition = yield* Composition
    const registries = yield* Registries
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const logContext = yield* Effect.context<never>()
    const loaded = yield* Ref.make(new Map<string, Loaded>())
    const lock = yield* Semaphore.make(1)
    let nextOrder = 0
    let api: PieApi | undefined

    const setup = (plugin: Plugin, order: number, options: LoadOptions | undefined) =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const context: PluginContext = {
          id: plugin.id,
          options: options?.options ?? {},
          tools: registries.tools,
          models: registries.models,
          prompt: registries.prompt,
          hook: (name, hook) =>
            name === "tool.before" && options?.trusted === false
              ? Effect.die(`"tool.before" is a policy point reserved for trusted plugins; use "tool.after", react or context instead`)
              : registries.hooks.transform((table) => void (table[name] as Array<typeof hook>).push(hook)),
          events: (schemas) =>
            registries.eventTypes.transform((types) => {
              for (const [name, schema] of Object.entries(schemas)) {
                const type = `${plugin.id}/${name}`
                types.set(type, { type, owner: plugin.id, schema })
              }
            }),
          projection: (definition) =>
            Effect.as(
              registries.projections.transform((projections) => void projections.set(definition.id, definition)),
              {
                get: (sessionId, leafId) =>
                  Effect.flatMap(Effect.serviceOption(EventLog), (log) =>
                    log._tag === "None"
                      ? Effect.die("projections need an EventLog (use Pie.layer)")
                      : Effect.map(log.value.branch(sessionId, leafId), (events) => foldProjection(definition, events)))
                    .pipe(Effect.provideContext(logContext))
              }
            ),
          react: (definition) => registries.reactions.transform((reactions) => void reactions.set(definition.id, definition)),
          ui: (module) => {
            const source = typeof module === "string"
              ? module
              : `import * as sdk from "@pie/ui"\nconst register = (${module.toString()})\nexport default (ui) => register({ ...sdk, ui })\n`
            const hash = createHash("sha256").update(source).digest("hex").slice(0, 16)
            return registries.ui.transform((ui) => void ui.set(plugin.id, { id: plugin.id, source, hash }))
          },
          get pie(): PieApi {
            if (!api) throw new Error("ctx.pie is only available when running under Pie.layer")
            return api
          }
        }
        const exit = yield* Effect.suspend(() => {
          // A setup that is not an Effect (e.g. `setup: () => {}`) would break the fiber outside of Effect's
          // error handling: reject it as a load error instead.
          const result = plugin.setup(context) as unknown
          return Effect.isEffect(result)
            ? (result as ReturnType<Plugin["setup"]>)
            : Effect.fail("setup must return an Effect (for example Effect.void or Effect.gen(...))")
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail("setup did not finish within 10 seconds") }),
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(PluginOrder, order),
          Effect.provideService(PluginId, plugin.id),
          Effect.provideContext(services),
          Effect.exit
        )
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit)
          return yield* new PluginLoadError({ id: plugin.id, message: Cause.pretty(exit.cause) })
        }
        return scope
      })

    const replace = (plugin: Plugin, options?: LoadOptions) =>
      lock.withPermits(1)(composition.batch(Effect.gen(function*() {
        const previous = (yield* Ref.get(loaded)).get(plugin.id)
        const order = options?.order ?? previous?.order ?? (nextOrder += 1000)
        const scope = yield* setup(plugin, order, options)
        if (previous) yield* Scope.close(previous.scope, Exit.void)
        yield* Ref.update(loaded, (map) =>
          new Map(map).set(plugin.id, {
            id: plugin.id,
            order,
            source: options?.source ?? previous?.source ?? "inline",
            scope
          }))
      })))

    const load = (plugin: Plugin, options?: LoadOptions) =>
      Effect.gen(function*() {
        if ((yield* Ref.get(loaded)).has(plugin.id)) {
          return yield* new PluginLoadError({ id: plugin.id, message: "already loaded; use replace" })
        }
        return yield* replace(plugin, options)
      })

    const unload = (id: string) =>
      lock.withPermits(1)(composition.batch(Effect.gen(function*() {
        const entry = (yield* Ref.get(loaded)).get(id)
        if (!entry) return yield* new PluginNotFound({ id })
        yield* Scope.close(entry.scope, Exit.void)
        yield* Ref.update(loaded, (map) => {
          const next = new Map(map)
          next.delete(id)
          return next
        })
      })))

    const list = Effect.map(Ref.get(loaded), (map) =>
      [...map.values()]
        .map(({ id, order, source }) => ({ id, order, source }))
        .sort((a, b) => a.order - b.order))

    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        for (const entry of (yield* Ref.get(loaded)).values()) yield* Scope.close(entry.scope, Exit.void)
      })
    )

    return PluginHost.of({ load, replace, unload, list, setApi: (value) => Effect.sync(() => void (api = value)), getApi: Effect.sync(() => api) })
  })
}
