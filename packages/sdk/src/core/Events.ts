/**
 * Live events. In-memory only: deltas are never persisted. Anything that
 * matters is also an entry in the SessionStore, so a late subscriber reads the
 * branch and then follows the live stream.
 */
import { Context, Effect, PubSub, Stream } from "effect"
import type { Entry, RunOutcome, ToolResultData } from "./Session.ts"

export type PieEvent =
  | { readonly type: "agent_start"; readonly sessionId: string; readonly runId: string }
  | { readonly type: "turn_start"; readonly sessionId: string; readonly runId: string; readonly turn: number }
  | { readonly type: "text_delta"; readonly sessionId: string; readonly runId: string; readonly turn: number; readonly delta: string }
  | {
    readonly type: "reasoning_delta"
    readonly sessionId: string
    readonly runId: string
    readonly turn: number
    readonly delta: string
  }
  | {
    readonly type: "tool_start"
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly tool: string
    readonly params: unknown
  }
  | { readonly type: "tool_end"; readonly sessionId: string; readonly runId: string; readonly result: ToolResultData }
  | { readonly type: "entry"; readonly sessionId: string; readonly entry: Entry }
  | { readonly type: "agent_end"; readonly sessionId: string; readonly runId: string; readonly outcome: RunOutcome }

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
