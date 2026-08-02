import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput, tick } from '../../test/util';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import type { AgentFillRequestT } from '../contracts/api';
import { type GenerationInput, ImageProvider } from '../images/ImageProvider';
import { AgentFill } from './AgentFill';
import { BuilderView } from './BuilderView';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

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
      (b) => b.textContent === 'Save to gallery',
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

  it('merges a targeted fill patch and leaves other fields intact', async () => {
    setAppLayer(
      testAppLayerWith({
        fill: Layer.succeed(
          AgentFill,
          AgentFill.of({
            fill: () => Effect.succeed({ sessionId: 's1', patch: { name: 'Vorak' } }),
          }),
        ),
      }),
    );
    const builder = BuilderView.new();
    builder.setField('ability', 'Draw a card.');
    builder.aiPrompt = 'rename him';
    await builder.fillWithAI();
    expect(builder.data.name).toBe('Vorak');
    expect(builder.data.ability).toBe('Draw a card.'); // untouched
    expect(builder.fillSessionId).toBe('s1');
    expect(builder.aiNote).toBe('Applied.');
    builder.set(null);
  });

  it('sends the CURRENT data on later turns so hand edits survive', async () => {
    const seen: AgentFillRequestT[] = [];
    setAppLayer(
      testAppLayerWith({
        fill: Layer.succeed(
          AgentFill,
          AgentFill.of({
            fill: (req) => {
              seen.push(req);
              return Effect.succeed({ sessionId: 's1', patch: {} });
            },
          }),
        ),
      }),
    );
    const builder = BuilderView.new();
    builder.aiPrompt = 'first turn';
    await builder.fillWithAI();
    builder.setField('ability', 'Hand edit wins.');
    builder.aiPrompt = 'second turn';
    await builder.fillWithAI();
    expect(seen[0]?.sessionId).toBeUndefined(); // first turn creates the episode
    expect(seen[1]?.sessionId).toBe('s1'); // later turns reuse it
    expect(seen[1]?.currentData.ability).toBe('Hand edit wins.');
    builder.set(null);
  });

  it('discards the fill session on theme, layout, or card switch', async () => {
    setAppLayer(
      testAppLayerWith({
        fill: Layer.succeed(
          AgentFill,
          AgentFill.of({
            fill: () => Effect.succeed({ sessionId: 's1', patch: {} }),
          }),
        ),
      }),
    );
    const builder = BuilderView.new();
    builder.aiPrompt = 'start';
    await builder.fillWithAI();
    expect(builder.fillSessionId).toBe('s1');
    builder.pickLayout('fullart');
    expect(builder.fillSessionId).toBeUndefined();

    builder.aiPrompt = 'again';
    await builder.fillWithAI();
    expect(builder.fillSessionId).toBe('s1');
    builder.pickTheme('arcane');
    expect(builder.fillSessionId).toBeUndefined();

    builder.aiPrompt = 'once more';
    await builder.fillWithAI();
    builder.loadCard({
      id: 'c1',
      name: 'Loaded',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Loaded' },
      holo: false,
      updatedAt: 1,
    });
    expect(builder.fillSessionId).toBeUndefined();
    builder.set(null);
  });

  it('auto-runs art generation when the fill returns an artAction', async () => {
    const generate = vi.fn((input: GenerationInput) => {
      expect(input.brief).toBe('a phoenix companion');
      expect(input.themeContext?.lookAndFeel.toLowerCase()).toContain('oil');
      // no current art on a fresh card → edit request downgrades to fresh generation
      expect(input.editCurrentArt).toBe(false);
      return Effect.succeed({ bytes: bytesOf('art'), type: 'image/png', via: 'stub' as const });
    });
    setAppLayer(
      testAppLayerWith({
        fill: Layer.succeed(
          AgentFill,
          AgentFill.of({
            fill: () =>
              Effect.succeed({
                sessionId: 's1',
                patch: { name: 'Vorak' },
                artAction: { brief: 'a phoenix companion', editCurrentArt: true },
              }),
          }),
        ),
        image: Layer.succeed(ImageProvider, ImageProvider.of({ generate })),
      }),
    );
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.library.ready).toBe(true));
    // Reach the mounted BuilderView through its context (headless BuilderView has no shell/library).
    const builderEl = document.querySelector('aside');
    expect(builderEl).not.toBeNull();
    // Drive the fill through the mounted app: find the AI textarea + button.
    const textarea = document.querySelector(
      'textarea[placeholder="a fire mage with a phoenix companion…"]',
    );
    await setInput(textarea, 'make him a phoenix mage');
    const fillButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Fill with AI',
    );
    await click(fillButton ?? null);
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledOnce();
      expect(shell.library.images).toHaveLength(1);
    });
    unmount();
  });
});
