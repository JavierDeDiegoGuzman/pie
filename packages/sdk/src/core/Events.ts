/**
 * Live events. Every event appended to the log is published as `event`;
 * streaming deltas are published too but never persisted. A late subscriber
 * reads the branch from the log and then follows this stream.
 */
import { Context, Effect, PubSub, Stream } from "effect"
import type { LogEvent } from "./Log.ts"

export type PieEvent =
  | { readonly type: "event"; readonly sessionId: string; readonly event: LogEvent }
  | { readonly type: "text_delta"; readonly sessionId: string; readonly runId: string; readonly turn: number; readonly delta: string }
  | {
    readonly type: "reasoning_delta"
    readonly sessionId: string
    readonly runId: string
    readonly turn: number
    readonly delta: string
  }

export class Events extends Context.Service<Events, {
  readonly publish: (event: PieEvent) => Effect.Effect<void>
  readonly stream: (sessionId?: string) => Stream.Stream<PieEvent>
}>()("pie/Events") {
  static readonly make = Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<PieEvent>()
    return Events.of({
      publish: (event) => Effect.asVoid(PubSub.publish(pubsub, event)),
      stream: (sessionId) => {
        const all = Stream.fromPubSub(pubsub)
        return sessionId === undefined ? all : Stream.filter(all, (e) => e.sessionId === sessionId)
      }
    })
  })
}
