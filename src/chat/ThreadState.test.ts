import { Effect, Layer, PubSub as PS, type PubSub } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import type { ChatTurnResponseT } from '../contracts/api';
import { AgentFillError, NetworkError } from '../contracts/errors';
import type { ThreadEventT } from '../contracts/thread';
import { type ChatEvents, chatEventsFromPubSub } from './ChatEvents';
import { ChatThread, type ChatThreadShape } from './ChatThread';
import { type ChatContext, ThreadState } from './ThreadState';

/** A ChatThread fake — turn defaults to a canned reply; ops are inert. */
const threadStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () =>
      Effect.succeed({
        sessionId: 'ses-1',
        assistantText: '{"reply":"ok"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    history: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () =>
      Effect.succeed({
        sessionId: 'ses-1',
        assistantText: '{"reply":"again"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    fork: () => Effect.succeed('fork-1'),
    replyPermission: () => Effect.void,
    ...over,
  });

const contextOf = (over: Partial<ChatContext> = {}): ChatContext => ({
  themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
  fields: [{ kind: 'text', key: 'name', label: 'Name' }],
  currentData: { name: 'Nyra' },
  applyPatch: () => {},
  runArt: () => {},
  ...over,
});

/** Install a fake app layer, then create a ThreadState bound to `ctx`. */
const makeThread = (
  thread: Layer.Layer<ChatThread>,
  events?: Layer.Layer<ChatEvents>,
  ctx: ChatContext = contextOf(),
): ThreadState => {
  setAppLayer(testAppLayerWith(events ? { thread, threadEvents: events } : { thread }));
  const state = ThreadState.new();
  state.context = () => ctx;
  return state;
};

describe('ThreadState.send', () => {
  it('appends a user bubble, materializes the reply, and clears running', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed({
            sessionId: 'ses-9',
            assistantText: '{"reply":"Renamed him.","patch":{"name":"Vorak"}}',
            patch: { name: 'Vorak' },
          }),
      }),
    );
    await state.send('rename him');
    expect(state.running).toBe(false);
    expect(state.sessionId).toBe('ses-9'); // lazy session captured
    expect(state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(state.messages[0]?.parts).toEqual([{ _tag: 'Text', text: 'rename him' }]);
    const assistant = state.messages[1];
    expect(assistant?.status).toBe('complete');
    expect(assistant?.parts[0]).toEqual({ _tag: 'Text', text: 'Renamed him.' });
    expect(assistant?.parts[1]?._tag).toBe('ToolCall'); // card_patch chip
    state.set(null);
  });

  it('applies the validated patch and runs the art action via the context', async () => {
    const applied: unknown[] = [];
    const arts: unknown[] = [];
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed({
            sessionId: 'ses-1',
            assistantText:
              '{"reply":"done","patch":{"name":"Q"},"artAction":{"brief":"b","editCurrentArt":true}}',
            patch: { name: 'Q' },
            artAction: { brief: 'b', editCurrentArt: true },
          }),
      }),
      undefined,
      contextOf({
        applyPatch: (p) => applied.push(p),
        runArt: (a) => arts.push(a),
      }),
    );
    await state.send('make art');
    expect(applied).toEqual([{ name: 'Q' }]);
    expect(arts).toEqual([{ brief: 'b', editCurrentArt: true }]);
    state.set(null);
  });

  it('finalizes a failed turn as incomplete with an error strip (no toast)', async () => {
    const state = makeThread(
      threadStub({
        turn: () => Effect.fail(new AgentFillError({ status: 503, detail: 'opencode down' })),
      }),
    );
    await state.send('hi');
    const assistant = state.messages[1];
    expect(assistant?.status).toBe('incomplete');
    expect(assistant?.parts.at(-1)?._tag).toBe('Text');
    expect(state.note).toBeDefined();
    expect(state.running).toBe(false);
    state.set(null);
  });

  it('ignores a second send while a turn is running (one turn at a time)', async () => {
    let calls = 0;
    const state = makeThread(
      threadStub({
        turn: () => {
          calls += 1;
          return Effect.succeed({
            sessionId: 's',
            assistantText: '{"reply":"ok"}',
            patch: {},
          }).pipe(Effect.delay('50 millis'));
        },
      }),
    );
    const first = state.send('one');
    await state.send('two'); // running → ignored immediately
    await first;
    expect(calls).toBe(1);
    expect(state.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    state.set(null);
  });

  it('does nothing without a context or on empty text', async () => {
    const state = makeThread(threadStub());
    state.context = () => undefined;
    await state.send('hi');
    expect(state.messages).toHaveLength(0);
    state.context = () => contextOf();
    await state.send('   ');
    expect(state.messages).toHaveLength(0);
    state.set(null);
  });
});

describe('ThreadState streaming (SSE fold)', () => {
  it('builds a running assistant message from streamed events', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.sessionId = 's1'; // bound so the session filter passes
    const publish = (e: ThreadEventT) => Effect.runPromise(PubSubPublish(pubsub, e));
    await vi.waitFor(async () => {
      await publish({ _tag: 'TurnStarted', sessionId: 's1', messageId: 'm1' });
      expect(state.messages.some((m) => m.id === 'm1')).toBe(true);
    });
    await publish({
      _tag: 'PartDelta',
      sessionId: 's1',
      messageId: 'm1',
      partIndex: 0,
      part: { _tag: 'Text', text: 'streaming…' },
    });
    await vi.waitFor(() => {
      expect(state.messages[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'streaming…' });
    });
    state.set(null);
  });

  it('filters events from other sessions', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.sessionId = 's1';
    await Effect.runPromise(
      PubSubPublish(pubsub, { _tag: 'TurnStarted', sessionId: 'other', messageId: 'x' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(state.messages).toHaveLength(0);
    state.set(null);
  });

  it('records a pending permission from the stream', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.sessionId = 's1';
    await vi.waitFor(async () => {
      await Effect.runPromise(
        PubSubPublish(pubsub, {
          _tag: 'PermissionRequested',
          sessionId: 's1',
          permissionId: 'perm1',
          title: 'Run bash?',
        }),
      );
      expect(state.pendingPermission?.permissionId).toBe('perm1');
    });
    state.set(null);
  });
});

describe('ThreadState lifecycle', () => {
  it('bind() loads history; clear() resets and forgets the session', async () => {
    const state = makeThread(
      threadStub({
        history: () =>
          Effect.succeed([
            { id: 'u1', role: 'user', status: 'complete', parts: [{ _tag: 'Text', text: 'hi' }] },
          ]),
      }),
    );
    state.bind('ses-old');
    await vi.waitFor(() => {
      expect(state.sessionId).toBe('ses-old');
      expect(state.messages).toHaveLength(1);
    });
    state.clear();
    expect(state.messages).toHaveLength(0);
    expect(state.sessionId).toBeUndefined();
    state.set(null);
  });

  it('rehydrate() tolerates a stale session (keeps a fresh empty chat)', async () => {
    const state = makeThread(
      threadStub({
        history: () => Effect.fail(new NetworkError({ url: '/api/chat/history', cause: 'gone' })),
      }),
    );
    state.sessionId = 'ses-stale';
    await state.rehydrate();
    expect(state.messages).toHaveLength(0); // no crash, no note
    state.set(null);
  });
});

// PubSub.publish returns Effect<boolean>; small helper keeps the tests terse.
function PubSubPublish(pubsub: PubSub.PubSub<ThreadEventT>, event: ThreadEventT) {
  return PS.publish(pubsub, event);
}
