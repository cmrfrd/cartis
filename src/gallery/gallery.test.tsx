import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, setInput, tick } from '../../test/util';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('GalleryView', () => {
  it('lists saved cards, exports, and generations from the stores', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => {
      expect(shell.archive.ready && shell.library.ready).toBe(true);
    });
    await shell.archive.saveCard({
      name: 'Stored Hero',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Stored Hero' },
      holo: false,
    });
    await shell.archive.saveExport({
      name: 'stored-hero.png',
      format: 'png',
      bytes: bytesOf('x'),
      type: 'image/png',
    });
    await shell.library.add({
      name: 'A Knight',
      kind: 'generated',
      prompt: 'a knight',
      bytes: bytesOf('y'),
      type: 'image/png',
    });

    shell.view = 'gallery';
    await tick();
    await vi.waitFor(() => {
      expect(container.textContent).toContain('stored-hero.png');
    });

    const tabs = Array.from(container.querySelectorAll('button'));
    await click(tabs.find((b) => b.textContent === 'Library') ?? null);
    expect(container.textContent).toContain('A Knight');

    await click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Saved cards',
      ) ?? null,
    );
    expect(container.textContent).toContain('Stored Hero');
    unmount();
  });

  it('opens a saved card back into the builder', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => {
      expect(shell.archive.ready).toBe(true);
    });
    await shell.archive.saveCard({
      name: 'Round Trip',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Round Trip', essence: 'tide', ability: 'Draw a card.' },
      holo: true,
    });
    shell.view = 'gallery';
    await tick();
    await click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Saved cards',
      ) ?? null,
    );
    await click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Open in builder',
      ) ?? null,
    );
    await tick();
    expect(shell.view).toBe('builder');
    await vi.waitFor(() => {
      expect(shell.pendingCard).toBeUndefined(); // consumed by BuilderView
      expect(container.querySelector('[data-holo="true"]')).not.toBeNull();
    });
    expect(container.textContent).toContain('Round Trip');
    unmount();
  });

  it('re-saving an opened card updates the same record', async () => {
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const first = await shell.archive.saveCard({
      name: 'Once',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Once' },
      holo: false,
    });
    const again = await shell.archive.saveCard({
      id: first.id,
      name: 'Twice',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Twice' },
      holo: false,
    });
    expect(again.id).toBe(first.id);
    expect(shell.archive.cards).toHaveLength(1);
    expect(shell.archive.cards[0]?.name).toBe('Twice');
    unmount();
  });

  it('duplicates a card into a new record, leaving the original untouched', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    await shell.archive.saveCard({
      name: 'Solo',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Solo' },
      holo: true,
    });
    shell.view = 'gallery';
    await tick();
    await click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Saved cards',
      ) ?? null,
    );
    await click(
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Duplicate') ??
        null,
    );
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(2));
    const names = shell.archive.cards.map((c) => c.name).sort();
    expect(names).toEqual(['Solo', 'Solo copy']);
    const copy = shell.archive.cards.find((c) => c.name === 'Solo copy');
    expect(copy?.holo).toBe(true);
    expect(copy?.data.name).toBe('Solo copy');
    unmount();
  });

  it('groups renders under their card, legacy renders under Other renders, and search filters', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const saved = await shell.archive.saveCard({
      name: 'Linked Hero',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Linked Hero', ability: 'Fly high.' },
      holo: false,
    });
    await shell.archive.saveExport({
      name: 'linked-hero.png',
      format: 'png',
      bytes: bytesOf('a'),
      type: 'image/png',
      cardId: saved.id,
    });
    await shell.archive.saveExport({
      name: 'ancient-render.png',
      format: 'png',
      bytes: bytesOf('b'),
      type: 'image/png',
    });
    shell.view = 'gallery';
    await tick();
    // default section IS the unified Saved cards view
    const text = () => container.textContent ?? '';
    expect(text()).toContain('Linked Hero');
    expect(text()).toContain('linked-hero.png'); // grouped under the card
    expect(text()).toContain('Other renders');
    expect(text()).toContain('ancient-render.png'); // legacy, ungrouped
    // search: ability text matches the card (renders of other cards filter out)
    const search = container.querySelector('input[placeholder="Search cards and renders…"]');
    await setInput(search, 'fly high');
    expect(text()).toContain('Linked Hero');
    expect(text()).not.toContain('Other renders'); // ancient render filtered out
    await setInput(search, 'zzz-nothing');
    expect(text()).toContain('Nothing matches your search.');
    await setInput(search, 'ancient');
    expect(text()).not.toContain('Linked Hero');
    expect(text()).toContain('ancient-render.png');
    unmount();
  });
});
