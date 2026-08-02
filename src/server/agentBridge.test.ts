import { Effect, Fiber, Layer, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import type { PredictionT } from '../contracts/replicate.ts';
import { httpClientFromHandler } from '../lib/http.ts';
import { ActivityBus, activityBusTestLayer } from './activity.ts';
import { ReplicateClient, ReplicateSdk, replicateClientLive } from './agentBridge.ts';

// ---------------------------------------------------------------------------
// ReplicateClient — stub ReplicateSdk + httpClientFromHandler + TestClock
// ---------------------------------------------------------------------------

/**
 * A stub ReplicateSdk serving a canned prediction sequence. `create` returns
 * the first entry; each `get` advances to the next (clamped at the last).
 */
const sdkStub = (sequence: ReadonlyArray<PredictionT>): Layer.Layer<ReplicateSdk> =>
  Layer.effect(
    ReplicateSdk,
    Effect.gen(function* () {
      const idx = yield* Ref.make(0);
      return ReplicateSdk.of({
        createPrediction: () => Effect.succeed(sequence[0] as PredictionT),
        getPrediction: () =>
          Effect.gen(function* () {
            const i = yield* Ref.updateAndGet(idx, (n) => Math.min(n + 1, sequence.length - 1));
            return sequence[i] as PredictionT;
          }),
      });
    }),
  );

const pngHandler = () =>
  new Response(new TextEncoder().encode('img'), { headers: { 'content-type': 'image/png' } });

const replicateEnv = (sequence: ReadonlyArray<PredictionT>) =>
  replicateClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(sdkStub(sequence), activityBusTestLayer, httpClientFromHandler(pngHandler)),
    ),
    Layer.merge(activityBusTestLayer),
  );

describe('ReplicateClient.generate', () => {
  it.effect('creates a prediction, polls to success, downloads output, logs progress', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate('tok', {
            prompt: 'stylize me',
            imageDataUrl: 'data:image/png;base64,QQ==',
            aspectRatio: '3:2',
          }),
        ),
      );
      // First getPrediction is immediate (processing), then one spaced interval
      // brings the second poll (succeeded) and the fiber settles.
      yield* TestClock.adjust('1500 millis');
      const dataUrl = yield* Fiber.join(fiber);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);

      const messages = (yield* bus.history).map((e) => e.message);
      expect(messages.some((m) => m.includes('prediction pred-1 created'))).toBe(true);
      expect(messages.some((m) => m.includes('status: processing'))).toBe(true);
      expect(messages.some((m) => m.includes('status: succeeded'))).toBe(true);
      expect(messages.some((m) => m.includes('output downloaded'))).toBe(true);
    }).pipe(
      Effect.provide(
        replicateEnv([
          {
            id: 'pred-1',
            status: 'starting',
            urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' },
          },
          { id: 'pred-1', status: 'processing' },
          { id: 'pred-1', status: 'succeeded', output: 'https://img.example/out.png' },
        ]),
      ),
    ),
  );

  it.effect('polls through explicit-null outputs (live API shape) to a real output', () =>
    Effect.gen(function* () {
      // Fresh predictions from the real API carry "output": null / "error": null
      // until completion — the poll loop must pass them through untouched and
      // only read output once status is succeeded.
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate('tok', { prompt: 'p', imageDataUrl: 'data:image/png;base64,QQ==' }),
        ),
      );
      // Immediate poll: processing (output null); one interval later: succeeded.
      yield* TestClock.adjust('1500 millis');
      const dataUrl = yield* Fiber.join(fiber);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }).pipe(
      Effect.provide(
        replicateEnv([
          {
            id: 'pred-null',
            status: 'starting',
            urls: { get: 'https://api.replicate.com/v1/predictions/pred-null' },
            output: null,
            error: null,
          },
          { id: 'pred-null', status: 'processing', output: null, error: null },
          {
            id: 'pred-null',
            status: 'succeeded',
            output: 'https://img.example/out.png',
            error: null,
          },
        ]),
      ),
    ),
  );

  it.effect('surfaces a failed prediction as ReplicateError failed', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate('tok', { prompt: 'p', imageDataUrl: 'data:image/png;base64,QQ==' }),
        ).pipe(Effect.flip),
      );
      // The first getPrediction call is immediate and returns 'failed'; the fiber
      // already settled before any clock advance is needed.
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe('ReplicateError');
      expect(error.message).toBe('replicate failed: nsfw block');
    }).pipe(
      Effect.provide(
        replicateEnv([
          { id: 'pred-2', status: 'starting', urls: { get: 'https://x/p/2' } },
          { id: 'pred-2', status: 'failed', error: 'nsfw block' },
        ]),
      ),
    ),
  );

  it.effect('times out after 120s with ReplicateError timeout', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate('tok', { prompt: 'p', imageDataUrl: 'data:image/png;base64,QQ==' }),
        ).pipe(Effect.flip),
      );
      // Never reaches succeeded; advance past the 120s cap.
      yield* TestClock.adjust('121 seconds');
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe('ReplicateError');
      expect(error.message).toBe('replicate timed out after 120s');
    }).pipe(
      Effect.provide(
        replicateEnv([
          { id: 'pred-3', status: 'starting', urls: { get: 'https://x/p/3' } },
          { id: 'pred-3', status: 'processing' },
        ]),
      ),
    ),
  );
});
