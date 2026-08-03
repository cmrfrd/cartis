import { Effect, Layer, PubSub as PS } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput } from '../../test/util';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import type { ChatTurnResponseT } from '../contracts/api';
import { ChatRequestError } from '../contracts/errors';
import { PermissionId, SessionId } from '../contracts/ids';
import type { ThreadEventT } from '../contracts/thread';
import { chatEventsFromPubSub } from './ChatEvents';
import { ChatThread, type ChatThreadShape } from './ChatThread';

const chatStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () =>
      Effect.succeed({
        sessionId: SessionId.make('s1'),
        assistantText: '{"reply":"ok"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    history: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'x' })),
    fork: () => Effect.succeed(SessionId.make('fork-1')),
    replyPermission: () => Effect.void,
    ...over,
  });

const composer = () => document.querySelector('textarea[placeholder="Message the assistant…"]');

describe('ThreadPanel', () => {
  it('shows the empty state and the composer send button by default', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    expect(document.body.textContent).toContain('Ask the assistant');
    expect(document.querySelector('[data-testid="composer-send"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="composer-cancel"]')).toBeNull();
    unmount();
  });

  it('renders the user bubble, the reply text, and a card_patch chip on a turn', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: '{"reply":"Renamed him to Vorak.","patch":{"name":"Vorak"}}',
              patch: { name: 'Vorak' },
            }),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'rename him');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('rename him'); // user bubble
      expect(document.body.textContent).toContain('Renamed him to Vorak.'); // materialized reply
      const chip = document.querySelector('[data-testid="tool-card-patch"]');
      expect(chip?.textContent).toContain('name'); // patched key on the chip
    });
    unmount();
  });

  it('locks the composer and swaps Send→Stop while a turn is running', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          // a slow turn keeps `running` true long enough to observe the swap
          turn: () =>
            Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: '{"reply":"ok"}',
              patch: {},
            }).pipe(Effect.delay('400 millis')),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'hello');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="composer-cancel"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="composer-send"]')).toBeNull();
      expect((composer() as HTMLTextAreaElement | null)?.disabled).toBe(true);
    });
    unmount();
  });

  it('shows an error strip when a turn fails (incomplete message, no toast)', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () => Effect.fail(new ChatRequestError({ status: 503, detail: 'opencode down' })),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'hi');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('opencode down');
    });
    unmount();
  });

  it('regenerate replaces the assistant reply through the action bar', async () => {
    let regen = 0;
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: '{"reply":"first answer"}',
              patch: {},
            }),
          regenerate: () => {
            regen += 1;
            return Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: '{"reply":"second answer"}',
              patch: {},
            });
          },
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'hi');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('first answer'));
    await click(document.querySelector('[data-testid="action-regenerate"]'));
    await vi.waitFor(() => {
      expect(regen).toBe(1);
      expect(document.body.textContent).toContain('second answer');
      expect(document.body.textContent).not.toContain('first answer'); // replaced in place
    });
    unmount();
  });

  it('edit forks + resends and reveals the branch picker', async () => {
    const calls = { fork: 0, revert: 0 };
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: (req) =>
            Effect.succeed({
              sessionId: req.sessionId ?? SessionId.make('fork-1'),
              assistantText: '{"reply":"answer"}',
              patch: {},
            }),
          fork: () => {
            calls.fork += 1;
            return Effect.succeed(SessionId.make('fork-1'));
          },
          revert: () => {
            calls.revert += 1;
            return Effect.void;
          },
          children: () =>
            Effect.succeed([{ sessionId: SessionId.make('orig-a'), title: 'original' }]),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'first message');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('answer'));
    await click(document.querySelector('[data-testid="action-edit"]'));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="edit-box"]')).not.toBeNull(),
    );
    await setInput(document.querySelector('[data-testid="edit-box"] textarea'), 'edited message');
    await click(document.querySelector('[data-testid="edit-submit"]'));
    await vi.waitFor(() => {
      expect(calls.fork).toBe(1);
      expect(calls.revert).toBe(1);
      expect(document.body.textContent).toContain('edited message'); // resent user text
      expect(document.querySelector('[data-testid="branch-picker"]')).not.toBeNull();
    });
    unmount();
  });

  it('surfaces a permission request and answers Allow', async () => {
    const pubsub = await Effect.runPromise(PS.unbounded<ThreadEventT>());
    let replied = false;
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          replyPermission: () => {
            replied = true;
            return Effect.void;
          },
        }),
        threadEvents: chatEventsFromPubSub(pubsub),
      }),
    );
    const { unmount } = await mountApp();
    await vi.waitFor(async () => {
      await Effect.runPromise(
        PS.publish(pubsub, {
          _tag: 'PermissionRequested',
          sessionId: SessionId.make('s1'),
          permissionId: PermissionId.make('p1'),
          title: 'Run bash?',
        }),
      );
      expect(document.querySelector('[data-testid="permission-strip"]')).not.toBeNull();
    });
    await click(document.querySelector('[data-testid="permission-allow"]'));
    await vi.waitFor(() => {
      expect(replied).toBe(true);
      expect(document.querySelector('[data-testid="permission-strip"]')).toBeNull();
    });
    unmount();
  });
});
