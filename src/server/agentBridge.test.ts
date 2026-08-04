import { type Context, Effect, Fiber, Layer, Option, Redacted, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { DataUrl } from '@/contracts/ids.ts';
import type { PredictionT } from '@/contracts/replicate.ts';
import type { ThreadEventT } from '@/contracts/thread.ts';
import { httpClientFromHandler } from '@/lib/http.ts';
import { it } from '../../test/effect.ts';
import { ReplicateClient, ReplicateSdk, replicateClientLive } from './agentBridge.ts';
import { ThreadBus, threadBusTestLayer } from './threadBus.ts';

/** Art-event details from a bus history (the replicate/compose progress lane). */
const artDetails = (history: ReadonlyArray<ThreadEventT>): string[] =>
  history.flatMap((e) => (e._tag === 'Art' && e.detail !== undefined ? [e.detail] : []));

// ---------------------------------------------------------------------------
// ReplicateClient — stub ReplicateSdk + httpClientFromHandler + TestClock
// ---------------------------------------------------------------------------

/** Wire-shaped fixture (nulls allowed, like the live API) mapped into the Option-decoded PredictionT. */
interface PredFixture {
  id?: string;
  status?: PredictionT['status'];
  urls?: { get?: string };
  output?: string | readonly string[] | null;
  error?: string | null;
}

const pred = (fixture: PredFixture): PredictionT => ({
  id: fixture.id,
  status: fixture.status,
  urls: fixture.urls,
  output: Option.fromNullable(fixture.output ?? undefined),
  error: Option.fromNullable(fixture.error ?? undefined),
});

/**
 * A stub ReplicateSdk serving a canned prediction sequence. `create` returns
 * the first entry; each `get` advances to the next (clamped at the last).
 */
const sdkStub = (sequence: ReadonlyArray<PredFixture>): Layer.Layer<ReplicateSdk> =>
  Layer.effect(
    ReplicateSdk,
    Effect.gen(function* () {
      const idx = yield* Ref.make(0);
      return ReplicateSdk.of({
        createPrediction: () => Effect.succeed(pred(sequence[0] ?? {})),
        getPrediction: () =>
          Effect.gen(function* () {
            const i = yield* Ref.updateAndGet(idx, (n) => Math.min(n + 1, sequence.length - 1));
            return pred(sequence[i] ?? {});
          }),
      });
    }),
  );

/** sdkStub variant that also records every createPrediction input. */
const recordingSdkStub = (
  sequence: ReadonlyArray<PredFixture>,
  created: object[],
): Layer.Layer<ReplicateSdk> =>
  Layer.effect(
    ReplicateSdk,
    Effect.gen(function* () {
      const idx = yield* Ref.make(0);
      return ReplicateSdk.of({
        createPrediction: (_token, input) => {
          created.push(input);
          return Effect.succeed(pred(sequence[0] ?? {}));
        },
        getPrediction: () =>
          Effect.gen(function* () {
            const i = yield* Ref.updateAndGet(idx, (n) => Math.min(n + 1, sequence.length - 1));
            return pred(sequence[i] ?? {});
          }),
      });
    }),
  );

const pngHandler = () =>
  new Response(new TextEncoder().encode('img'), { headers: { 'content-type': 'image/png' } });

const replicateEnv = (sequence: ReadonlyArray<PredFixture>) =>
  replicateClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(sdkStub(sequence), threadBusTestLayer, httpClientFromHandler(pngHandler)),
    ),
    Layer.merge(threadBusTestLayer),
  );

describe('ReplicateClient.generate', () => {
  it.effect(
    'omits input_image for text-first generation (empty data URL) and fixes the aspect',
    () => {
      const created: object[] = [];
      const succeeded: PredFixture = {
        id: 'p1',
        status: 'succeeded',
        output: 'https://replicate.delivery/out.png',
      };
      const env = replicateClientLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            recordingSdkStub([succeeded], created),
            threadBusTestLayer,
            httpClientFromHandler(pngHandler),
          ),
        ),
        Layer.merge(threadBusTestLayer),
      );
      return Effect.gen(function* () {
        yield* Effect.flatMap(ReplicateClient, (c) =>
          c.generate(Redacted.make('tok'), {
            prompt: 'a mossy henge',
            imageDataUrl: undefined, // absent — no source photo (the sentinel is unrepresentable now)
            aspectRatio: 'match_input_image',
          }),
        );
        const input = created[0] as Record<string, unknown>;
        expect(input.input_image).toBeUndefined();
        expect(input.aspect_ratio).toBe('1:1'); // cannot match a nonexistent input image
        expect(input.prompt).toBe('a mossy henge');
      }).pipe(Effect.provide(env));
    },
  );

  it.effect('keeps input_image and the requested aspect when a source photo exists', () => {
    const created: object[] = [];
    const succeeded: PredFixture = {
      id: 'p1',
      status: 'succeeded',
      output: 'https://replicate.delivery/out.png',
    };
    const env = replicateClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          recordingSdkStub([succeeded], created),
          threadBusTestLayer,
          httpClientFromHandler(pngHandler),
        ),
      ),
      Layer.merge(threadBusTestLayer),
    );
    return Effect.gen(function* () {
      yield* Effect.flatMap(ReplicateClient, (c) =>
        c.generate(Redacted.make('tok'), {
          prompt: 'stylize me',
          imageDataUrl: DataUrl.make('data:image/png;base64,QQ=='),
          aspectRatio: '3:4',
        }),
      );
      const input = created[0] as Record<string, unknown>;
      expect(input.input_image).toBe('data:image/png;base64,QQ==');
      expect(input.aspect_ratio).toBe('3:4');
    }).pipe(Effect.provide(env));
  });

  it.effect('creates a prediction, polls to success, downloads output, emits Art events', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate(Redacted.make('tok'), {
            prompt: 'stylize me',
            imageDataUrl: DataUrl.make('data:image/png;base64,QQ=='),
            aspectRatio: '3:2',
          }),
        ),
      );
      // First getPrediction is immediate (processing), then one spaced interval
      // brings the second poll (succeeded) and the fiber settles.
      yield* TestClock.adjust('1500 millis');
      const dataUrl = yield* Fiber.join(fiber);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);

      const details = artDetails(yield* bus.history);
      expect(details.some((d) => d.includes('prediction pred-1 created'))).toBe(true);
      expect(details.some((d) => d.includes('status: processing'))).toBe(true);
      expect(details.some((d) => d.includes('status: succeeded'))).toBe(true);
      expect(details.some((d) => d.includes('output downloaded'))).toBe(true);
      // phases ride the events: generating → progress → downloaded
      const phases = (yield* bus.history).flatMap((e) => (e._tag === 'Art' ? [e.phase] : []));
      expect(phases).toContain('generating');
      expect(phases).toContain('progress');
      expect(phases).toContain('downloaded');
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
          c.generate(Redacted.make('tok'), {
            prompt: 'p',
            imageDataUrl: DataUrl.make('data:image/png;base64,QQ=='),
            aspectRatio: 'match_input_image',
          }),
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
          c.generate(Redacted.make('tok'), {
            prompt: 'p',
            imageDataUrl: DataUrl.make('data:image/png;base64,QQ=='),
            aspectRatio: 'match_input_image',
          }),
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
          c.generate(Redacted.make('tok'), {
            prompt: 'p',
            imageDataUrl: DataUrl.make('data:image/png;base64,QQ=='),
            aspectRatio: 'match_input_image',
          }),
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

// ---------------------------------------------------------------------------
// Redacted token — the secret cannot stringify
// ---------------------------------------------------------------------------

describe('Redacted replicate token', () => {
  it('never leaks the secret through toString/JSON', () => {
    const token = Redacted.make('r8_super_secret');
    expect(String(token)).not.toContain('super_secret');
    expect(JSON.stringify({ token })).not.toContain('super_secret');
    expect(Redacted.value(token)).toBe('r8_super_secret'); // unwrap is explicit
  });
});

// ---------------------------------------------------------------------------
// runChatTurn heartbeat
