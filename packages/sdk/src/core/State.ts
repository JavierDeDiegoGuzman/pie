/**
 * State: a registry whose value is rebuilt from scratch by replaying ordered
 * transforms over a fresh initial value (the design described in
 * https://anoma.ly/notes/opencode-reloaded/).
 *
 * - A transform is registered in the caller's `Scope`; closing that scope (for
 *   example when a plugin unloads) removes it and rebuilds the value.
 * - Rebuilds are deterministic: same initial value + same transforms in the
 *   same order = same result. Transforms never see each other's history.
 * - Order is `(PluginOrder, registration sequence)`, so a plugin keeps its
 *   position when it is reloaded and tool/prompt order stays stable (prompt
 *   cache friendly).
 * - `Composition.batch` defers rebuilds so a plugin replacement is observed
 *   atomically: never old and new at the same time.
 */
import { Context, Effect, Scope, Semaphore, Stream, SubscriptionRef } from "effect"

export type Transform<A> = (draft: A) => void

export interface Diagnostic {
  readonly owner: string
  readonly message: string
}

export interface State<A> {
  readonly name: string
  readonly get: Effect.Effect<A>
  readonly changes: Stream.Stream<A>
  /** Transforms that threw during the last rebuild. They are skipped, not fatal. */
  readonly diagnostics: Effect.Effect<ReadonlyArray<Diagnostic>>
  readonly transform: (f: Transform<A>) => Effect.Effect<void, never, Scope.Scope>
  /** Rebuild now, e.g. after external data captured by a transform changed. */
  readonly reload: Effect.Effect<void>
}

/** Position of the plugin registering a transform. Set by the PluginHost. */
export const PluginOrder = Context.Reference<number>("pie/State/PluginOrder", {
  defaultValue: () => 0
})

/** Identity of the plugin registering a transform, for diagnostics. */
export const PluginId = Context.Reference<string>("pie/State/PluginId", {
  defaultValue: () => "core"
})

interface Entry<A> {
  readonly seq: number
  readonly order: number
  readonly owner: string
  readonly f: Transform<A>
}

interface Rebuildable {
  readonly rebuild: Effect.Effect<void>
}

/**
 * Shared rebuild coordinator for all States of one runtime. Increments
 * `version` once per committed rebuild batch, which is what the agent loop
 * snapshots per model call.
 */
export class Composition extends Context.Service<Composition, {
  readonly version: Effect.Effect<number>
  readonly versionChanges: Stream.Stream<number>
  readonly batch: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly make: <A>(options: { readonly name: string; readonly initial: () => A }) => Effect.Effect<State<A>>
}>()("pie/Composition") {
  static readonly make = Effect.gen(function*() {
    const version = yield* SubscriptionRef.make(0)
    const lock = yield* Semaphore.make(1)
    let depth = 0
    let seq = 0
    const dirty = new Set<Rebuildable>()

    const flush = Effect.gen(function*() {
      if (depth > 0 || dirty.size === 0) return
      const pending = [...dirty]
      dirty.clear()
      for (const state of pending) yield* state.rebuild
      yield* SubscriptionRef.update(version, (n) => n + 1)
    })

    const markDirty = (state: Rebuildable) =>
      Effect.suspend(() => {
        dirty.add(state)
        return flush
      })

    const batch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          depth++
        }),
        () => effect,
        () =>
          Effect.suspend(() => {
            depth--
            return flush
          })
      )

    const make = <A>(options: { readonly name: string; readonly initial: () => A }) =>
      Effect.gen(function*() {
        let entries: Array<Entry<A>> = []
        let diagnostics: ReadonlyArray<Diagnostic> = []
        const ref = yield* SubscriptionRef.make(options.initial())

        const self: Rebuildable = {
          rebuild: Effect.suspend(() => {
            const draft = options.initial()
            const errors: Array<Diagnostic> = []
            for (const entry of entries) {
              try {
                entry.f(draft)
              } catch (error) {
                errors.push({ owner: entry.owner, message: error instanceof Error ? error.message : String(error) })
              }
            }
            diagnostics = errors
            return SubscriptionRef.set(ref, draft)
          })
        }

        const transform = (f: Transform<A>) =>
          Effect.gen(function*() {
            const order = yield* PluginOrder
            const owner = yield* PluginId
            const entry: Entry<A> = { seq: seq++, order, owner, f }
            yield* Effect.acquireRelease(
              lock.withPermits(1)(Effect.suspend(() => {
                entries = [...entries, entry].sort((a, b) => a.order - b.order || a.seq - b.seq)
                return markDirty(self)
              })),
              () =>
                lock.withPermits(1)(Effect.suspend(() => {
                  entries = entries.filter((e) => e !== entry)
                  return markDirty(self)
                }))
            )
          })

        const state: State<A> = {
          name: options.name,
          get: SubscriptionRef.get(ref),
          changes: SubscriptionRef.changes(ref),
          diagnostics: Effect.sync(() => diagnostics),
          transform,
          reload: lock.withPermits(1)(markDirty(self))
        }
        return state
      })

    return Composition.of({
      version: SubscriptionRef.get(version),
      versionChanges: SubscriptionRef.changes(version),
      batch,
      make
    })
  })
}
