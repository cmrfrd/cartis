import { Effect, Fiber, Layer, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import type { PredictionT } from '../contracts/replicate.ts';
import { httpClientFromHandler } from '../lib/http.ts';
import { ActivityBus, activityBusTestLayer } from './activity.ts';
import {
  AgentClient,
  buildAgentPrompt,
  extractCode,
  ReplicateClient,
  ReplicateSdk,
  replicateClientLive,
  runCardAgent,
} from './agentBridge.ts';

// ---------------------------------------------------------------------------
// Pure helpers — plain `it`
// ---------------------------------------------------------------------------

describe('buildAgentPrompt', () => {
  it('embeds the guide, the user request, and the current code', () => {
    const prompt = buildAgentPrompt(
      'make it spooky',
      'export default function C() { return null }',
    );
    expect(prompt).toContain('cartis/cards');
    expect(prompt).toContain('make it spooky');
    expect(prompt).toContain('export default function C()');
    expect(prompt).toContain('default export');
  });
});

describe('extractCode', () => {
  it('prefers structured output when present', () => {
    const result = { data: { info: { structured_output: { code: 'export default 1' } } } };
    expect(extractCode(result)).toBe('export default 1');
  });

  it('falls back to the last tsx code fence in text parts', () => {
    const result = {
      data: {
        parts: [
          {
            type: 'text',
            text: 'Here you go:\n```tsx\nexport default function A() { return null }\n```',
          },
          {
            type: 'text',
            text: 'refined:\n```tsx\nexport default function B() { return null }\n```',
          },
        ],
      },
    };
    expect(extractCode(result)).toContain('function B');
  });

  it('returns undefined when nothing code-like exists', () => {
    expect(extractCode({ data: { parts: [{ type: 'text', text: 'no code' }] } })).toBeUndefined();
    expect(extractCode(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runCardAgent — Effect + stub AgentClient + test ActivityBus
// ---------------------------------------------------------------------------

/** A stub AgentClient layer serving canned session + prompt responses. */
const agentStub = (
  overrides: Partial<{
    createSession: (title: string) => Effect.Effect<string, never>;
    prompt: (sessionId: string, text: string) => Effect.Effect<unknown, never>;
  }>,
): Layer.Layer<AgentClient> =>
  Layer.succeed(AgentClient, {
    createSession: overrides.createSession ?? (() => Effect.succeed('session-1')),
    prompt:
      overrides.prompt ??
      (() =>
        Effect.succeed({
          data: {
            parts: [
              { type: 'text', text: '```tsx\nexport default function X() { return null }\n```' },
            ],
          },
        })),
  });

describe('runCardAgent', () => {
  it.effect('creates a session, prompts it, and returns the extracted code', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      const code = yield* runCardAgent('do a thing', 'old code');
      expect(code).toContain('function X');

      const messages = (yield* bus.history).map((e) => e.message);
      expect(messages.some((m) => m.includes('session session-1 created'))).toBe(true);
      expect(messages.some((m) => m.startsWith('done in'))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          agentStub({
            createSession: (title) => {
              // session-create path is exercised with the expected title
              expect(title).toBe('cartis card edit');
              return Effect.succeed('session-1');
            },
            prompt: (sessionId, text) => {
              // the prompt receives the session id and embeds the user request
              expect(sessionId).toBe('session-1');
              expect(text).toContain('do a thing');
              return Effect.succeed({
                data: {
                  parts: [
                    {
                      type: 'text',
                      text: '```tsx\nexport default function X() { return null }\n```',
                    },
                  ],
                },
              });
            },
          }),
          activityBusTestLayer,
        ),
      ),
    ),
  );

  it.effect('fails with AgentError when the agent returns no code', () =>
    runCardAgent('p', 'c').pipe(
      Effect.flip,
      Effect.tap((error) => {
        expect(error._tag).toBe('AgentError');
        expect(error.message).toBe('agent returned no code');
        return Effect.void;
      }),
      Effect.provide(
        Layer.mergeAll(
          agentStub({ prompt: () => Effect.succeed({ data: { parts: [] } }) }),
          activityBusTestLayer,
        ),
      ),
    ),
  );

  it.effect('emits a heartbeat while the prompt is in flight', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      // A prompt that never settles until we let the fiber continue: use a
      // deferred by blocking on TestClock — the prompt sleeps 6s, so a 5s
      // heartbeat fires once before it resolves.
      const fiber = yield* Effect.fork(runCardAgent('slow', 'code'));
      yield* TestClock.adjust('5 seconds');
      // Let the heartbeat land, then release the prompt.
      const before = (yield* bus.history).map((e) => e.message);
      expect(before.some((m) => m.startsWith('still generating…'))).toBe(true);
      yield* TestClock.adjust('2 seconds');
      const code = yield* Fiber.join(fiber);
      expect(code).toContain('function X');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          agentStub({
            prompt: () =>
              Effect.succeed({
                data: {
                  parts: [
                    {
                      type: 'text',
                      text: '```tsx\nexport default function X() { return null }\n```',
                    },
                  ],
                },
              }).pipe(Effect.delay('6 seconds')),
          }),
          activityBusTestLayer,
        ),
      ),
    ),
  );
});

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
      // Two polls: processing, then succeeded.
      yield* TestClock.adjust('1500 millis');
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

  it.effect('surfaces a failed prediction as ReplicateError failed', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.flatMap(ReplicateClient, (c) =>
          c.generate('tok', { prompt: 'p', imageDataUrl: 'data:image/png;base64,QQ==' }),
        ).pipe(Effect.flip),
      );
      yield* TestClock.adjust('1500 millis');
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
