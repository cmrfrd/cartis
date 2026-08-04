import { Effect, Layer, PubSub as PS, type PubSub } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '@/app/runtime';
import type { ChatTurnResponseT } from '@/contracts/api';
import { ChatRequestError, NetworkError } from '@/contracts/errors';
import { MessageId, SessionId } from '@/contracts/ids';
import type { ThreadEventT } from '@/contracts/thread';
import { type ChatEvents, chatEventsFromPubSub } from './ChatEvents';
import { ChatThread, type ChatThreadShape } from './ChatThread';
import { type ChatContext, ThreadState } from './ThreadState';

/** A canned v2 turn response ({ reply, toolCalls, entry ids } — spec §3.2). */
const resp = (over: Partial<ChatTurnResponseT> = {}): ChatTurnResponseT => ({
  sessionId: SessionId.make('ses-1'),
  reply: 'ok',
  toolCalls: [],
  userEntryId: MessageId.make('ue-1'),
  assistantEntryId: MessageId.make('ae-1'),
  ...over,
});

/** A ChatThread fake — turn defaults to a canned reply; ops are inert. */
const threadStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () => Effect.succeed(resp()),
    edit: () => Effect.succeed(resp()),
    regenerate: () => Effect.succeed(resp({ reply: 'again' })),
    history: () => Effect.succeed([]),
    tree: () => Effect.succeed([]),
    switch: () => Effect.void,
    cancel: () => Effect.void,
    ...over,
  });

const contextOf = (over: Partial<ChatContext> = {}): ChatContext => ({
  themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
  fields: [{ kind: 'text', key: 'name', label: 'Name' }],
  currentData: { name: 'Nyra' },
  applyPatch: () => {},
  runArt: () => {},
  markDirty: () => {},
  save: () => Promise.resolve(true),
  saveAsCopy: () => Promise.resolve(true),
  exportRender: () => Promise.resolve(true),
  setLayout: () => true,
  setTheme: () => true,
  setHolo: () => true,
  snapshotPreview: () => Promise.resolve(undefined),
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
  it('appends a user bubble, renders the structured reply, and clears running', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              sessionId: SessionId.make('ses-9'),
              reply: 'Renamed him.',
              toolCalls: [{ name: 'card_patch', args: { name: 'Vorak' } }],
            }),
          ),
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

  it('RE-KEYS the optimistic bubbles to the returned pi entry ids (spec §3.2)', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              userEntryId: MessageId.make('pi-user'),
              assistantEntryId: MessageId.make('pi-assistant'),
            }),
          ),
      }),
    );
    await state.send('hello');
    expect(state.messages.map((m) => m.id)).toEqual(['pi-user', 'pi-assistant']);
    state.set(null);
  });

  it('applies the card_patch intent and runs card_generate_art via the context', async () => {
    const applied: unknown[] = [];
    const arts: unknown[] = [];
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              reply: 'done',
              toolCalls: [
                { name: 'card_patch', args: { name: 'Q' } },
                { name: 'card_generate_art', args: { brief: 'b', editCurrentArt: true } },
              ],
            }),
          ),
      }),
      undefined,
      contextOf({
        applyPatch: (p) => applied.push(p),
        runArt: (a) => {
          arts.push(a);
        },
      }),
    );
    await state.send('make art');
    expect(applied).toEqual([{ name: 'Q' }]);
    await vi.waitFor(() => expect(arts).toEqual([{ brief: 'b', editCurrentArt: true }]));
    state.set(null);
  });

  it('surfaces validation toolErrors as a note (turn still lands)', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              reply: 'partially done',
              toolErrors: [{ name: 'card_patch', message: 'cost out of range' }],
            }),
          ),
      }),
    );
    await state.send('set cost to 999');
    expect(state.note).toBe('some tool calls failed validation: card_patch');
    expect(state.messages[1]?.status).toBe('complete');
    state.set(null);
  });

  it('finalizes a failed turn as incomplete with an error strip (no toast)', async () => {
    const state = makeThread(
      threadStub({
        turn: () => Effect.fail(new ChatRequestError({ status: 503, detail: 'agent down' })),
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
          return Effect.succeed(resp()).pipe(Effect.delay('50 millis'));
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

describe('ThreadState attachments', () => {
  it('gates files: accepted lands with inferred mime + data-URL, rejected sets note', async () => {
    const state = makeThread(threadStub());
    await state.addAttachments([
      new File(['# hi'], 'notes.md'), // empty mime → inferred text/markdown
      new File(['x'], 'art.psd'), // unsupported → note, skipped
    ]);
    expect(state.pendingAttachments).toHaveLength(1);
    const att = state.pendingAttachments[0];
    expect(att?.name).toBe('notes.md');
    expect(att?.mime).toBe('text/markdown');
    expect(att?.dataUrl.startsWith('data:')).toBe(true);
    expect(state.note).toBe('unsupported attachment type: art.psd');
    state.set(null);
  });

  it('caps at 6 attachments per message', async () => {
    const state = makeThread(threadStub());
    const files = Array.from(
      { length: 7 },
      (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }),
    );
    await state.addAttachments(files);
    expect(state.pendingAttachments).toHaveLength(6);
    expect(state.note).toBe('too many attachments (max 6)');
    state.set(null);
  });

  it('removeAttachment drops by index; clear() empties', async () => {
    const state = makeThread(threadStub());
    await state.addAttachments([new File(['a'], 'a.txt', { type: 'text/plain' })]);
    state.removeAttachment(0);
    expect(state.pendingAttachments).toHaveLength(0);
    await state.addAttachments([new File(['b'], 'b.txt', { type: 'text/plain' })]);
    state.clear();
    expect(state.pendingAttachments).toHaveLength(0);
    state.set(null);
  });

  it('attachment-only submit sends: request carries attachments, bubble has parts but no empty text', async () => {
    const seen: unknown[] = [];
    const state = makeThread(
      threadStub({
        turn: (req) => {
          seen.push(req);
          return Effect.succeed(resp({ reply: 'got it' }));
        },
      }),
    );
    await state.addAttachments([new File(['png'], 'ref.png', { type: 'image/png' })]);
    state.submitDraft(); // empty draft + one attachment → sends
    await vi.waitFor(() => expect(state.running).toBe(false));
    const req = seen[0] as { attachments?: readonly unknown[]; userPrompt: string };
    expect(req.attachments).toHaveLength(1);
    expect(req.userPrompt).toBe('');
    const user = state.messages[0];
    expect(user?.parts.map((p) => p._tag)).toEqual(['Image']); // thumb, no empty Text
    expect(state.pendingAttachments).toHaveLength(0); // cleared on submit
    state.set(null);
  });

  it('text + file attachment: File chip part precedes the text bubble part', async () => {
    const state = makeThread(threadStub());
    await state.addAttachments([new File(['x'], 'lore.txt', { type: 'text/plain' })]);
    state.draft = 'use this lore';
    state.submitDraft();
    await vi.waitFor(() => expect(state.running).toBe(false));
    const user = state.messages[0];
    expect(user?.parts.map((p) => p._tag)).toEqual(['File', 'Text']);
    state.set(null);
  });
});

describe('ThreadState tool intents', () => {
  it('runs save/export intents in order AFTER the art run, through the context appliers', async () => {
    const order: string[] = [];
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              reply: 'done',
              toolCalls: [
                { name: 'card_generate_art', args: { brief: 'b', editCurrentArt: false } },
                { name: 'card_save', args: {} },
                { name: 'card_export', args: { target: 'print' } },
              ],
            }),
          ),
      }),
      undefined,
      contextOf({
        runArt: async () => {
          await new Promise((r) => setTimeout(r, 10)); // art is slow — actions must wait
          order.push('art');
        },
        save: async () => {
          order.push('save');
          return true;
        },
        exportRender: async (target) => {
          order.push(`export:${target}`);
          return true;
        },
      }),
    );
    await state.send('generate art, save it, export a print png');
    await vi.waitFor(() => expect(order).toEqual(['art', 'save', 'export:print']));
    expect(state.note).toBeUndefined();
    state.set(null);
  });

  it('settings knobs apply SYNCHRONOUSLY before art; save waits behind art', async () => {
    const order: string[] = [];
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              reply: 'ok',
              toolCalls: [
                { name: 'card_set_layout', args: { layoutId: 'fullart' } },
                { name: 'card_generate_art', args: { brief: 'b', editCurrentArt: false } },
                { name: 'card_save', args: {} },
              ],
            }),
          ),
      }),
      undefined,
      contextOf({
        setLayout: (id) => {
          order.push(`layout:${id}`);
          return true;
        },
        runArt: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push('art');
        },
        save: async () => {
          order.push('save');
          return true;
        },
      }),
    );
    await state.send('go fullart, generate art, save');
    // the knob applied before the (slow) art run even started resolving
    expect(order[0]).toBe('layout:fullart');
    await vi.waitFor(() => expect(order).toEqual(['layout:fullart', 'art', 'save']));
    state.set(null);
  });

  it('card_save_copy routes to saveAsCopy', async () => {
    let copied = false;
    const state = makeThread(
      threadStub({
        turn: () => Effect.succeed(resp({ toolCalls: [{ name: 'card_save_copy', args: {} }] })),
      }),
      undefined,
      contextOf({
        saveAsCopy: async () => {
          copied = true;
          return true;
        },
      }),
    );
    await state.send('save a copy');
    await vi.waitFor(() => expect(copied).toBe(true));
    state.set(null);
  });

  it('a failed knob surfaces as action failed: <tool>', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed(
            resp({
              reply: 'hm',
              toolCalls: [{ name: 'card_set_layout', args: { layoutId: 'nope' } }],
            }),
          ),
      }),
      undefined,
      contextOf({ setLayout: () => false }),
    );
    await state.send('switch to nope');
    expect(state.note).toBe('action failed: card_set_layout');
    state.set(null);
  });

  it('a failed save surfaces in the note strip', async () => {
    const state = makeThread(
      threadStub({
        turn: () => Effect.succeed(resp({ toolCalls: [{ name: 'card_save', args: {} }] })),
      }),
      undefined,
      contextOf({ save: () => Promise.resolve(false) }),
    );
    await state.send('save it');
    await vi.waitFor(() => expect(state.note).toBe('save failed'));
    state.set(null);
  });
});

describe('ThreadState card vision', () => {
  it('the request carries previewDataUrl when the context provides a snapshot', async () => {
    const seen: unknown[] = [];
    const state = makeThread(
      threadStub({
        turn: (req) => {
          seen.push(req);
          return Effect.succeed(resp());
        },
      }),
      undefined,
      contextOf({
        snapshotPreview: () =>
          Promise.resolve({ mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,QQ==' }),
      }),
    );
    await state.send('look at this');
    const req = seen[0] as { previewDataUrl?: string };
    expect(req.previewDataUrl).toBe('data:image/jpeg;base64,QQ==');
    state.set(null);
  });

  it('a failed snapshot degrades to a normal turn (field absent)', async () => {
    const seen: unknown[] = [];
    const state = makeThread(
      threadStub({
        turn: (req) => {
          seen.push(req);
          return Effect.succeed(resp());
        },
      }),
      undefined,
      contextOf({ snapshotPreview: () => Promise.reject(new Error('no canvas')) }),
    );
    await state.send('hi');
    expect((seen[0] as { previewDataUrl?: string }).previewDataUrl).toBeUndefined();
    // and the optimistic bubble appended BEFORE the snapshot resolved
    expect(state.messages[0]?.parts).toEqual([{ _tag: 'Text', text: 'hi' }]);
    state.set(null);
  });
});

describe('ThreadState streaming (SSE fold)', () => {
  it('builds a running assistant message from streamed events', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.sessionId = SessionId.make('s1'); // bound so the session filter passes
    const publish = (e: ThreadEventT) => Effect.runPromise(PubSubPublish(pubsub, e));
    await vi.waitFor(async () => {
      await publish({
        _tag: 'TurnStarted',
        sessionId: SessionId.make('s1'),
        messageId: MessageId.make('m1'),
      });
      expect(state.messages.some((m) => m.id === 'm1')).toBe(true);
    });
    await publish({
      _tag: 'PartDelta',
      sessionId: SessionId.make('s1'),
      messageId: MessageId.make('m1'),
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
    state.sessionId = SessionId.make('s1');
    await Effect.runPromise(
      PubSubPublish(pubsub, {
        _tag: 'TurnStarted',
        sessionId: SessionId.make('other'),
        messageId: MessageId.make('x'),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(state.messages).toHaveLength(0);
    state.set(null);
  });

  it('an IDLE unbound thread drops replayed events (live-caught ghost after reload)', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    // fresh card: no session bound, no turn running — SSE replay must NOT build ghosts
    await Effect.runPromise(
      PubSubPublish(pubsub, {
        _tag: 'TurnStarted',
        sessionId: SessionId.make('old-session'),
        messageId: MessageId.make('m1'),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(state.messages).toHaveLength(0);
    state.set(null);
  });

  it('session-less Art replays are dropped on an idle EMPTY thread (ghost strip)', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    await Effect.runPromise(
      PubSubPublish(pubsub, { _tag: 'Art', phase: 'downloaded', detail: 'output downloaded' }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(state.messages).toHaveLength(0); // no "art generated" ghost
    state.set(null);
  });

  it('an unbound thread WITH a turn running still accepts the first-turn stream', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.running = true; // first turn in flight; session id not yet known
    await vi.waitFor(async () => {
      await Effect.runPromise(
        PubSubPublish(pubsub, {
          _tag: 'TurnStarted',
          sessionId: SessionId.make('brand-new'),
          messageId: MessageId.make('m1'),
        }),
      );
      expect(state.messages.some((m) => m.id === 'm1')).toBe(true);
    });
    state.set(null);
  });

  it('the streamed assistant message is re-keyed + finalized by the turn response', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    // Turn: emit a TurnStarted (as the live bridge does) then resolve.
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.gen(function* () {
            yield* PubSubPublish(pubsub, {
              _tag: 'TurnStarted',
              sessionId: SessionId.make('ses-1'),
              messageId: MessageId.make('stream-tmp'),
            });
            yield* Effect.sleep('20 millis'); // let the stream land first
            return resp({
              reply: 'final reply',
              userEntryId: MessageId.make('pi-u'),
              assistantEntryId: MessageId.make('pi-a'),
            });
          }),
      }),
      chatEventsFromPubSub(pubsub),
    );
    await state.send('hi');
    // ONE assistant message: the streamed one, re-keyed to the pi entry id.
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.id).toBe('pi-a');
    expect(assistants[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'final reply' });
    state.set(null);
  });
});

describe('ThreadState lifecycle', () => {
  it('bind() loads history; clear() resets and forgets the session', async () => {
    const state = makeThread(
      threadStub({
        history: () =>
          Effect.succeed([
            {
              id: MessageId.make('u1'),
              role: 'user',
              status: 'complete',
              parts: [{ _tag: 'Text', text: 'hi' }],
            },
          ]),
      }),
    );
    state.bind(SessionId.make('ses-old'));
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
    state.sessionId = SessionId.make('ses-stale');
    await state.rehydrate();
    expect(state.messages).toHaveLength(0); // no crash, no note
    state.set(null);
  });
});

describe('ThreadState capabilities', () => {
  it('cancel() aborts the session and finalizes the turn incomplete', async () => {
    let aborted = '';
    const state = makeThread(
      threadStub({
        turn: () => Effect.succeed(resp({ reply: 'late' })).pipe(Effect.delay('30 millis')),
        cancel: (sid) => {
          aborted = sid;
          return Effect.void;
        },
      }),
    );
    state.sessionId = SessionId.make('s1');
    const turn = state.send('hi'); // running becomes true synchronously
    await state.cancel();
    await turn;
    expect(aborted).toBe('s1');
    const assistant = state.messages.find((m) => m.role === 'assistant');
    expect(assistant?.status).toBe('incomplete');
    expect(assistant?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'Canceled.' });
    expect(state.running).toBe(false);
    state.set(null);
  });

  it('regenerate() replaces the last assistant reply in place', async () => {
    const state = makeThread(
      threadStub({
        turn: () => Effect.succeed(resp({ reply: 'first' })),
        regenerate: () =>
          Effect.succeed(resp({ reply: 'second', assistantEntryId: MessageId.make('ae-2') })),
      }),
    );
    await state.send('hi');
    expect(state.messages.at(-1)?.parts[0]).toEqual({ _tag: 'Text', text: 'first' });
    await state.regenerate();
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1); // replaced, not appended
    expect(assistants[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'second' });
    expect(assistants[0]?.id).toBe('ae-2'); // re-keyed to the new branch's entry
    state.set(null);
  });

  it('edit() calls the edit route with the target id and lands on the branch', async () => {
    const calls: { target?: string; session?: string } = {};
    const state = makeThread(
      threadStub({
        turn: () => Effect.succeed(resp()),
        edit: (req, targetMessageId) => {
          calls.target = targetMessageId;
          calls.session = req.sessionId;
          return Effect.succeed(
            resp({
              reply: 'edited reply',
              userEntryId: MessageId.make('ue-2'),
              assistantEntryId: MessageId.make('ae-2'),
            }),
          );
        },
      }),
    );
    state.sessionId = SessionId.make('orig');
    await state.send('original'); // seeds a user + assistant
    const userMsg = state.messages.find((m) => m.role === 'user');
    await state.edit(userMsg?.id ?? MessageId.make(''), 'edited text');
    expect(calls.target).toBe(userMsg?.id); // ONE route call with the target
    expect(calls.session).toBe('ses-1'); // same session — a tree branch, not a fork
    // local history: trimmed to the edit point, re-keyed to the new entries
    expect(state.messages.map((m) => m.id)).toEqual(['ue-2', 'ae-2']);
    expect(state.messages[0]?.parts).toEqual([{ _tag: 'Text', text: 'edited text' }]);
    expect(state.messages[1]?.parts[0]).toEqual({ _tag: 'Text', text: 'edited reply' });
    state.set(null);
  });

  it('loadTree() adopts the server-computed anchors', async () => {
    const state = makeThread(
      threadStub({
        tree: () =>
          Effect.succeed([
            {
              messageId: MessageId.make('u2'),
              index: 2,
              count: 2,
              siblingLeafIds: ['leaf-1', 'leaf-2'],
            },
          ]),
      }),
    );
    state.sessionId = SessionId.make('s1');
    await state.loadTree();
    expect(state.anchors).toEqual([
      { messageId: 'u2', index: 2, count: 2, siblingLeafIds: ['leaf-1', 'leaf-2'] },
    ]);
    state.set(null);
  });

  it('loadTree() without a session clears the anchors (no arrows)', async () => {
    const state = makeThread(threadStub());
    state.anchors = [
      { messageId: MessageId.make('x'), index: 1, count: 2, siblingLeafIds: ['a', 'b'] },
    ];
    await state.loadTree();
    expect(state.anchors).toEqual([]);
    state.set(null);
  });

  it('switchTo() switches durably, rehydrates, and marks the document dirty', async () => {
    let switched = '';
    let dirtied = false;
    const state = makeThread(
      threadStub({
        switch: (_sid, leafId) => {
          switched = leafId;
          return Effect.void;
        },
        history: () =>
          Effect.succeed([
            {
              id: MessageId.make('h1'),
              role: 'user',
              status: 'complete',
              parts: [{ _tag: 'Text', text: 'from the other branch' }],
            },
          ]),
      }),
      undefined,
      contextOf({
        markDirty: () => {
          dirtied = true;
        },
      }),
    );
    state.sessionId = SessionId.make('s1');
    await state.switchTo('leaf-1');
    expect(switched).toBe('leaf-1');
    expect(dirtied).toBe(true);
    await vi.waitFor(() => {
      expect(state.messages[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'from the other branch' });
    });
    state.set(null);
  });

  it('switchSibling() steps prev/next through the anchor leaf ids', async () => {
    const switched: string[] = [];
    const state = makeThread(
      threadStub({
        switch: (_sid, leafId) => {
          switched.push(leafId);
          return Effect.void;
        },
        history: () => Effect.succeed([]),
      }),
    );
    state.sessionId = SessionId.make('s1');
    const anchor = {
      messageId: MessageId.make('u2'),
      index: 2,
      count: 2,
      siblingLeafIds: ['leaf-1', 'leaf-2'],
    };
    await state.switchSibling(anchor, -1);
    expect(switched).toEqual(['leaf-1']);
    await state.switchSibling({ ...anchor, index: 1 }, -1); // already first → no move
    expect(switched).toEqual(['leaf-1']);
    state.set(null);
  });
});

// PubSub.publish returns Effect<boolean>; small helper keeps the tests terse.
function PubSubPublish(pubsub: PubSub.PubSub<ThreadEventT>, event: ThreadEventT) {
  return PS.publish(pubsub, event);
}
