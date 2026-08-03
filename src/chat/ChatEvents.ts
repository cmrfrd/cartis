/**
 * The client-side chat event stream (replaces ActivityClient).
 *
 * Wraps `new EventSource('/api/chat/events')` in a `Stream.asyncPush` that
 * emits decoded `ThreadEvent`s. Frames that fail to decode are SKIPPED — one
 * bad event never kills the stream (spec §Future-proofing 3). When EventSource
 * is undefined (vite preview / tests) the stream is `Stream.empty`.
 *
 * The fold is idempotent, so EventSource's automatic reconnect (which replays
 * the PubSub buffer) is absorbed without duplication.
 */

import { Context, Effect, Layer, type PubSub, Schema, Stream } from 'effect';
import { ThreadEventJson, type ThreadEventT } from '@/contracts/thread';

export interface ChatEventsShape {
  readonly events: Stream.Stream<ThreadEventT>;
}

export class ChatEvents extends Context.Tag('cartis/ChatEvents')<ChatEvents, ChatEventsShape>() {}

const decodeFrame = Schema.decodeUnknownOption(ThreadEventJson);

const liveEvents: Stream.Stream<ThreadEventT> =
  typeof EventSource === 'undefined'
    ? Stream.empty
    : Stream.asyncPush<ThreadEventT>((emit) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const source = new EventSource('/api/chat/events');
            source.onmessage = (e) => {
              const decoded = decodeFrame(e.data);
              if (decoded._tag === 'Some') emit.single(decoded.value);
              // undecodable frame — skip (tolerant boundary)
            };
            return source;
          }),
          (source) => Effect.sync(() => source.close()),
        ),
      );

export const chatEventsLive: Layer.Layer<ChatEvents> = Layer.succeed(
  ChatEvents,
  ChatEvents.of({ events: liveEvents }),
);

/** Default test layer: no SSE, the stream is empty. */
export const chatEventsEmpty: Layer.Layer<ChatEvents> = Layer.succeed(
  ChatEvents,
  ChatEvents.of({ events: Stream.empty }),
);

/** PubSub-backed test layer: publishing ThreadEvents drives the fold. */
export function chatEventsFromPubSub(pubsub: PubSub.PubSub<ThreadEventT>): Layer.Layer<ChatEvents> {
  return Layer.succeed(ChatEvents, ChatEvents.of({ events: Stream.fromPubSub(pubsub) }));
}
