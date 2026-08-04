import { Effect, Layer, PubSub as PS } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '@/app/runtime';
import type { ChatTurnResponseT } from '@/contracts/api';
import { ChatRequestError } from '@/contracts/errors';
import { MessageId, PermissionId, SessionId } from '@/contracts/ids';
import type { ThreadEventT } from '@/contracts/thread';
import { click, mountApp, setInput, tick } from '../../test/util';
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
    siblings: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'x' })),
    fork: () => Effect.succeed(SessionId.make('fork-1')),
    replyPermission: () => Effect.void,
    ...over,
  });

const composer = () => document.querySelector('textarea[placeholder="Message the assistant…"]');

const attachInput = (): HTMLInputElement => {
  const input = document.querySelector('[data-testid="composer-attach"] input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('attach input not found');
  return input;
};

/** Simulate a file pick through the hidden input (React file onChange = 'change'). */
async function pickFiles(...files: File[]): Promise<void> {
  const input = attachInput();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}

describe('ThreadPanel', () => {
  it('shows the empty state and the composer send button by default', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    expect(document.body.textContent).toContain('What should this card become?');
    expect(document.querySelector('[data-testid="composer-send"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="composer-cancel"]')).toBeNull();
    unmount();
  });

  it('disables Send until there is text or an attachment', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    const send = () =>
      document.querySelector('[data-testid="composer-send"]') as HTMLButtonElement | null;
    expect(send()?.disabled).toBe(true);
    await setInput(composer(), 'hello');
    expect(send()?.disabled).toBe(false);
    unmount();
  });

  it('the + button gates picked files into thumbs; × removes them', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    expect(attachInput().accept).toBe('image/*,text/*,application/json,.md');
    await pickFiles(new File(['x'], 'ref.png', { type: 'image/png' }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="composer-attachment"]')).not.toBeNull();
    });
    // an attachment alone enables Send
    const send = document.querySelector('[data-testid="composer-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await click(document.querySelector('[data-testid="attachment-remove"]'));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="composer-attachment"]')).toBeNull();
    });
    unmount();
  });

  it('a rejected file surfaces the note strip; × dismisses it', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    await pickFiles(new File(['x'], 'art.psd'));
    await vi.waitFor(() => {
      const strip = document.querySelector('[data-testid="note-strip"]');
      expect(strip?.textContent).toContain('unsupported attachment type: art.psd');
    });
    await click(document.querySelector('[data-testid="note-strip"] button'));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="note-strip"]')).toBeNull();
    });
    unmount();
  });

  it('pasting files into the composer attaches them', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    const el = composer();
    if (!el) throw new Error('composer not found');
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', {
      value: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });
    el.dispatchEvent(evt);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="composer-attachment"]')).not.toBeNull();
    });
    unmount();
  });

  it('dropping files on the panel attaches them', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    const panel = document.querySelector('[data-testid="chat-panel"]');
    if (!panel) throw new Error('chat panel not found');
    const evt = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', {
      value: { files: [new File(['x'], 'drop.png', { type: 'image/png' })] },
    });
    panel.dispatchEvent(evt);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="composer-attachment"]')).not.toBeNull();
    });
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

  it('edit forks + resends and reveals ‹ n/m › arrows at the divergence point', async () => {
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
          siblings: () =>
            Effect.succeed([
              { sessionId: SessionId.make('orig-a'), title: 'original' },
              { sessionId: SessionId.make('fork-1'), parentId: SessionId.make('orig-a') },
            ]),
          history: (sid) =>
            Effect.succeed(
              sid === 'orig-a'
                ? [
                    {
                      id: MessageId.make('h1'),
                      role: 'user' as const,
                      status: 'complete' as const,
                      parts: [{ _tag: 'Text' as const, text: 'first message' }],
                    },
                  ]
                : [],
            ),
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
      // the fork is the 2nd of 2 siblings; arrows anchor the divergent message
      expect(document.querySelector('[data-testid="branch-next"]')).not.toBeNull();
      expect(document.body.textContent).toContain('2/2');
    });
    // stepping back rehydrates the original branch
    await click(document.querySelector('[data-testid="branch-prev"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('first message'));
    unmount();
  });

  it('renders assistant text as markdown (user text stays plain)', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: '{"reply":"a **bold** move"}',
              patch: {},
            }),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'use **stars** literally');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      const strong = document.querySelector('.chat-md strong');
      expect(strong?.textContent).toBe('bold');
      // the user bubble shows raw asterisks, not markup
      expect(document.body.textContent).toContain('use **stars** literally');
    });
    unmount();
  });

  it('copy swaps to a copied state; regenerate appears only on the LAST assistant message', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => written.push(t) },
      configurable: true,
    });
    let n = 0;
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () => {
            n += 1;
            return Effect.succeed({
              sessionId: SessionId.make('s1'),
              assistantText: `{"reply":"answer ${String(n)}"}`,
              patch: {},
            });
          },
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'one');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('answer 1'));
    await setInput(composer(), 'two');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => expect(document.body.textContent).toContain('answer 2'));
    // two assistant messages, ONE regenerate control (the last)
    expect(document.querySelectorAll('[data-testid="action-regenerate"]')).toHaveLength(1);
    const copies = document.querySelectorAll('[data-testid="action-copy"]');
    expect(copies.length).toBeGreaterThan(1);
    await click(copies[copies.length - 1] ?? null);
    await vi.waitFor(() => {
      expect(written).toEqual(['answer 2']);
      expect(document.querySelector('[data-testid="action-copy"][title="Copied"]')).not.toBeNull();
    });
    unmount();
  });

  it('the resize handle drags the panel width within [340, 600] and resets on double-click', async () => {
    setAppLayer(testAppLayerWith({ thread: chatStub() }));
    const { unmount } = await mountApp();
    const panel = document.querySelector('[data-testid="chat-panel"]') as HTMLElement;
    const handle = document.querySelector('[data-testid="chat-resize"]');
    if (!handle) throw new Error('resize handle not found');
    expect(panel.style.width).toBe('400px');
    handle.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }),
    );
    handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 420 }));
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await tick();
    expect(panel.style.width).toBe('480px'); // dragged 80px left → wider
    handle.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }),
    );
    handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100 }));
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await tick();
    expect(panel.style.width).toBe('600px'); // clamped at max
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await tick();
    expect(panel.style.width).toBe('400px'); // double-click resets
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
