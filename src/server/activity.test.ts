import { Chunk, Effect, Fiber, Stream } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import { ActivityBus, activityBusTestLayer } from './activity.ts';

/**
 * The test layer silences the console mirror; each test provides a fresh bus so
 * history/replay start empty. Behaviors mirror the old module-level bus spec:
 * emit→history ordering, the 200-event cap, live delivery to a subscriber, and
 * PubSub replay for a late subscriber.
 */

describe('ActivityBus', () => {
  it.effect('records history in emit order and notifies subscribers', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      // Subscribe before emitting; take the first two events into a fiber.
      const seen = yield* Effect.fork(bus.changes.pipe(Stream.take(2), Stream.runCollect));
      // Give the subscription a tick to attach before emitting.
      yield* Effect.yieldNow();
      yield* bus.emit('image', 'prediction created');
      yield* bus.emit('agent', 'session created');

      const history = yield* bus.history;
      expect(history.map((e) => e.message)).toEqual(['prediction created', 'session created']);

      const delivered = yield* Fiber.join(seen);
      expect(Chunk.toReadonlyArray(delivered).map((e) => e.message)).toEqual([
        'prediction created',
        'session created',
      ]);
    }).pipe(Effect.provide(activityBusTestLayer)),
  );

  it.effect('caps history at 200 events', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      for (let i = 0; i < 230; i++) yield* bus.emit('bridge', `event ${i}`);
      const history = yield* bus.history;
      expect(history).toHaveLength(200);
      expect(history[0]?.message).toBe('event 30');
    }).pipe(Effect.provide(activityBusTestLayer)),
  );

  it.effect('a late subscriber sees replayed history (≤50)', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      // Emit before anyone subscribes.
      yield* bus.emit('image', 'first');
      yield* bus.emit('agent', 'second');
      // A late subscription still sees the replay buffer.
      const replayed = yield* bus.changes.pipe(Stream.take(2), Stream.runCollect);
      expect(Chunk.toReadonlyArray(replayed).map((e) => e.message)).toEqual(['first', 'second']);
    }).pipe(Effect.provide(activityBusTestLayer)),
  );

  it.effect('replays at most the last 50 events to a late subscriber', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      for (let i = 0; i < 60; i++) yield* bus.emit('bridge', `event ${i}`);
      // A fresh subscription sees only the last 50 (events 10..59).
      const replayed = yield* bus.changes.pipe(Stream.take(50), Stream.runCollect);
      const messages = Chunk.toReadonlyArray(replayed).map((e) => e.message);
      expect(messages).toHaveLength(50);
      expect(messages[0]).toBe('event 10');
      expect(messages[49]).toBe('event 59');
    }).pipe(Effect.provide(activityBusTestLayer)),
  );
});
