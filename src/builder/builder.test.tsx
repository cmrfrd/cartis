import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput, tick } from '../../test/util';

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
    expect(container.querySelector('[data-holo="true"]')).toBeNull();
    const holoButton = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Holo'),
    );
    await click(holoButton ?? null);
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull();
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
    expect(shell.archive.cards[0]?.templateId).toBe('arcane-hero');
    await tick();
    expect(container.textContent).toContain('Saved');
    unmount();
  });
});
