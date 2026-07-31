import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../../test/util';
import { getTemplate } from '../registry';
import { ArcaneCard } from './ArcaneCard';
import { EssenceGlyph } from './glyphs';
import { ESSENCES, paletteFor } from './palette';
import { rarityGemStyle } from './parts';
import { arcaneTemplate } from './template';

describe('arcane palette', () => {
  it('resolves known essences and falls back to relic', () => {
    expect(paletteFor('ember').id).toBe('ember');
    expect(paletteFor('bogus').id).toBe('relic');
  });
});

describe('arcane template', () => {
  it('is registered by test setup', () => {
    expect(getTemplate('arcane-hero').kitId).toBe('arcane');
  });

  it('provides defaults for every non-image field', () => {
    for (const field of arcaneTemplate.fields) {
      if (field.kind === 'image') continue;
      expect(arcaneTemplate.defaults[field.key], `default for ${field.key}`).toBeDefined();
    }
  });

  it('bakes the essence art flavor into the style prompt', () => {
    const prompt = arcaneTemplate.artStylePrompt({ essence: 'tide' });
    expect(prompt).toContain(paletteFor('tide').artFlavor);
    expect(prompt.toLowerCase()).toContain('portrait');
  });
});

describe('ArcaneCard', () => {
  it('renders name, type line, rules, and stats from data', async () => {
    const { container, unmount } = mount(<ArcaneCard data={arcaneTemplate.defaults} />);
    await tick();
    const text = container.textContent ?? '';
    expect(text).toContain('Nyra, Ember Sage');
    expect(text).toContain('Hero — Pyromancer');
    expect(text).toContain('deal 2 damage');
    expect(text).toContain('2');
    expect(text).toContain('3');
    expect(container.querySelector('[data-holo="true"]')).toBeNull();
    unmount();
  });

  it('shows holo foil when enabled', async () => {
    const { container, unmount } = mount(<ArcaneCard data={arcaneTemplate.defaults} holo />);
    await tick();
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull();
    unmount();
  });

  it('renders identity details: watermark, set symbol, filigree, collector strip', async () => {
    const { container, unmount } = mount(<ArcaneCard data={arcaneTemplate.defaults} />);
    await tick();
    expect(container.querySelector('[data-testid="watermark"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="set-symbol"] [data-testid="glyph-ember"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="filigree"]').length).toBe(2);
    expect(container.querySelector('[data-testid="collector-strip"]')?.textContent).toContain(
      '001/001 · Cartis Original',
    );
    unmount();
  });
});

describe('essence glyphs and rarity gems', () => {
  it('renders a distinct glyph for every essence', async () => {
    for (const essence of ESSENCES) {
      const { container, unmount } = mount(<EssenceGlyph essence={essence.id} />);
      await tick();
      expect(container.querySelector(`[data-testid="glyph-${essence.id}"]`)).not.toBeNull();
      unmount();
    }
  });

  it('facets every rarity with a conic gradient + highlight', () => {
    for (const rarity of ['common', 'uncommon', 'rare', 'mythic'] as const) {
      const style = rarityGemStyle(rarity);
      expect(style.backgroundImage).toContain('conic-gradient');
      expect(style.backgroundImage).toContain('radial-gradient');
    }
  });
});
