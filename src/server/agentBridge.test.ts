import { Effect, Fiber, Layer, Option, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import type { AgentFillRequestT } from '../contracts/api.ts';
import type { PredictionT } from '../contracts/replicate.ts';
import type { ThreadEventT } from '../contracts/thread.ts';
import { httpClientFromHandler } from '../lib/http.ts';
import {
  AgentClient,
  agentClientFromSdk,
  composeArtPrompt,
  initialWatchState,
  mapAgentEvent,
  type OpencodeClient,
  ReplicateClient,
  ReplicateSdk,
  replicateClientLive,
  runFillAgent,
  type WatchState,
} from './agentBridge.ts';
import { ThreadBus, threadBusTestLayer } from './threadBus.ts';

/** Art-event details from a bus history (the replicate/compose progress lane). */
const artDetails = (history: ReadonlyArray<ThreadEventT>): string[] =>
  history.flatMap((e) => (e._tag === 'Art' && e.detail !== undefined ? [e.detail] : []));

// ---------------------------------------------------------------------------
// composeArtPrompt — stub AgentClient + test ThreadBus
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
    withActivity: (_sessionId, effect) => effect,
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
          threadBusTestLayer,
        ),
      ),
    );
  });

  it.effect('falls back to the lookAndFeel and emits Art composing events', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const prompt = yield* composeArtPrompt(
        { lookAndFeel: 'painterly oil', palette: '', argumentSummary: '' },
        {},
      ).pipe(
        Effect.provide(
          Layer.succeed(AgentClient, {
            createSession: () => Effect.succeed('sess-e'),
            prompt: () => Effect.succeed({ data: { parts: [] } }),
            withActivity: (_sessionId, effect) => effect,
          }),
        ),
      );
      expect(prompt).toBe('painterly oil');
      const details = artDetails(yield* bus.history);
      expect(details.some((d) => d.includes('composing art prompt'))).toBe(true);
    }).pipe(Effect.provide(threadBusTestLayer)),
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
    withActivity: (_sessionId, effect) => effect,
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
      // turn-level notes go to the console-only log lane, not the event stream
      const bus = yield* ThreadBus;
      const logs = yield* bus.logs;
      expect(logs.some((l) => l.includes('fill:'))).toBe(true);
      expect(logs.some((l) => l.includes('fill patch ready'))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          fillStub('{"patch": {"name": "Vorak"}}', calls, sessions),
          threadBusTestLayer,
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
        Layer.mergeAll(fillStub('{"patch": {}}', calls, sessions), threadBusTestLayer),
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
          threadBusTestLayer,
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
            threadBusTestLayer,
          ),
        ),
      );
      expect(ok.patch).toEqual({ name: 'Vorak' });
      // wrong-typed value → typed AgentError
      const err = yield* runFillAgent(fillReq(), noArt).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(fillStub('{"patch": {"cost": "expensive"}}', [], []), threadBusTestLayer),
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
        Layer.mergeAll(fillStub('sorry, I cannot help with that', [], []), threadBusTestLayer),
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

/** sdkStub variant that also records every createPrediction input. */
const recordingSdkStub = (
  sequence: ReadonlyArray<PredictionT>,
  created: object[],
): Layer.Layer<ReplicateSdk> =>
  Layer.effect(
    ReplicateSdk,
    Effect.gen(function* () {
      const idx = yield* Ref.make(0);
      return ReplicateSdk.of({
        createPrediction: (_token, input) => {
          created.push(input);
          return Effect.succeed(sequence[0] as PredictionT);
        },
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
      Layer.mergeAll(sdkStub(sequence), threadBusTestLayer, httpClientFromHandler(pngHandler)),
    ),
    Layer.merge(threadBusTestLayer),
  );

describe('ReplicateClient.generate', () => {
  it.effect(
    'omits input_image for text-first generation (empty data URL) and fixes the aspect',
    () => {
      const created: object[] = [];
      const succeeded: PredictionT = {
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
          c.generate('tok', {
            prompt: 'a mossy henge',
            imageDataUrl: 'data:application/octet-stream;base64,', // empty — no source photo
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
    const succeeded: PredictionT = {
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
        c.generate('tok', {
          prompt: 'stylize me',
          imageDataUrl: 'data:image/png;base64,QQ==',
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

// ---------------------------------------------------------------------------
// mapAgentEvent — pure reducer: raw opencode events → ThreadEvents
// ---------------------------------------------------------------------------

describe('mapAgentEvent', () => {
  const S = 'sess-1';

  const msgUpdated = (id: string, role: string, completed?: number) => ({
    type: 'message.updated',
    properties: {
      info: {
        id,
        role,
        sessionID: S,
        time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
      },
    },
  });

  const partEvent = (over: Record<string, unknown>) => ({
    type: 'message.part.updated',
    properties: { part: { sessionID: S, messageID: 'm1', ...over } },
  });

  /** Run a raw-event sequence through the reducer, collecting all events. */
  const run = (
    raws: readonly unknown[],
    times: readonly number[] = [],
  ): { events: ThreadEventT[]; state: WatchState } => {
    let state = initialWatchState;
    const events: ThreadEventT[] = [];
    raws.forEach((raw, i) => {
      const out = mapAgentEvent(raw, S, state, times[i] ?? 0);
      state = out.state;
      events.push(...out.events);
    });
    return { events, state };
  };

  it('emits TurnStarted once per assistant message; user messages are silent', () => {
    const { events } = run([
      msgUpdated('m1', 'assistant'),
      msgUpdated('m1', 'assistant'), // repeat update — no second TurnStarted
      msgUpdated('u1', 'user'),
    ]);
    expect(events).toEqual([{ _tag: 'TurnStarted', sessionId: S, messageId: 'm1' }]);
  });

  it('maps assistant parts to PartDeltas at stable per-message indexes', () => {
    const { events } = run(
      [
        msgUpdated('m1', 'assistant'),
        partEvent({ type: 'step-start', id: 'p0' }),
        partEvent({
          type: 'tool',
          id: 'p1',
          callID: 'c1',
          tool: 'read',
          state: { status: 'running', title: 'src/main.tsx' },
        }),
        partEvent({ type: 'text', id: 'p2', text: 'The card' }),
        partEvent({
          type: 'tool',
          id: 'p1',
          callID: 'c1',
          tool: 'read',
          state: {
            status: 'completed',
            title: 'src/main.tsx',
            time: { start: 0, end: 2100 },
            output: 'file contents',
          },
        }),
      ],
      [0, 0, 0, 0, 2100],
    );
    expect(events[0]?._tag).toBe('TurnStarted');
    expect(events.slice(1)).toEqual([
      {
        _tag: 'PartDelta',
        sessionId: S,
        messageId: 'm1',
        partIndex: 0,
        part: { _tag: 'Step' },
      },
      {
        _tag: 'PartDelta',
        sessionId: S,
        messageId: 'm1',
        partIndex: 1,
        part: {
          _tag: 'ToolCall',
          callId: 'c1',
          name: 'read',
          title: 'src/main.tsx',
          status: 'running',
        },
      },
      {
        _tag: 'PartDelta',
        sessionId: S,
        messageId: 'm1',
        partIndex: 2,
        part: { _tag: 'Text', text: 'The card' },
      },
      {
        // the completed transition lands at the SAME index as its running state
        _tag: 'PartDelta',
        sessionId: S,
        messageId: 'm1',
        partIndex: 1,
        part: {
          _tag: 'ToolCall',
          callId: 'c1',
          name: 'read',
          title: 'src/main.tsx',
          status: 'completed',
          result: 'file contents',
          secs: 2.1,
        },
      },
    ]);
  });

  it('skips parts of user messages (prompt echo) and unknown-role messages', () => {
    const { events } = run([
      msgUpdated('u1', 'user'),
      partEvent({ type: 'text', id: 'p1', messageID: 'u1', text: 'user prompt echo' }),
      partEvent({ type: 'text', id: 'p2', messageID: 'never-announced', text: 'mystery' }),
    ]);
    expect(events).toEqual([]);
  });

  it('dedupes repeated tool states but lets transitions and errors through', () => {
    const running = partEvent({
      type: 'tool',
      id: 'p1',
      callID: 'c1',
      tool: 'read',
      state: { status: 'running' },
    });
    const { events } = run([
      msgUpdated('m1', 'assistant'),
      running,
      running, // repeat — dropped
      partEvent({
        type: 'tool',
        id: 'p1',
        callID: 'c1',
        tool: 'read',
        state: { status: 'error', error: 'exit 1' },
      }),
    ]);
    const tools = events.filter((e) => e._tag === 'PartDelta');
    expect(tools).toHaveLength(2);
    expect(
      tools.map((e) => (e._tag === 'PartDelta' && e.part._tag === 'ToolCall' ? e.part.status : '')),
    ).toEqual(['running', 'error']);
    const last = tools[1];
    expect(
      last?._tag === 'PartDelta' && last.part._tag === 'ToolCall' ? last.part : undefined,
    ).toMatchObject({ result: 'exit 1', isError: true });
  });

  it('throttles cumulative text to one delta per 2s and flushes the tail at completion', () => {
    const text = (t: string) => partEvent({ type: 'text', id: 'p1', text: t });
    const { events } = run(
      [
        msgUpdated('m1', 'assistant'),
        text('ab'), //        t=0     first chunk emits immediately
        text('abcd'), //      t=1500  inside the window — suppressed (dirty)
        text('abcdef'), //    t=2100  window elapsed — emits cumulative
        text('abcdefgh'), //  t=3000  suppressed (dirty)
        msgUpdated('m1', 'assistant', 3100), // completion → flush + TurnCompleted
        msgUpdated('m1', 'assistant', 3100), // repeat — no second completion
      ],
      [0, 0, 1500, 2100, 3000, 3100, 3200],
    );
    const texts = events.flatMap((e) =>
      e._tag === 'PartDelta' && e.part._tag === 'Text' ? [e.part.text] : [],
    );
    expect(texts).toEqual(['ab', 'abcdef', 'abcdefgh']); // final flush is unthrottled
    const completions = events.filter((e) => e._tag === 'TurnCompleted');
    expect(completions).toEqual([
      { _tag: 'TurnCompleted', sessionId: S, messageId: 'm1', status: 'complete' },
    ]);
    // flush precedes completion
    expect(events[events.length - 1]?._tag).toBe('TurnCompleted');
  });

  it('streams reasoning parts like text', () => {
    const { events } = run([
      msgUpdated('m1', 'assistant'),
      partEvent({ type: 'reasoning', id: 'r1', text: 'thinking about the card' }),
    ]);
    const last = events[events.length - 1];
    expect(last?._tag === 'PartDelta' ? last.part : undefined).toEqual({
      _tag: 'Reasoning',
      text: 'thinking about the card',
    });
  });

  it('filters other sessions, surfaces errors + permissions, drops unknowns', () => {
    const state = initialWatchState;
    expect(
      mapAgentEvent(
        {
          type: 'message.part.updated',
          properties: { part: { sessionID: 'other', messageID: 'm9', type: 'step-start' } },
        },
        S,
        state,
        0,
      ).events,
    ).toEqual([]);
    expect(
      mapAgentEvent(
        { type: 'session.error', properties: { error: { message: 'boom' } } },
        S,
        state,
        0,
      ).events,
    ).toEqual([{ _tag: 'SessionError', message: 'boom' }]);
    expect(
      mapAgentEvent(
        {
          type: 'permission.updated',
          properties: { id: 'perm1', sessionID: S, title: 'Run bash?' },
        },
        S,
        state,
        0,
      ).events,
    ).toEqual([
      { _tag: 'PermissionRequested', sessionId: S, permissionId: 'perm1', title: 'Run bash?' },
    ]);
    expect(
      mapAgentEvent(
        { type: 'permission.updated', properties: { id: 'p2', sessionID: 'other', title: 'x' } },
        S,
        state,
        0,
      ).events,
    ).toEqual([]);
    expect(mapAgentEvent({ type: 'installation.updated' }, S, state, 0).events).toEqual([]);
    expect(mapAgentEvent({ nonsense: true }, S, state, 0).events).toEqual([]);
    expect(mapAgentEvent('not even an object', S, state, 0).events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withActivity — watcher lifecycle over a fake SDK client
// ---------------------------------------------------------------------------

describe('AgentClient.withActivity', () => {
  it('drains mapped events while the effect runs and aborts the subscription after', () => {
    const captured: { signal?: AbortSignal } = {};
    const announce = {
      type: 'message.updated',
      properties: {
        info: { id: 'm1', role: 'assistant', sessionID: 'sess-1', time: { created: 1 } },
      },
    };
    const toolEvent = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          id: 'p1',
          sessionID: 'sess-1',
          messageID: 'm1',
          callID: 'c1',
          tool: 'grep',
          state: { status: 'running', title: 'searching' },
        },
      },
    };
    const fakeClient: OpencodeClient = {
      session: {
        create: () => Promise.resolve({ id: 'sess-1' }),
        prompt: () => Promise.resolve({ data: { parts: [] } }),
      },
      event: {
        subscribe: (opts) => {
          captured.signal = opts.signal;
          // Lazy generator like the real SDK: yields events, then parks
          // until the subscriber aborts (mirrors a long-lived SSE stream).
          const stream = (async function* () {
            yield announce;
            yield toolEvent;
            await new Promise<void>((resolve) => {
              if (opts.signal?.aborted) resolve();
              opts.signal?.addEventListener('abort', () => resolve());
            });
          })();
          return Promise.resolve({ stream });
        },
      },
    };
    return Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const runtime = yield* Effect.runtime<never>();
      const service = agentClientFromSdk(fakeClient, { bus, runtime });
      const result = yield* service.withActivity(
        'sess-1',
        // async effect so the drain loop gets microtask turns while in flight
        Effect.promise(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(captured.signal?.aborted).toBe(false);
          return 42;
        }),
      );
      expect(result).toBe(42);
      expect(captured.signal?.aborted).toBe(true); // released with the scope
      const history = yield* bus.history;
      expect(history.some((e) => e._tag === 'TurnStarted' && e.messageId === 'm1')).toBe(true);
      expect(
        history.some(
          (e) =>
            e._tag === 'PartDelta' &&
            e.part._tag === 'ToolCall' &&
            e.part.name === 'grep' &&
            e.part.status === 'running',
        ),
      ).toBe(true);
    }).pipe(Effect.provide(threadBusTestLayer));
  });
});

// ---------------------------------------------------------------------------
// runFillAgent heartbeat
// ---------------------------------------------------------------------------

describe('runFillAgent heartbeat', () => {
  it.effect('logs still-working while a slow prompt is in flight', () => {
    const slowStub: Layer.Layer<AgentClient> = Layer.succeed(AgentClient, {
      createSession: () => Effect.succeed('s1'),
      prompt: () =>
        Effect.succeed({ data: { parts: [{ type: 'text', text: '{"patch": {}}' }] } }).pipe(
          Effect.delay('6 seconds'),
        ),
      withActivity: (_sessionId, effect) => effect,
    });
    return Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const fiber = yield* Effect.fork(runFillAgent(fillReq(), noArt));
      yield* TestClock.adjust('5 seconds');
      const during = yield* bus.logs;
      expect(during.some((l) => l.includes('still working…'))).toBe(true);
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(slowStub, threadBusTestLayer)));
  });
});
