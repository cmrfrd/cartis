import { type Context, Effect, Fiber, Layer, Option, Redacted, Ref, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import type { ChatTurnRequestT } from '@/contracts/api.ts';
import { AgentError } from '@/contracts/errors.ts';
import {
  DataUrl,
  FileName,
  MessageId,
  MimeType,
  PermissionId,
  SessionId,
} from '@/contracts/ids.ts';
import type { SessionInfoT, SessionMessagesT } from '@/contracts/opencode.ts';
import type { PredictionT } from '@/contracts/replicate.ts';
import type { ThreadEventT } from '@/contracts/thread.ts';
import { httpClientFromHandler } from '@/lib/http.ts';
import { it } from '../../test/effect.ts';
import {
  AgentClient,
  agentClientFromSdk,
  composeArtPrompt,
  initialWatchState,
  mapAgentEvent,
  mapSessionMessages,
  type OpencodeClient,
  opencodeClientOf,
  type PromptFile,
  ReplicateClient,
  ReplicateSdk,
  replicateClientLive,
  runChatTurn,
  sessionSummary,
  siblingSet,
  type WatchState,
} from './agentBridge.ts';
import { ThreadBus, threadBusTestLayer } from './threadBus.ts';

/** Art-event details from a bus history (the replicate/compose progress lane). */
const artDetails = (history: ReadonlyArray<ThreadEventT>): string[] =>
  history.flatMap((e) => (e._tag === 'Art' && e.detail !== undefined ? [e.detail] : []));

type AgentSvc = Context.Tag.Service<AgentClient>;

/** Full AgentClient stub — the passthrough ops default to no-op/empty. */
const agentLayer = (over: Partial<AgentSvc>): Layer.Layer<AgentClient> =>
  Layer.succeed(AgentClient, {
    createSession: () => Effect.succeed(SessionId.make('sess')),
    prompt: () => Effect.succeed({ data: { parts: [] } }),
    withActivity: (_sessionId, effect) => effect,
    messages: () => Effect.succeed([] as SessionMessagesT),
    info: () => Effect.fail(new AgentError({ reason: 'no-session-id' })),
    abort: () => Effect.void,
    revert: () => Effect.void,
    fork: () => Effect.fail(new AgentError({ reason: 'no-session-id' })),
    children: () => Effect.succeed([] as SessionInfoT[]),
    replyPermission: () => Effect.void,
    ...over,
  });

// ---------------------------------------------------------------------------
// composeArtPrompt — stub AgentClient + test ThreadBus
// ---------------------------------------------------------------------------

/** Stub AgentClient whose prompt() records the instruction and answers with prose. */
const composeStub = (record: (text: string) => void): Layer.Layer<AgentClient> =>
  agentLayer({
    createSession: () => Effect.succeed(SessionId.make('sess-c')),
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
          agentLayer({
            createSession: () => Effect.succeed(SessionId.make('sess-e')),
            prompt: () => Effect.succeed({ data: { parts: [] } }),
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
// runChatTurn — session reuse, reply + patch, vision attach, conversational
// ---------------------------------------------------------------------------

interface PromptCall {
  sessionId: string;
  text: string;
  files?: readonly PromptFile[];
}

/** Stub AgentClient that records prompt calls and replies with a fixed text. */
const chatStub = (
  reply: string,
  calls: PromptCall[],
  sessions: string[],
): Layer.Layer<AgentClient> =>
  agentLayer({
    createSession: (title) => {
      sessions.push(title);
      return Effect.succeed(SessionId.make('fresh-session'));
    },
    prompt: (sessionId, text, files) => {
      calls.push({ sessionId, text, files });
      return Effect.succeed({ data: { parts: [{ type: 'text', text: reply }] } });
    },
  });

const noArt = () => Effect.succeed(Option.none<{ mime: string; dataUrl: string }>());

// Terse brand minting for attachment fixtures.
const fileName = (n: string) => FileName.make(n);
const mime = (m: string) => MimeType.make(m);
const dataUrl = (m: string) => DataUrl.make(`data:${m};base64,QQ==`);

const chatReq = (overrides: Partial<ChatTurnRequestT> = {}): ChatTurnRequestT => ({
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

describe('runChatTurn', () => {
  it.effect('creates a session on the first turn and returns reply text + patch', () => {
    const calls: PromptCall[] = [];
    const sessions: string[] = [];
    return Effect.gen(function* () {
      const out = yield* runChatTurn(chatReq(), noArt);
      expect(sessions).toEqual(['cartis card chat']);
      expect(out.sessionId).toBe('fresh-session');
      expect(out.patch).toEqual({ name: 'Vorak' });
      // assistantText is the RAW model output (the client materializes it)
      expect(out.assistantText).toContain('Renamed him');
      // per-turn snapshot: the prompt embeds currentData (hand edits win)
      expect(calls[0]?.text).toContain('Hand-edited.');
      expect(calls[0]?.text).toContain('rename him to Vorak');
      expect(calls[0]?.files).toBeUndefined();
      // turn-level notes go to the console-only log lane, not the event stream
      const bus = yield* ThreadBus;
      const logs = yield* bus.logs;
      expect(logs.some((l) => l.includes('chat:'))).toBe(true);
      expect(logs.some((l) => l.includes('chat turn ready'))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          chatStub('{"reply": "Renamed him.", "patch": {"name": "Vorak"}}', calls, sessions),
          threadBusTestLayer,
        ),
      ),
    );
  });

  it.effect('reuses the passed sessionId without creating a session', () => {
    const calls: PromptCall[] = [];
    const sessions: string[] = [];
    return Effect.gen(function* () {
      const out = yield* runChatTurn(chatReq({ sessionId: SessionId.make('card-1') }), noArt);
      expect(sessions).toEqual([]); // createSession NOT called
      expect(out.sessionId).toBe('card-1');
      expect(calls[0]?.sessionId).toBe('card-1');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          chatStub('{"reply": "ok", "patch": {}}', calls, sessions),
          threadBusTestLayer,
        ),
      ),
    );
  });

  it.effect('attaches the current art for vision and decodes an artAction', () => {
    const calls: PromptCall[] = [];
    return Effect.gen(function* () {
      const out = yield* runChatTurn(chatReq({ currentArtFileName: 'nyra-abc123.png' }), () =>
        Effect.succeed(Option.some({ mime: 'image/png', dataUrl: 'data:image/png;base64,QQ==' })),
      );
      // art context rides as an UNNAMED file part (no filename — invisible in history)
      expect(calls[0]?.files).toEqual([{ mime: 'image/png', url: 'data:image/png;base64,QQ==' }]);
      expect(out.artAction).toEqual({ brief: 'angrier face', editCurrentArt: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          chatStub(
            '{"reply": "Making him fiercer.", "patch": {}, "artAction": {"brief": "angrier face", "editCurrentArt": true}}',
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
      const ok = yield* runChatTurn(chatReq(), noArt).pipe(
        Effect.provide(
          Layer.mergeAll(
            chatStub('{"reply": "done", "patch": {"name": "Vorak", "hacker": "x"}}', calls, []),
            threadBusTestLayer,
          ),
        ),
      );
      expect(ok.patch).toEqual({ name: 'Vorak' });
      // wrong-typed value → typed AgentError (the model tried to patch but mistyped)
      const err = yield* runChatTurn(chatReq(), noArt).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(
            chatStub('{"reply": "done", "patch": {"cost": "expensive"}}', [], []),
            threadBusTestLayer,
          ),
        ),
      );
      expect(err._tag).toBe('AgentError');
    });
  });

  it.effect('treats a plain-text reply (no JSON) as a conversational turn, not an error', () =>
    Effect.gen(function* () {
      const out = yield* runChatTurn(chatReq(), noArt);
      // conversational: no patch, but the prose is preserved for materialization
      expect(out.patch).toEqual({});
      expect(out.artAction).toBeUndefined();
      expect(out.assistantText).toBe('Which essence should Vorak have?');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(chatStub('Which essence should Vorak have?', [], []), threadBusTestLayer),
      ),
    ),
  );

  it.effect(
    'sends user attachments as filename’d file parts BEFORE the unnamed art context',
    () => {
      const calls: PromptCall[] = [];
      return Effect.gen(function* () {
        yield* runChatTurn(
          chatReq({
            currentArtFileName: 'nyra-abc123.png',
            attachments: [
              { name: fileName('ref.png'), mime: mime('image/png'), dataUrl: dataUrl('image/png') },
              {
                name: fileName('notes.md'),
                mime: mime('text/markdown'),
                dataUrl: dataUrl('text/markdown'),
              },
            ],
          }),
          () =>
            Effect.succeed(
              Option.some({ mime: 'image/png', dataUrl: 'data:image/png;base64,QQ==' }),
            ),
        );
        expect(calls[0]?.files).toEqual([
          { mime: 'image/png', url: dataUrl('image/png'), filename: 'ref.png' },
          { mime: 'text/markdown', url: dataUrl('text/markdown'), filename: 'notes.md' },
          { mime: 'image/png', url: 'data:image/png;base64,QQ==' }, // art context: NO filename
        ]);
      }).pipe(
        Effect.provide(Layer.mergeAll(chatStub('{"reply":"ok"}', calls, []), threadBusTestLayer)),
      );
    },
  );

  it.effect(
    'repairs model JSON with unescaped inner quotes and APPLIES the patch (live-caught)',
    () => {
      const calls: PromptCall[] = [];
      return Effect.gen(function* () {
        const out = yield* runChatTurn(chatReq(), noArt);
        // the goblin-engineer class: flavor with unescaped quotes must not drop the patch
        expect(out.patch).toEqual({ name: 'Grubwick Boltsnap' });
        expect(out.artAction).toEqual({ brief: 'ugly goblin', editCurrentArt: false });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            chatStub(
              '{"reply": "Made a goblin.", "patch": {"name": "Grubwick Boltsnap", "hacker": ""I meant to do that.""}, "artAction": {"brief": "ugly goblin", "editCurrentArt": false}}',
              calls,
              [],
            ),
            threadBusTestLayer,
          ),
        ),
      );
    },
  );

  it.effect('a hopelessly mangled contract fails the turn with a typed error (no raw blob)', () =>
    Effect.gen(function* () {
      const err = yield* runChatTurn(chatReq(), noArt).pipe(Effect.flip);
      expect(err._tag).toBe('AgentError');
      expect((err as AgentError).reason).toBe('bad-reply');
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          // unbalanced braces — beyond the repair pass
          chatStub('{"reply": "tried", "patch": {"cost": }', [], []),
          threadBusTestLayer,
        ),
      ),
    ),
  );

  it.effect('an attachment-only turn sends the stand-in request text', () => {
    const calls: PromptCall[] = [];
    return Effect.gen(function* () {
      yield* runChatTurn(
        chatReq({
          userPrompt: '',
          attachments: [
            { name: fileName('ref.png'), mime: mime('image/png'), dataUrl: dataUrl('image/png') },
          ],
        }),
        noArt,
      );
      expect(calls[0]?.text.endsWith('Author request: (see attached files)')).toBe(true);
    }).pipe(
      Effect.provide(Layer.mergeAll(chatStub('{"reply":"ok"}', calls, []), threadBusTestLayer)),
    );
  });
});

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
// mapAgentEvent — pure reducer: raw opencode events → ThreadEvents
// ---------------------------------------------------------------------------

describe('mapAgentEvent', () => {
  const S = SessionId.make('sess-1');

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
    expect(events).toEqual([
      { _tag: 'TurnStarted', sessionId: S, messageId: MessageId.make('m1') },
    ]);
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
        messageId: MessageId.make('m1'),
        partIndex: 0,
        part: { _tag: 'Step' },
      },
      {
        _tag: 'PartDelta',
        sessionId: S,
        messageId: MessageId.make('m1'),
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
        messageId: MessageId.make('m1'),
        partIndex: 2,
        part: { _tag: 'Text', text: 'The card' },
      },
      {
        // the completed transition lands at the SAME index as its running state
        _tag: 'PartDelta',
        sessionId: S,
        messageId: MessageId.make('m1'),
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
      { _tag: 'TurnCompleted', sessionId: S, messageId: MessageId.make('m1'), status: 'complete' },
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
      {
        _tag: 'PermissionRequested',
        sessionId: S,
        permissionId: PermissionId.make('perm1'),
        title: 'Run bash?',
      },
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
        info: {
          id: MessageId.make('m1'),
          role: 'assistant',
          sessionID: 'sess-1',
          time: { created: 1 },
        },
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
    const notImplemented = () => Promise.resolve({});
    const fakeClient: OpencodeClient = {
      session: {
        create: () => Promise.resolve({ id: 'sess-1' }),
        prompt: () => Promise.resolve({ data: { parts: [] } }),
        messages: notImplemented,
        get: notImplemented,
        abort: notImplemented,
        revert: notImplemented,
        fork: notImplemented,
        children: notImplemented,
      },
      permission: notImplemented,
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
        SessionId.make('sess-1'),
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
// opencodeClientOf — SDK adapter (permission dispatch, no casts)
// ---------------------------------------------------------------------------

describe('opencodeClientOf', () => {
  it('routes permission replies to postSessionIdPermissionsPermissionId', async () => {
    // The REAL SDK has no `permission` method — the old `as unknown as` cast
    // hid a runtime TypeError on every permission reply. The adapter maps it.
    const seen: unknown[] = [];
    const fakeSdk = {
      session: {
        create: () => Promise.resolve({}),
        prompt: () => Promise.resolve({}),
        messages: () => Promise.resolve({}),
        get: () => Promise.resolve({}),
        abort: () => Promise.resolve({}),
        revert: () => Promise.resolve({}),
        fork: () => Promise.resolve({}),
        children: () => Promise.resolve({}),
      },
      postSessionIdPermissionsPermissionId: (input: unknown) => {
        seen.push(input);
        return Promise.resolve({ ok: true });
      },
      event: { subscribe: () => Promise.resolve({}) },
    };
    const client = opencodeClientOf(fakeSdk);
    await client.permission({ path: { id: 's1', permissionID: 'p1' } });
    expect(seen).toEqual([{ path: { id: 's1', permissionID: 'p1' } }]);
  });
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
// ---------------------------------------------------------------------------

describe('runChatTurn heartbeat', () => {
  it.effect('logs still-working while a slow prompt is in flight', () => {
    const slowStub = agentLayer({
      createSession: () => Effect.succeed(SessionId.make('s1')),
      prompt: () =>
        Effect.succeed({ data: { parts: [{ type: 'text', text: '{"reply": "ok"}' }] } }).pipe(
          Effect.delay('6 seconds'),
        ),
    });
    return Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const fiber = yield* Effect.fork(runChatTurn(chatReq(), noArt));
      yield* TestClock.adjust('5 seconds');
      const during = yield* bus.logs;
      expect(during.some((l) => l.includes('still working…'))).toBe(true);
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(slowStub, threadBusTestLayer)));
  });
});

// ---------------------------------------------------------------------------
// mapSessionMessages — opencode history → thread messages (revert-excluded)
// ---------------------------------------------------------------------------

describe('mapSessionMessages', () => {
  it('maps named user file parts to Image/File and skips the unnamed art context', () => {
    const out = mapSessionMessages([
      {
        info: { id: MessageId.make('u1'), role: 'user', time: { created: 1 } },
        parts: [
          {
            id: 'f1',
            type: 'file',
            mime: 'image/png',
            filename: 'ref.png',
            url: 'data:image/png;base64,AA==',
          },
          {
            id: 'f2',
            type: 'file',
            mime: 'text/markdown',
            filename: 'notes.md',
            url: 'data:text/markdown;base64,QQ==',
          },
          // unnamed = the invisible auto-attached card-art context
          { id: 'f3', type: 'file', mime: 'image/png', url: 'data:image/png;base64,BB==' },
          { id: 'p0', type: 'text', text: 'Author request: like this reference' },
        ],
      },
    ]);
    expect(out[0]?.parts).toEqual([
      { _tag: 'Image', url: 'data:image/png;base64,AA==' },
      { _tag: 'File', name: 'notes.md', mime: 'text/markdown' },
      { _tag: 'Text', text: 'like this reference' },
    ]);
  });

  it('maps a user + assistant exchange, materializing the v1 JSON reply', () => {
    const out = mapSessionMessages([
      {
        info: { id: MessageId.make('u1'), role: 'user', time: { created: 1 } },
        parts: [{ id: 'p0', type: 'text', text: 'rename him' }],
      },
      {
        info: { id: MessageId.make('m1'), role: 'assistant', time: { created: 2, completed: 3 } },
        parts: [{ id: 'p1', type: 'text', text: '{"reply": "Renamed.", "patch": {"name": "Q"}}' }],
      },
    ]);
    expect(out).toEqual([
      {
        id: MessageId.make('u1'),
        role: 'user',
        status: 'complete',
        parts: [{ _tag: 'Text', text: 'rename him' }],
      },
      {
        id: MessageId.make('m1'),
        role: 'assistant',
        status: 'complete',
        parts: [
          { _tag: 'Text', text: 'Renamed.' },
          {
            _tag: 'ToolCall',
            callId: 'card_patch',
            name: 'card_patch',
            title: 'Edit card fields',
            status: 'completed',
            argsText: '{"name":"Q"}',
          },
        ],
      },
    ]);
  });

  it('maps real tool parts directly, before the materialized card actions', () => {
    const out = mapSessionMessages([
      {
        info: { id: MessageId.make('m1'), role: 'assistant', time: { created: 1, completed: 2 } },
        parts: [
          {
            id: 'p1',
            type: 'tool',
            callID: 'c1',
            tool: 'read',
            state: {
              status: 'completed',
              title: 'card.json',
              input: { path: 'card.json' },
              output: 'contents',
              time: { start: 0, end: 1500 },
            },
          },
          { id: 'p2', type: 'text', text: '{"reply": "Read it.", "patch": {}}' },
        ],
      },
    ]);
    expect(out[0]?.parts).toEqual([
      {
        _tag: 'ToolCall',
        callId: 'c1',
        name: 'read',
        title: 'card.json',
        status: 'completed',
        argsText: '{"path":"card.json"}',
        result: 'contents',
        secs: 1.5,
      },
      { _tag: 'Text', text: 'Read it.' },
    ]);
  });

  it('marks a message with an error as incomplete', () => {
    const out = mapSessionMessages([
      {
        info: {
          id: MessageId.make('m1'),
          role: 'assistant',
          time: { created: 1 },
          error: { name: 'aborted' },
        },
        parts: [{ id: 'p1', type: 'text', text: 'partial…' }],
      },
    ]);
    expect(out[0]?.status).toBe('incomplete');
  });

  it('excludes messages at and after the revert point (no ghosts)', () => {
    const messages: SessionMessagesT = [
      {
        info: { id: MessageId.make('u1'), role: 'user', time: { created: 1 } },
        parts: [{ id: 'a', type: 'text', text: 'first' }],
      },
      {
        info: { id: MessageId.make('m1'), role: 'assistant', time: { created: 2, completed: 3 } },
        parts: [{ id: 'b', type: 'text', text: '{"reply": "one"}' }],
      },
      {
        info: { id: MessageId.make('u2'), role: 'user', time: { created: 4 } },
        parts: [{ id: 'c', type: 'text', text: 'reverted prompt' }],
      },
      {
        info: { id: MessageId.make('m2'), role: 'assistant', time: { created: 5 } },
        parts: [{ id: 'd', type: 'text', text: '{"reply": "ghost"}' }],
      },
    ];
    const out = mapSessionMessages(messages, 'u2');
    expect(out.map((m) => m.id)).toEqual(['u1', 'm1']); // u2 + everything after dropped
  });

  it('strips the turn scaffold from a rehydrated user message (shows the typed request)', () => {
    const scaffold =
      'You are editing a trading-card record…\n\n' +
      'Look and feel: oil\n\n' +
      'Fields: name (text)\n\n' +
      'Current values (respect these; the author may have hand-edited): {"name":"Nyra"}\n\n' +
      'Author request: rename this card to Vorak';
    const out = mapSessionMessages([
      {
        info: { id: MessageId.make('u1'), role: 'user', time: { created: 1 } },
        parts: [{ id: 'p0', type: 'text', text: scaffold }],
      },
    ]);
    expect(out[0]?.parts).toEqual([{ _tag: 'Text', text: 'rename this card to Vorak' }]);
  });

  it('skips synthetic text parts (internal) when concatenating', () => {
    const out = mapSessionMessages([
      {
        info: { id: MessageId.make('u1'), role: 'user', time: { created: 1 } },
        parts: [
          { id: 'p0', type: 'text', text: 'system preamble', synthetic: true },
          { id: 'p1', type: 'text', text: 'the real ask' },
        ],
      },
    ]);
    expect(out[0]?.parts).toEqual([{ _tag: 'Text', text: 'the real ask' }]);
  });
});

describe('sessionSummary', () => {
  it('maps a session envelope to a thread summary (branch picker)', () => {
    expect(sessionSummary({ id: 'b1', title: 'edited branch', parentID: 'a0' })).toEqual({
      sessionId: SessionId.make('b1'),
      title: 'edited branch',
      parentId: SessionId.make('a0'),
    });
    // optionals absent → omitted, id absent → empty string
    expect(sessionSummary({})).toEqual({ sessionId: SessionId.make('') });
  });
});

// ---------------------------------------------------------------------------
// siblingSet — parent-first branch set for the ‹ n/m › picker
// ---------------------------------------------------------------------------

describe('siblingSet', () => {
  const infoStub = (
    infos: Record<string, SessionInfoT>,
    childrenOf: Record<string, SessionInfoT[]>,
  ): Layer.Layer<AgentClient> =>
    agentLayer({
      info: (id) => {
        const info = infos[id];
        return info !== undefined
          ? Effect.succeed(info)
          : Effect.fail(new AgentError({ reason: 'no-session-id' }));
      },
      children: (id) => Effect.succeed(childrenOf[id] ?? []),
    });

  it.effect('a forked session resolves its parent and lists parent-first', () =>
    Effect.gen(function* () {
      const out = yield* siblingSet(SessionId.make('fork-1'));
      expect(out.map((s) => s.sessionId)).toEqual(['root', 'fork-1', 'fork-2']);
      expect(out[0]?.parentId).toBeUndefined(); // the root is marked by absence
    }).pipe(
      Effect.provide(
        infoStub(
          {
            'fork-1': { id: 'fork-1', parentID: 'root' },
            root: { id: 'root', title: 'card chat' },
          },
          {
            root: [
              { id: 'fork-1', parentID: 'root' },
              { id: 'fork-2', parentID: 'root' },
            ],
          },
        ),
      ),
    ),
  );

  it.effect('an unforked session is its own root (self + own children)', () =>
    Effect.gen(function* () {
      const out = yield* siblingSet(SessionId.make('root'));
      expect(out.map((s) => s.sessionId)).toEqual(['root', 'fork-1']);
    }).pipe(
      Effect.provide(
        infoStub({ root: { id: 'root' } }, { root: [{ id: 'fork-1', parentID: 'root' }] }),
      ),
    ),
  );

  it.effect('an unknown session yields an empty set (no arrows)', () =>
    Effect.gen(function* () {
      const out = yield* siblingSet(SessionId.make('gone'));
      expect(out).toEqual([]);
    }).pipe(Effect.provide(infoStub({}, {}))),
  );

  it.effect('an ID-LESS info (opencode error body decodes leniently) also yields empty', () =>
    Effect.gen(function* () {
      const out = yield* siblingSet(SessionId.make('gone'));
      expect(out).toEqual([]); // live-caught: no ghost { sessionId: "" } summary
    }).pipe(
      Effect.provide(
        agentLayer({ info: () => Effect.succeed({}), children: () => Effect.succeed([]) }),
      ),
    ),
  );
});
