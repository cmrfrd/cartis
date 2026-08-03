import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput, tick } from '../../test/util';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import { ChatThread, type ChatThreadShape } from '../chat/ChatThread';
import type { ChatTurnRequestT, ChatTurnResponseT } from '../contracts/api';
import { ChatRequestError, StoreError } from '../contracts/errors';
import { type GenerationInput, ImageProvider } from '../images/ImageProvider';
import type { StoredCard } from '../storage/CardArchive';
import { StoreClient } from '../storage/StoreClient';
import { BuilderView } from './BuilderView';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** A ChatThread fake — turn defaults to a canned reply; the rest are inert. */
const chatStub = (over: Partial<ChatThreadShape> = {}): Layer.Layer<ChatThread> =>
  Layer.succeed(ChatThread, {
    turn: () =>
      Effect.succeed({
        sessionId: 's1',
        assistantText: '{"reply":"ok"}',
        patch: {},
      } satisfies ChatTurnResponseT),
    history: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'x' })),
    fork: () => Effect.succeed('fork-1'),
    replyPermission: () => Effect.void,
    ...over,
  });

describe('BuilderView', () => {
  it('renders the arcane form from its schema with defaults applied', async () => {
    const { container, unmount } = await mountApp();
    const text = container.textContent ?? '';
    for (const label of [
      'Name',
      'Essence',
      'Cost',
      'Portrait',
      'Type line',
      'Ability',
      'Flavor text',
      'Might',
      'Ward',
      'Rarity',
    ]) {
      expect(text).toContain(label);
    }
    // Preview shows the default card
    expect(text).toContain('Nyra, Ember Sage');
    unmount();
  });

  it('live-updates the preview as the name field is typed', async () => {
    const { container, unmount } = await mountApp();
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Zara the Bold');
    // input value is not textContent, so this asserts the *preview* re-rendered
    expect(container.textContent).toContain('Zara the Bold');
    unmount();
  });

  it('toggles holo foil on the preview', async () => {
    const { container, unmount } = await mountApp();
    // Scope to the visible pane — hidden panes keep their own state mounted.
    const visiblePane = () => container.querySelector('main > div:not(.hidden)');
    expect(visiblePane()?.querySelector('[data-holo="true"]')).toBeNull();
    const holoButton = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Holo'),
    );
    await click(holoButton ?? null);
    expect(visiblePane()?.querySelector('[data-holo="true"]')).not.toBeNull();
    unmount();
  });

  it('flips the preview to the shared card back', async () => {
    const { container, unmount } = await mountApp();
    const flip = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Show back',
    );
    await click(flip ?? null);
    expect(container.querySelector('[data-testid="card-back"]')).not.toBeNull();
    const flipBack = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Show front',
    );
    await click(flipBack ?? null);
    expect(container.querySelector('[data-testid="card-back"]')).toBeNull();
    unmount();
  });

  it('toggling stats off hides the badge and nests might/ward inside the section', async () => {
    const { container, unmount } = await mountApp();
    const visiblePane = () => container.querySelector('main > div:not(.hidden)');
    const numberInputs = () => container.querySelectorAll('aside input[type="number"]');
    const section = () => container.querySelector('[data-testid="toggle-section"]');
    expect(section()).not.toBeNull();
    expect(section()?.querySelectorAll('input[type="number"]')).toHaveLength(2); // might + ward
    expect(visiblePane()?.querySelector('[data-testid="stat-badge"]')).not.toBeNull();
    expect(numberInputs()).toHaveLength(3); // cost + might + ward
    await click(container.querySelector('aside [role="switch"]'));
    expect(visiblePane()?.querySelector('[data-testid="stat-badge"]')).toBeNull();
    expect(numberInputs()).toHaveLength(1); // cost only
    await click(container.querySelector('aside [role="switch"]'));
    expect(visiblePane()?.querySelector('[data-testid="stat-badge"]')).not.toBeNull();
    expect(numberInputs()).toHaveLength(3);
    unmount();
  });

  it('saves the current card into the archive', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => {
      expect(shell.archive.ready).toBe(true);
    });
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => {
      expect(shell.archive.cards).toHaveLength(1);
    });
    expect(shell.archive.cards[0]?.name).toBe('Nyra, Ember Sage');
    expect(shell.archive.cards[0]?.themeId).toBe('arcane');
    expect(shell.archive.cards[0]?.layoutId).toBe('classic');
    await tick();
    expect(container.textContent).toContain('Saved');
    unmount();
  });

  it('preserves overlapping field values and user data across a layout switch', () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Custom Hero');
    builder.setField('ability', 'Draw two cards.');
    builder.pickLayout('fullart');
    expect(builder.layoutId).toBe('fullart');
    expect(builder.data.name).toBe('Custom Hero'); // shared key preserved
    expect(builder.data.ability).toBe('Draw two cards.');
    builder.set(null);
  });

  it('seeds defaults only for a fresh card, not when switching layouts with edits', () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Edited');
    builder.pickLayout('fullart');
    expect(builder.data.name).toBe('Edited'); // NOT reset to the fullart default
    builder.set(null);
  });

  it('applies a chat turn patch and leaves other fields intact', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({
              sessionId: 'ses-1',
              assistantText: '{"reply":"Renamed him.","patch":{"name":"Vorak"}}',
              patch: { name: 'Vorak' },
            }),
        }),
      }),
    );
    const builder = BuilderView.new();
    builder.setField('ability', 'Draw a card.');
    await builder.thread.send('rename him');
    expect(builder.data.name).toBe('Vorak');
    expect(builder.data.ability).toBe('Draw a card.'); // untouched
    expect(builder.thread.sessionId).toBe('ses-1');
    expect(builder.dirty).toBe(true);
    builder.set(null);
  });

  it('sends the CURRENT data + session on later turns so hand edits survive', async () => {
    const seen: ChatTurnRequestT[] = [];
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: (req) => {
            seen.push(req);
            return Effect.succeed({ sessionId: 's1', assistantText: '{"reply":"ok"}', patch: {} });
          },
        }),
      }),
    );
    const builder = BuilderView.new();
    await builder.thread.send('first turn');
    builder.setField('ability', 'Hand edit wins.');
    await builder.thread.send('second turn');
    expect(seen[0]?.sessionId).toBeUndefined(); // first turn creates the session
    expect(seen[1]?.sessionId).toBe('s1'); // later turns reuse it
    expect(seen[1]?.currentData.ability).toBe('Hand edit wins.');
    builder.set(null);
  });

  it('keeps the chat session across theme/layout switches, resets on new card', async () => {
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({ sessionId: 's1', assistantText: '{"reply":"ok"}', patch: {} }),
        }),
      }),
    );
    const builder = BuilderView.new();
    await builder.thread.send('start');
    expect(builder.thread.sessionId).toBe('s1');
    builder.pickLayout('fullart');
    expect(builder.thread.sessionId).toBe('s1'); // same card — chat persists
    builder.pickTheme('arcane');
    expect(builder.thread.sessionId).toBe('s1'); // same card — chat persists
    builder.newCard();
    expect(builder.thread.sessionId).toBeUndefined(); // new card — fresh chat
    builder.set(null);
  });

  it('runs art generation when a chat turn returns an artAction', async () => {
    const generate = vi.fn((input: GenerationInput) => {
      expect(input.brief).toBe('a phoenix companion');
      expect(input.themeContext?.lookAndFeel.toLowerCase()).toContain('oil');
      // no current art on a fresh card → edit request downgrades to fresh generation
      expect(input.editCurrentArt).toBe(false);
      return Effect.succeed({ bytes: bytesOf('art'), type: 'image/png', via: 'stub' as const });
    });
    setAppLayer(
      testAppLayerWith({
        thread: chatStub({
          turn: () =>
            Effect.succeed({
              sessionId: 's1',
              assistantText:
                '{"reply":"Making art.","patch":{"name":"Vorak"},"artAction":{"brief":"a phoenix companion","editCurrentArt":true}}',
              patch: { name: 'Vorak' },
              artAction: { brief: 'a phoenix companion', editCurrentArt: true },
            }),
        }),
        image: Layer.succeed(ImageProvider, ImageProvider.of({ generate })),
      }),
    );
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.library.ready).toBe(true));
    // Drive a turn through the mounted composer.
    const textarea = document.querySelector('textarea[placeholder="Message the assistant…"]');
    await setInput(textarea, 'make him a phoenix mage');
    await click(document.querySelector('[data-testid="composer-send"]'));
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledOnce();
      expect(shell.library.images).toHaveLength(1);
    });
    unmount();
  });
});

describe('document lifecycle (headless)', () => {
  const makeCard = (overrides: Partial<StoredCard> = {}): StoredCard => ({
    id: 'card-1',
    name: 'Stored Hero',
    themeId: 'arcane',
    layoutId: 'classic',
    data: { name: 'Stored Hero', essence: 'tide' },
    holo: false,
    updatedAt: 1,
    ...overrides,
  });

  it('tracks dirty across every mutating action and clears it on load/new', () => {
    const builder = BuilderView.new();
    expect(builder.dirty).toBe(false);
    builder.setField('name', 'X');
    expect(builder.dirty).toBe(true);
    builder.loadCard(makeCard());
    expect(builder.dirty).toBe(false);
    builder.pickLayout('fullart');
    expect(builder.dirty).toBe(true);
    builder.newCard();
    expect(builder.dirty).toBe(false);
    builder.toggleHolo();
    expect(builder.dirty).toBe(true);
    builder.newCard();
    builder.pickTheme('arcane');
    expect(builder.dirty).toBe(true);
    builder.set(null);
  });

  it('pickTheme edits the same document: keeps savedId, preserves overlap, keeps chat session', () => {
    const builder = BuilderView.new();
    builder.loadCard(makeCard({ data: { name: 'Keeper', essence: 'tide' } }));
    builder.thread.sessionId = 's1';
    builder.pickTheme('arcane');
    expect(builder.savedId).toBe('card-1'); // identity kept
    expect(builder.data.name).toBe('Keeper'); // overlapping key preserved
    expect(builder.dirty).toBe(true);
    expect(builder.thread.sessionId).toBe('s1'); // chat is per-card — survives the theme switch
    builder.set(null);
  });

  it('newCard seeds current theme+layout defaults and clears the document + chat', () => {
    const builder = BuilderView.new();
    builder.loadCard(makeCard());
    builder.pickLayout('fullart');
    builder.thread.sessionId = 's1';
    builder.newCard();
    expect(builder.savedId).toBeUndefined();
    expect(builder.dirty).toBe(false);
    expect(builder.thread.sessionId).toBeUndefined(); // fresh card → fresh chat
    expect(builder.layoutId).toBe('fullart'); // stays in the current context
    expect(builder.data.name).toBe('Nyra, Unbound'); // fullart defaults
    builder.set(null);
  });

  it('requestNew executes immediately when clean, guards when dirty', () => {
    const builder = BuilderView.new();
    builder.requestNew();
    expect(builder.pendingIntent).toBeUndefined(); // clean -> executed
    builder.setField('name', 'Dirty');
    builder.requestNew();
    expect(builder.pendingIntent).toEqual({ kind: 'new' });
    expect(builder.data.name).toBe('Dirty'); // nothing executed yet
    builder.set(null);
  });

  it('resolveIntent: cancel keeps the document; discard executes without saving', async () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Dirty');
    builder.requestOpen(makeCard());
    await builder.resolveIntent('cancel');
    expect(builder.pendingIntent).toBeUndefined();
    expect(builder.data.name).toBe('Dirty');
    builder.requestOpen(makeCard());
    await builder.resolveIntent('discard');
    expect(builder.data.name).toBe('Stored Hero'); // opened
    expect(builder.dirty).toBe(false);
    builder.set(null);
  });

  it('resolveIntent save-first with a failed save cancels the intent and keeps the document', async () => {
    // Headless BuilderView has no shell -> saveCard fails with 'Storage unavailable.'
    const b = BuilderView.new();
    b.setField('name', 'To Persist');
    b.requestNew();
    await b.resolveIntent('save-first');
    expect(b.savedNote).toBe('Storage unavailable.');
    expect(b.pendingIntent).toBeUndefined(); // intent cancelled, not left dangling
    expect(b.data.name).toBe('To Persist'); // document kept on failed save
    expect(b.dirty).toBe(true);
    b.set(null);
  });
  // (The success path of save-first is a mounted test in the document-bar describe.)

  it('saveCard catches a failing store into savedNote (no unhandled rejection)', async () => {
    const failingStore: Layer.Layer<StoreClient> = Layer.succeed(
      StoreClient,
      StoreClient.of({
        list: () => Effect.succeed([]),
        put: () => Effect.fail(new StoreError({ op: 'put', status: 500, detail: 'disk full' })),
        remove: () => Effect.void,
        fileUrl: () => undefined,
      }),
    );
    setAppLayer(testAppLayerWith({ store: failingStore }));
    const { shell, container, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Doomed');
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('disk full');
    });
    unmount();
  });
});

describe('document bar (mounted)', () => {
  it('shows title, dirty status, and executes a guarded New through the confirm', async () => {
    const { container, unmount } = await mountApp();
    expect(container.textContent).toContain('Nyra, Ember Sage'); // title from defaults
    expect(container.textContent).not.toContain('Unsaved changes');
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Working Title');
    expect(container.textContent).toContain('Unsaved changes');
    const newButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'New',
    );
    await click(newButton ?? null);
    expect(container.textContent).toContain('Unsaved changes on \u201cWorking Title\u201d');
    const discard = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discard',
    );
    await click(discard ?? null);
    expect(container.textContent).not.toContain('Working Title');
    expect(container.textContent).toContain('Nyra, Ember Sage'); // fresh defaults
    unmount();
  });

  it('guards a gallery open at consume time; Cancel keeps the current card', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const stored = await shell.archive.saveCard({
      name: 'From Gallery',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'From Gallery' },
      holo: false,
    });
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Precious Edits');
    shell.pendingCard = stored; // what GalleryView.openCard does
    await tick();
    expect(container.textContent).toContain('Unsaved changes on \u201cPrecious Edits\u201d');
    expect(shell.pendingCard).toBeUndefined(); // held by the guard, not left dangling
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    );
    await click(cancel ?? null);
    expect(container.textContent).toContain('Precious Edits'); // kept
    expect(container.textContent).not.toContain('Unsaved changes on');
    unmount();
  });

  it('Save first persists the edits, then opens the pending card', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const stored = await shell.archive.saveCard({
      name: 'Target',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Target' },
      holo: false,
    });
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Keep Me');
    shell.pendingCard = stored;
    await tick();
    const saveFirst = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save first',
    );
    await click(saveFirst ?? null);
    await vi.waitFor(() => {
      expect(shell.archive.cards.some((c) => c.name === 'Keep Me')).toBe(true); // persisted
      expect(container.textContent).toContain('Target'); // then opened
    });
    unmount();
  });

  it('Save as copy rebinds the document to a fresh record', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(1));
    const firstId = shell.archive.cards[0]?.id;
    const copyButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save as copy',
    );
    await click(copyButton ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(2));
    const copy = shell.archive.cards.find((c) => c.id !== firstId);
    expect(copy?.name).toBe('Nyra, Ember Sage copy');
    expect(container.textContent).toContain('Nyra, Ember Sage copy'); // rebound title
    unmount();
  });

  it('renames a saved card through the document bar title input', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(1));
    // The first text input in the form aside is the document-bar title.
    const titleInput = container.querySelector('aside input[type="text"]');
    await setInput(titleInput, 'Renamed Hero');
    expect(container.textContent).toContain('● Unsaved changes');
    await click(saveButton ?? null);
    await vi.waitFor(() => {
      expect(shell.archive.cards[0]?.name).toBe('Renamed Hero');
      expect(shell.archive.cards[0]?.data.name).toBe('Renamed Hero');
    });
    unmount();
  });
});
