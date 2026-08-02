import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput, tick } from '../../test/util';
import { BuilderView } from './BuilderView';

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
    // Scope to the visible pane — the hidden Code Lab pane keeps its own (holo) starter card mounted.
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
});
