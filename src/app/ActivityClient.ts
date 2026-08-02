/**
 * The client-side activity feed as an Effect Stream.
 *
 * Replaces the raw EventSource callbacks in `ActivityFeed.new()`. The Live
 * layer wraps `new EventSource('/api/activity')` in a `Stream.asyncPush` and
 * emits `FeedSignal`s mirroring exactly which callbacks set connected on/off
 * and deliver events today:
 *   onopen    → Connected
 *   onerror   → Disconnected  (EventSource auto-reconnects; we do NOT close)
 *   onmessage → Event (decode via ActivityEventJson; malformed frames dropped)
 * Release closes the EventSource. When `EventSource` is undefined (vite
 * preview / tests) the stream is `Stream.empty` — no construction attempt.
 */

import { Context, Data, Effect, Layer, type PubSub, Schema, Stream } from 'effect';
import { ActivityEventJson, type ActivityEventT } from '../contracts/activity';

// ---------------------------------------------------------------------------
// Signal union
// ---------------------------------------------------------------------------

export type FeedSignal = Data.TaggedEnum<{
  Connected: Record<never, never>;
  Disconnected: Record<never, never>;
  Event: { readonly event: ActivityEventT };
}>;

export const FeedSignal = Data.taggedEnum<FeedSignal>();

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface ActivityClientShape {
  readonly signals: Stream.Stream<FeedSignal>;
}

export class ActivityClient extends Context.Tag('cartis/ActivityClient')<
  ActivityClient,
  ActivityClientShape
>() {}

// ---------------------------------------------------------------------------
// Live stream — over EventSource
// ---------------------------------------------------------------------------

const decodeFrame = Schema.decodeUnknownOption(ActivityEventJson);

const liveSignals: Stream.Stream<FeedSignal> =
  typeof EventSource === 'undefined'
    ? Stream.empty
    : Stream.asyncPush<FeedSignal>((emit) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const source = new EventSource('/api/activity');
            source.onopen = () => {
              emit.single(FeedSignal.Connected());
            };
            source.onerror = () => {
              // EventSource auto-reconnects; mirror today — flag disconnected,
              // keep the connection (onopen re-fires on reconnect).
              emit.single(FeedSignal.Disconnected());
            };
            source.onmessage = (e) => {
              const decoded = decodeFrame(e.data);
              if (decoded._tag === 'Some') emit.single(FeedSignal.Event({ event: decoded.value }));
              // malformed frame — ignore (today's behavior)
            };
            return source;
          }),
          (source) => Effect.sync(() => source.close()),
        ),
      );

export const activityClientLive: Layer.Layer<ActivityClient> = Layer.succeed(
  ActivityClient,
  ActivityClient.of({ signals: liveSignals }),
);

// ---------------------------------------------------------------------------
// Test layers
// ---------------------------------------------------------------------------

/** Default test layer: no SSE, the stream is empty. */
export const activityClientEmpty: Layer.Layer<ActivityClient> = Layer.succeed(
  ActivityClient,
  ActivityClient.of({ signals: Stream.empty }),
);

/**
 * PubSub-backed test layer: `signals` subscribes to `pubsub`, so a test that
 * publishes `FeedSignal`s drives the feed. Used by the ActivityFeed stream test.
 */
export function activityClientFromPubSub(
  pubsub: PubSub.PubSub<FeedSignal>,
): Layer.Layer<ActivityClient> {
  return Layer.succeed(ActivityClient, ActivityClient.of({ signals: Stream.fromPubSub(pubsub) }));
}
