import { Effect, Layer, PubSub as PS, type PubSub } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '@/app/runtime';
import type { ChatTurnResponseT } from '@/contracts/api';
import { ChatRequestError, NetworkError } from '@/contracts/errors';
import { MessageId, PermissionId, SessionId } from '@/contracts/ids';
import type { ThreadEventT } from '@/contracts/thread';
import { type ChatEvents, chatEventsFromPubSub } from './ChatEvents';
import { ChatThread, type ChatThreadShape } from './ChatThread';
import { type ChatContext, ThreadState } from './ThreadState';

/** A ChatThread fake — turn defaults to a canned reply; ops are inert. */
const threadStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () =>
      Effect.succeed({
        sessionId: SessionId.make('ses-1'),
        assistantText: '{"reply":"ok"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    history: () => Effect.succeed([]),
    siblings: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () =>
      Effect.succeed({
        sessionId: SessionId.make('ses-1'),
        assistantText: '{"reply":"again"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    fork: () => Effect.succeed(SessionId.make('fork-1')),
    replyPermission: () => Effect.void,
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
            sessionId: SessionId.make('ses-9'),
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
            sessionId: SessionId.make('ses-1'),
            assistantText:
              '{"reply":"done","patch":{"name":"Q"},"artAction":{"brief":"b","editCurrentArt":true}}',
            patch: { name: 'Q' },
            artAction: { brief: 'b', editCurrentArt: true },
          }),
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
    expect(arts).toEqual([{ brief: 'b', editCurrentArt: true }]);
    state.set(null);
  });

  it('finalizes a failed turn as incomplete with an error strip (no toast)', async () => {
    const state = makeThread(
      threadStub({
        turn: () => Effect.fail(new ChatRequestError({ status: 503, detail: 'opencode down' })),
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
            sessionId: SessionId.make('s'),
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
          return Effect.succeed({
            sessionId: SessionId.make('ses-1'),
            assistantText: '{"reply":"got it"}',
            patch: {},
          } satisfies ChatTurnResponseT);
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

describe('ThreadState doc actions', () => {
  it('runs actions in order AFTER the art run, through the context appliers', async () => {
    const order: string[] = [];
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText:
              '{"reply":"done","artAction":{"brief":"b","editCurrentArt":false},"actions":[{"kind":"save"},{"kind":"export","target":"print"}]}',
            patch: {},
            artAction: { brief: 'b', editCurrentArt: false },
            actions: [
              { kind: 'save' as const },
              { kind: 'export' as const, target: 'print' as const },
            ],
          }),
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
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText:
              '{"reply":"ok","artAction":{"brief":"b","editCurrentArt":false},"actions":[{"kind":"setLayout","layoutId":"fullart"},{"kind":"save"}]}',
            patch: {},
            artAction: { brief: 'b', editCurrentArt: false },
            actions: [
              { kind: 'setLayout' as const, layoutId: 'fullart' },
              { kind: 'save' as const },
            ],
          }),
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

  it('a failed knob surfaces as action failed: <kind>', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText: '{"reply":"hm","actions":[{"kind":"setLayout","layoutId":"nope"}]}',
            patch: {},
            actions: [{ kind: 'setLayout' as const, layoutId: 'nope' }],
          }),
      }),
      undefined,
      contextOf({ setLayout: () => false }),
    );
    await state.send('switch to nope');
    expect(state.note).toBe('action failed: setLayout');
    state.set(null);
  });

  it('a failed action surfaces in the note strip', async () => {
    const state = makeThread(
      threadStub({
        turn: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText: '{"reply":"saving","actions":[{"kind":"save"}]}',
            patch: {},
            actions: [{ kind: 'save' as const }],
          }),
      }),
      undefined,
      contextOf({ save: () => Promise.resolve(false) }),
    );
    await state.send('save it');
    await vi.waitFor(() => expect(state.note).toBe('save failed'));
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

  it('records a pending permission from the stream', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    const state = makeThread(threadStub(), chatEventsFromPubSub(pubsub));
    state.sessionId = SessionId.make('s1');
    await vi.waitFor(async () => {
      await Effect.runPromise(
        PubSubPublish(pubsub, {
          _tag: 'PermissionRequested',
          sessionId: SessionId.make('s1'),
          permissionId: PermissionId.make('perm1'),
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
        turn: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText: '{"reply":"late"}',
            patch: {},
          }).pipe(Effect.delay('30 millis')),
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
        turn: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText: '{"reply":"first"}',
            patch: {},
          }),
        regenerate: () =>
          Effect.succeed({
            sessionId: SessionId.make('s1'),
            assistantText: '{"reply":"second"}',
            patch: {},
          }),
      }),
    );
    await state.send('hi');
    expect(state.messages.at(-1)?.parts[0]).toEqual({ _tag: 'Text', text: 'first' });
    await state.regenerate();
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1); // replaced, not appended
    expect(assistants[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'second' });
    state.set(null);
  });

  it('edit() forks the session, reverts to the message, and resends on the branch', async () => {
    const calls: { fork?: string; revert?: [string, string]; turnSession?: string } = {};
    const state = makeThread(
      threadStub({
        turn: (req) => {
          calls.turnSession = req.sessionId;
          return Effect.succeed({
            sessionId: req.sessionId ?? SessionId.make('fork-1'),
            assistantText: '{"reply":"ok"}',
            patch: {},
          });
        },
        fork: (sid) => {
          calls.fork = sid;
          return Effect.succeed(SessionId.make('fork-1'));
        },
        revert: (sid, mid) => {
          calls.revert = [sid, mid];
          return Effect.void;
        },
      }),
    );
    state.sessionId = SessionId.make('orig');
    await state.send('original'); // seeds a user + assistant on 'orig'
    const userMsg = state.messages.find((m) => m.role === 'user');
    await state.edit(userMsg?.id ?? MessageId.make(''), 'edited text');
    expect(calls.fork).toBe('orig'); // forked to preserve the original branch
    expect(state.sessionId).toBe('fork-1');
    expect(calls.revert).toEqual(['fork-1', userMsg?.id]);
    expect(calls.turnSession).toBe('fork-1'); // resend happened on the fork
    state.set(null);
  });

  it('switchBranch() rebinds, rehydrates, and marks the document dirty', async () => {
    let dirtied = false;
    const state = makeThread(
      threadStub({
        history: (sid) =>
          Effect.succeed([
            {
              id: MessageId.make('h1'),
              role: 'user',
              status: 'complete',
              parts: [{ _tag: 'Text', text: `from ${sid}` }],
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
    state.sessionId = SessionId.make('orig');
    await state.switchBranch(SessionId.make('branch-2'));
    expect(state.sessionId).toBe('branch-2');
    expect(dirtied).toBe(true);
    await vi.waitFor(() => {
      expect(state.messages[0]?.parts[0]).toEqual({ _tag: 'Text', text: 'from branch-2' });
    });
    state.set(null);
  });

  it('loadBranches() computes a branchPoint from sibling divergence', async () => {
    const mine = [
      {
        id: MessageId.make('u1'),
        role: 'user' as const,
        status: 'complete' as const,
        parts: [{ _tag: 'Text' as const, text: 'hi' }],
      },
      {
        id: MessageId.make('u2'),
        role: 'user' as const,
        status: 'complete' as const,
        parts: [{ _tag: 'Text' as const, text: 'mine' }],
      },
    ];
    const theirs = [
      mine[0] as (typeof mine)[number],
      {
        id: MessageId.make('x2'),
        role: 'user' as const,
        status: 'complete' as const,
        parts: [{ _tag: 'Text' as const, text: 'theirs' }],
      },
    ];
    const state = makeThread(
      threadStub({
        siblings: () =>
          Effect.succeed([
            { sessionId: SessionId.make('root') }, // parent first (no parentId)
            { sessionId: SessionId.make('fork-1'), parentId: SessionId.make('root') },
          ]),
        history: (sid) => Effect.succeed(sid === 'root' ? theirs : mine),
      }),
    );
    state.sessionId = SessionId.make('fork-1');
    state.messages = mine;
    await state.loadBranches();
    expect(state.siblingIds).toEqual(['root', 'fork-1']);
    expect(state.branchPoint).toEqual({
      messageId: MessageId.make('u2'), // where the fork's history diverges
      index: 2, // fork-1 is the 2nd sibling
      count: 2,
    });
    state.set(null);
  });

  it('loadBranches() with a lone session clears the branchPoint (no arrows)', async () => {
    const state = makeThread(
      threadStub({
        siblings: () => Effect.succeed([{ sessionId: SessionId.make('orig') }]),
      }),
    );
    state.sessionId = SessionId.make('orig');
    await state.loadBranches();
    expect(state.branchPoint).toBeUndefined();
    expect(state.siblingIds).toEqual(['orig']);
    state.set(null);
  });

  it('switchSibling() moves prev/next through the ordered sibling set', async () => {
    const switched: string[] = [];
    const state = makeThread(
      threadStub({
        siblings: () =>
          Effect.succeed([
            { sessionId: SessionId.make('root') },
            { sessionId: SessionId.make('fork-1'), parentId: SessionId.make('root') },
          ]),
        history: () => Effect.succeed([]),
      }),
    );
    state.sessionId = SessionId.make('fork-1');
    state.siblingIds = [SessionId.make('root'), SessionId.make('fork-1')];
    const original = state.switchBranch.bind(state);
    state.switchBranch = async (sid) => {
      switched.push(sid);
      await original(sid);
    };
    await state.switchSibling(-1);
    expect(switched).toEqual(['root']);
    await state.switchSibling(-1); // already at the first sibling → no move
    expect(switched).toEqual(['root']);
    state.set(null);
  });

  it('replyPermission() answers the prompt and clears it', async () => {
    let replied: [string, string, boolean] | undefined;
    const state = makeThread(
      threadStub({
        replyPermission: (s, p, g) => {
          replied = [s, p, g];
          return Effect.void;
        },
      }),
    );
    state.pendingPermission = {
      sessionId: SessionId.make('s1'),
      permissionId: PermissionId.make('perm1'),
      title: 'Run bash?',
    };
    await state.replyPermission(true);
    expect(replied).toEqual(['s1', 'perm1', true]);
    expect(state.pendingPermission).toBeUndefined();
    state.set(null);
  });
});

// PubSub.publish returns Effect<boolean>; small helper keeps the tests terse.
function PubSubPublish(pubsub: PubSub.PubSub<ThreadEventT>, event: ThreadEventT) {
  return PS.publish(pubsub, event);
}
