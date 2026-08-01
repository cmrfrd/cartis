/**
 * Bridge activity bus: every AI action (agent, image gen) emits here, the
 * browser subscribes via SSE (/api/activity), and everything mirrors to the
 * dev-server terminal. In-memory only — history dies with the server.
 *
 * Effect shape: `ActivityBus` is a service tag over a PubSub (the fan-out to
 * SSE subscribers, with replay so a late subscriber sees recent history) plus
 * a capped Ref (the `/api/activity` history-dump contract). Time comes from
 * `Date.now()` deliberately — this is server code, not a workflow, and the
 * event `at` must be wall-clock.
 */

import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect';
import type { ActivityEventT, ActivitySourceT } from '../contracts/activity.ts';

const HISTORY_LIMIT = 200;
const PUBSUB_CAPACITY = 128;
const PUBSUB_REPLAY = 50; // == today's SSE history dump of `.slice(-50)`

export class ActivityBus extends Context.Tag('cartis/ActivityBus')<
  ActivityBus,
  {
    emit(source: ActivitySourceT, message: string): Effect.Effect<void>;
    readonly history: Effect.Effect<ReadonlyArray<ActivityEventT>>;
    readonly changes: Stream.Stream<ActivityEventT>;
  }
>() {}

/**
 * Build the bus internals. `silent` drops the terminal mirror (test layer);
 * the live layer keeps today's `[cartis:<source>] <message>` console format.
 */
const makeBus = (silent: boolean) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<ActivityEventT>({
      capacity: PUBSUB_CAPACITY,
      replay: PUBSUB_REPLAY,
    });
    const historyRef = yield* Ref.make<ReadonlyArray<ActivityEventT>>([]);

    const emit = (source: ActivitySourceT, message: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const event: ActivityEventT = { at: Date.now(), source, message };
        yield* Ref.update(historyRef, (prev) => {
          const next = [...prev, event];
          return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
        });
        if (!silent) console.log(`[cartis:${source}] ${message}`);
        yield* PubSub.publish(pubsub, event);
      });

    // A fresh subscription per stream run (per SSE connection); the sliding
    // PubSub's `replay` buffer means a late subscriber sees the last ≤50 events.
    const changes: Stream.Stream<ActivityEventT> = Stream.fromPubSub(pubsub);

    return ActivityBus.of({
      emit,
      history: Ref.get(historyRef),
      changes,
    });
  });

/** Live layer — mirrors to the dev-server terminal. */
export const activityBusLive: Layer.Layer<ActivityBus> = Layer.scoped(ActivityBus, makeBus(false));

/** Test layer — identical bus with the console mirror silenced. */
export const activityBusTestLayer: Layer.Layer<ActivityBus> = Layer.scoped(
  ActivityBus,
  makeBus(true),
);
