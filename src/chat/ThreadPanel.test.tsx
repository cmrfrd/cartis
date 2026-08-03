import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput } from '../../test/util';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import type { ChatTurnResponseT } from '../contracts/api';
import { AgentFillError } from '../contracts/errors';
import { ChatThread, type ChatThreadShape } from './ChatThread';

const chatStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () =>
      Effect.succeed({
        sessionId: 's1',
        assistantText: '{"reply":"ok"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    history: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new AgentFillError({ status: 0, detail: 'x' })),
    fork: () => Effect.succeed('fork-1'),
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
              sessionId: 's1',
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
            Effect.succeed({ sessionId: 's1', assistantText: '{"reply":"ok"}', patch: {} }).pipe(
              Effect.delay('400 millis'),
            ),
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
          turn: () => Effect.fail(new AgentFillError({ status: 503, detail: 'opencode down' })),
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
});
