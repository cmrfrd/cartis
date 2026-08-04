import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '@/app/runtime';
import type { ChatTurnResponseT } from '@/contracts/api';
import { ChatRequestError } from '@/contracts/errors';
import { MessageId, SessionId } from '@/contracts/ids';
import { click, mountApp, setInput, tick } from '../../test/util';
import { ChatThread, type ChatThreadShape } from './ChatThread';

/** A canned v2 turn response ({ reply, toolCalls, entry ids } — spec §3.2). */
const resp = (over: Partial<ChatTurnResponseT> = {}): ChatTurnResponseT => ({
  sessionId: SessionId.make('s1'),
  reply: 'ok',
  toolCalls: [],
  userEntryId: MessageId.make('ue-1'),
  assistantEntryId: MessageId.make('ae-1'),
  ...over,
});

const chatStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () => Effect.succeed(resp()),
    edit: () => Effect.succeed(resp()),
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'x' })),
    history: () => Effect.succeed([]),
    tree: () => Effect.succeed([]),
    switch: () => Effect.void,
    cancel: () => Effect.void,
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
            Effect.succeed(
              resp({
                reply: 'Renamed him to Vorak.',
                toolCalls: [{ name: 'card_patch', args: { name: 'Vorak' } }],
              }),
            ),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'rename him');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('rename him'); // user bubble
      expect(document.body.textContent).toContain('Renamed him to Vorak.'); // structured reply
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
          turn: () => Effect.succeed(resp()).pipe(Effect.delay('400 millis')),
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
          turn: () => Effect.fail(new ChatRequestError({ status: 503, detail: 'agent down' })),
        }),
      }),
    );
    const { unmount } = await mountApp();
    await setInput(composer(), 'hi');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('agent down');
    });
    unmount();
  });

  it('regenerate replaces the assistant reply through the action bar', async () => {
    let regen = 0;
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () => Effect.succeed(resp({ reply: 'first answer' })),
          regenerate: () => {
            regen += 1;
            return Effect.succeed(
              resp({ reply: 'second answer', assistantEntryId: MessageId.make('ae-2') }),
            );
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

  it('edit creates a sibling branch and reveals ‹ n/m › arrows from the tree anchors', async () => {
    let edits = 0;
    let switchedTo = '';
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () => Effect.succeed(resp({ reply: 'answer' })),
          edit: (_req, targetMessageId) => {
            edits += 1;
            expect(targetMessageId).toBe('ue-1'); // the re-keyed user entry id
            return Effect.succeed(
              resp({
                reply: 'edited answer',
                userEntryId: MessageId.make('ue-2'),
                assistantEntryId: MessageId.make('ae-2'),
              }),
            );
          },
          tree: () =>
            Effect.succeed(
              edits > 0
                ? [
                    {
                      messageId: MessageId.make('ue-2'),
                      index: 2,
                      count: 2,
                      siblingLeafIds: ['leaf-orig', 'leaf-edit'],
                    },
                  ]
                : [],
            ),
          switch: (_sid, leafId) => {
            switchedTo = leafId;
            return Effect.void;
          },
          history: () =>
            Effect.succeed(
              switchedTo === 'leaf-orig'
                ? [
                    {
                      id: MessageId.make('ue-1'),
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
      expect(edits).toBe(1); // ONE route call — no fork/revert dance
      expect(document.body.textContent).toContain('edited message'); // new branch's user text
      // the edit is the 2nd of 2 siblings; arrows anchor its user message
      expect(document.querySelector('[data-testid="branch-next"]')).not.toBeNull();
      expect(document.body.textContent).toContain('2/2');
    });
    // stepping back switches durably and rehydrates the original branch
    await click(document.querySelector('[data-testid="branch-prev"]'));
    await vi.waitFor(() => {
      expect(switchedTo).toBe('leaf-orig');
      expect(document.body.textContent).toContain('first message');
    });
    unmount();
  });

  it('renders doc-action chips and runs save through the builder (agent parity)', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed(
              resp({
                reply: 'Saved it.',
                toolCalls: [
                  { name: 'card_save', args: {} },
                  { name: 'card_export', args: { target: 'print' } },
                ],
              }),
            ),
        }),
      }),
    );
    const { unmount, shell } = await mountApp();
    await setInput(composer(), 'save it and export a print png');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      const chips = document.querySelectorAll('[data-testid="tool-doc-action"]');
      expect(chips).toHaveLength(2);
      expect(chips[0]?.textContent).toContain('Save card');
      expect(chips[1]?.textContent).toContain('export print');
    });
    // the save actually persisted through the archive (agent = user parity)
    await vi.waitFor(() => {
      expect(shell.archive.cards.length).toBeGreaterThan(0);
    });
    unmount();
  });

  it('renders assistant text as markdown (user text stays plain)', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () => Effect.succeed(resp({ reply: 'a **bold** move' })),
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
            return Effect.succeed(
              resp({
                reply: `answer ${String(n)}`,
                userEntryId: MessageId.make(`ue-${String(n)}`),
                assistantEntryId: MessageId.make(`ae-${String(n)}`),
              }),
            );
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
});
