import { Effect, Fiber, Layer, Option, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import type { AgentFillRequestT } from '../contracts/api.ts';
import type { PredictionT } from '../contracts/replicate.ts';
import { httpClientFromHandler } from '../lib/http.ts';
import { ActivityBus, activityBusTestLayer } from './activity.ts';
import {
  AgentClient,
  composeArtPrompt,
  ReplicateClient,
  ReplicateSdk,
  replicateClientLive,
  runFillAgent,
} from './agentBridge.ts';

// ---------------------------------------------------------------------------
// composeArtPrompt — stub AgentClient + test ActivityBus
// ---------------------------------------------------------------------------

/** Stub AgentClient whose prompt() records the instruction and answers with prose. */
const composeStub = (record: (text: string) => void): Layer.Layer<AgentClient> =>
  Layer.succeed(AgentClient, {
    createSession: () => Effect.succeed('sess-c'),
    prompt: (_id, text) => {
      record(text);
      return Effect.succeed({
        data: { parts: [{ type: 'text', text: 'a mythic ember mage, oil painting' }] },
      });
    },
  });

describe('composeArtPrompt', () => {
  it.effect('feeds lookAndFeel, argument values, and brief to the model', () => {
    let seen = '';
    return Effect.gen(function* () {
      const prompt = yield* composeArtPrompt(
        { lookAndFeel: 'painterly oil', palette: 'ember warm', argumentSummary: 'name, essence' },
        { name: 'Nyra', essence: 'ember' },
        'make him angrier',
      );
      expect(prompt).toContain('oil painting');
      // the composed instruction we sent embedded every input
      expect(seen).toContain('painterly oil');
      expect(seen).toContain('ember warm');
      expect(seen).toContain('Nyra');
      expect(seen).toContain('make him angrier');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          composeStub((t) => {
            seen = t;
          }),
          activityBusTestLayer,
        ),
      ),
    );
  });

  it.effect('falls back to the lookAndFeel when the model returns no text', () =>
    Effect.gen(function* () {
      const bus = yield* ActivityBus;
      const prompt = yield* composeArtPrompt(
        { lookAndFeel: 'painterly oil', palette: '', argumentSummary: '' },
        {},
      ).pipe(
        Effect.provide(
          Layer.succeed(AgentClient, {
            createSession: () => Effect.succeed('sess-e'),
            prompt: () => Effect.succeed({ data: { parts: [] } }),
          }),
        ),
      );
      expect(prompt).toBe('painterly oil');
      const messages = (yield* bus.history).map((e) => e.message);
      expect(messages.some((m) => m.includes('composing art prompt'))).toBe(true);
    }).pipe(Effect.provide(activityBusTestLayer)),
  );
});

// ---------------------------------------------------------------------------
// runFillAgent — session reuse, targeted patch, vision attach, Schema-reject
// ---------------------------------------------------------------------------

interface PromptCall {
  sessionId: string;
  text: string;
  image?: { mime: string; dataUrl: string };
}

/** Stub AgentClient that records calls and replies with a fixed text. */
const fillStub = (
  reply: string,
  calls: PromptCall[],
  sessions: string[],
): Layer.Layer<AgentClient> =>
  Layer.succeed(AgentClient, {
    createSession: (title) => {
      sessions.push(title);
      return Effect.succeed('fresh-session');
    },
    prompt: (sessionId, text, image) => {
      calls.push({ sessionId, text, image });
      return Effect.succeed({ data: { parts: [{ type: 'text', text: reply }] } });
    },
  });

const noArt = () => Effect.succeed(Option.none<{ mime: string; dataUrl: string }>());

const fillReq = (overrides: Partial<AgentFillRequestT> = {}): AgentFillRequestT => ({
  sessionId: undefined,
  themeContext: { lookAndFeel: 'painterly oil', palette: 'ember', argumentSummary: 'name, cost' },
  fields: [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'cost', label: 'Cost' },
  ],
  currentData: { name: 'Nyra', ability: 'Hand-edited.' },
  currentArtFileName: undefined,
  userPrompt: 'rename him to Vorak',
  ...overrides,
});

describe('runFillAgent', () => {
  it.effect('creates a session on the first turn and returns a targeted patch', () => {
    const calls: PromptCall[] = [];
    const sessions: string[] = [];
    return Effect.gen(function* () {
      const out = yield* runFillAgent(fillReq(), noArt);
      expect(sessions).toEqual(['cartis card fill']);
      expect(out.sessionId).toBe('fresh-session');
      expect(out.patch).toEqual({ name: 'Vorak' });
      // per-turn snapshot: the prompt embeds currentData (hand edits win)
      expect(calls[0]?.text).toContain('Hand-edited.');
      expect(calls[0]?.text).toContain('rename him to Vorak');
      expect(calls[0]?.image).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fillStub('{"patch": {"name": "Vorak"}}', calls, sessions),
          activityBusTestLayer,
        ),
      ),
    );
  });

  it.effect('reuses the passed sessionId without creating a session', () => {
    const calls: PromptCall[] = [];
    const sessions: string[] = [];
    return Effect.gen(function* () {
      const out = yield* runFillAgent(fillReq({ sessionId: 'episode-1' }), noArt);
      expect(sessions).toEqual([]); // createSession NOT called
      expect(out.sessionId).toBe('episode-1');
      expect(calls[0]?.sessionId).toBe('episode-1');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(fillStub('{"patch": {}}', calls, sessions), activityBusTestLayer),
      ),
    );
  });

  it.effect('attaches the current art for vision and decodes an artAction', () => {
    const calls: PromptCall[] = [];
    return Effect.gen(function* () {
      const out = yield* runFillAgent(fillReq({ currentArtFileName: 'nyra-abc123.png' }), () =>
        Effect.succeed(Option.some({ mime: 'image/png', dataUrl: 'data:image/png;base64,QQ==' })),
      );
      expect(calls[0]?.image?.mime).toBe('image/png');
      expect(out.artAction).toEqual({ brief: 'angrier face', editCurrentArt: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fillStub(
            '{"patch": {}, "artAction": {"brief": "angrier face", "editCurrentArt": true}}',
            calls,
            [],
          ),
          activityBusTestLayer,
        ),
      ),
    );
  });

  it.effect('drops patch keys outside the field spec and rejects wrong types', () => {
    const calls: PromptCall[] = [];
    return Effect.gen(function* () {
      // extra key silently dropped by the derived schema
      const ok = yield* runFillAgent(fillReq(), noArt).pipe(
        Effect.provide(
          Layer.mergeAll(
            fillStub('{"patch": {"name": "Vorak", "hacker": "x"}}', calls, []),
            activityBusTestLayer,
          ),
        ),
      );
      expect(ok.patch).toEqual({ name: 'Vorak' });
      // wrong-typed value → typed AgentError
      const err = yield* runFillAgent(fillReq(), noArt).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(
            fillStub('{"patch": {"cost": "expensive"}}', [], []),
            activityBusTestLayer,
          ),
        ),
      );
      expect(err._tag).toBe('AgentError');
      expect(err.message).toBe('agent returned no fill patch');
    });
  });

  it.effect('fails with a typed AgentError on a non-JSON reply', () =>
    runFillAgent(fillReq(), noArt).pipe(
      Effect.flip,
      Effect.tap((error) => {
        expect(error._tag).toBe('AgentError');
        expect(error.message).toBe('agent returned no fill patch');
        return Effect.void;
      }),
      Effect.provide(
        Layer.mergeAll(fillStub('sorry, I cannot help with that', [], []), activityBusTestLayer),
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
