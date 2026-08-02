import { Effect, PubSub } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { activityClientFromPubSub, type FeedSignal, FeedSignal as Signal } from './ActivityClient';
import { ActivityFeed } from './ActivityFeed';
import { setAppLayer, testAppLayerWith } from './runtime';

describe('ActivityFeed', () => {
  it('appends events, exposes the latest, and caps the feed', () => {
    const feed = ActivityFeed.new();
    feed.push({ at: 1, source: 'image', message: 'prediction created' });
    feed.push({ at: 2, source: 'agent', message: 'session created' });
    expect(feed.events).toHaveLength(2);
    expect(feed.latest?.message).toBe('session created');
    for (let i = 0; i < 210; i++) feed.push({ at: i, source: 'bridge', message: `e${i}` });
    expect(feed.events).toHaveLength(200);
    feed.set(null);
  });

  it('consumes the ActivityClient stream (connected + events)', async () => {
    const pubsub = await Effect.runPromise(PubSub.unbounded<FeedSignal>());
    setAppLayer(testAppLayerWith({ activity: activityClientFromPubSub(pubsub) }));
    const feed = ActivityFeed.new();
    // A subscription per stream run is opened asynchronously — wait for it.
    await vi.waitFor(async () => {
      await Effect.runPromise(PubSub.publish(pubsub, Signal.Connected()));
      expect(feed.connected).toBe(true);
    });
    await Effect.runPromise(
      PubSub.publish(pubsub, Signal.Event({ event: { at: 1, source: 'image', message: 'one' } })),
    );
    await Effect.runPromise(
      PubSub.publish(pubsub, Signal.Event({ event: { at: 2, source: 'agent', message: 'two' } })),
    );
    await vi.waitFor(() => {
      expect(feed.events.map((e) => e.message)).toContain('one');
      expect(feed.events.map((e) => e.message)).toContain('two');
    });
    feed.set(null);
  });

  it('interrupts the stream fiber on destroy (no growth after)', async () => {
    const pubsub = await Effect.runPromise(PubSub.unbounded<FeedSignal>());
    setAppLayer(testAppLayerWith({ activity: activityClientFromPubSub(pubsub) }));
    const feed = ActivityFeed.new();
    await vi.waitFor(async () => {
      await Effect.runPromise(
        PubSub.publish(pubsub, Signal.Event({ event: { at: 1, source: 'image', message: 'a' } })),
      );
      expect(feed.events).toHaveLength(1);
    });
    feed.set(null); // destroy → cleanup interrupts the fiber
    // Emit again; the interrupted consumer must not deliver into the destroyed model.
    await Effect.runPromise(
      PubSub.publish(pubsub, Signal.Event({ event: { at: 2, source: 'agent', message: 'b' } })),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(feed.events).toHaveLength(1);
  });
});
