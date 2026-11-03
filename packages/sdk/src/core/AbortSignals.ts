/**
 * In-memory half of abort: lets running activities (model stream, tools) stop
 * immediately. The durable half is SessionStore.requestAbort, which activities
 * check when they start, so an abort requested while the process was down
 * still applies after restart.
 */
import { Context, Deferred, Effect } from "effect"

export class AbortSignals extends Context.Service<AbortSignals, {
  readonly fire: (runId: string) => Effect.Effect<void>
  /** Completes when the run is aborted. */
  readonly await: (runId: string) => Effect.Effect<void>
}>()("pie/AbortSignals") {
  static readonly make = Effect.sync(() => {
    const signals = new Map<string, Deferred.Deferred<void>>()
    const get = (runId: string) => {
      let signal = signals.get(runId)
      if (!signal) {
        signal = Deferred.makeUnsafe<void>()
        signals.set(runId, signal)
      }
      return signal
    }
    return AbortSignals.of({
      fire: (runId) => Effect.asVoid(Deferred.succeed(get(runId), undefined)),
      await: (runId) => Deferred.await(get(runId))
    })
  })
}
