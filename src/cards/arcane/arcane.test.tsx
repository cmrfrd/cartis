import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../../test/util';
import { getLayout, getTheme } from '../registry';
import { ArcaneCard } from './ArcaneCard';
import { EssenceGlyph } from './glyphs';
import { ESSENCES, paletteFor } from './palette';
import { rarityGemStyle } from './parts';
import { arcaneFields, arcaneTheme } from './theme';

const classicDefaults = arcaneTheme.layouts[0]?.defaults ?? {};

describe('arcane palette', () => {
  it('resolves known essences and falls back to relic', () => {
    expect(paletteFor('ember').id).toBe('ember');
    expect(paletteFor('bogus').id).toBe('relic');
  });
});

describe('arcane theme', () => {
  it('is registered by test setup', () => {
    expect(getTheme('arcane').name).toBe('Arcane');
  });

  it('provides defaults for every non-image field', () => {
    const classic = getLayout('arcane', 'classic');
    for (const field of classic.fields) {
      if (field.kind === 'image') continue;
      expect(classic.defaults[field.key], `default for ${field.key}`).toBeDefined();
    }
  });

  it('shares one field list across layouts', () => {
    expect(getLayout('arcane', 'fullart').fields).toBe(arcaneFields);
  });
});

describe('ArcaneCard', () => {
  it('renders name, type line, rules, and stats from data', async () => {
    const { container, unmount } = mount(<ArcaneCard data={classicDefaults} />);
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
    const { container, unmount } = mount(<ArcaneCard data={classicDefaults} holo />);
    await tick();
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull();
    unmount();
  });

  it('renders identity details: watermark, set symbol, filigree, collector strip', async () => {
    const { container, unmount } = mount(<ArcaneCard data={classicDefaults} />);
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

describe('optional card sections', () => {
  it('hides the stat badge when showStats is false', async () => {
    const { container, unmount } = mount(
      <ArcaneCard data={{ ...classicDefaults, showStats: false }} />,
    );
    await tick();
    expect(container.querySelector('[data-testid="stat-badge"]')).toBeNull();
    unmount();
  });

  it('keeps the stat badge for cards saved before the toggle existed', async () => {
    const { showStats: _omit, ...legacy } = classicDefaults;
    const { container, unmount } = mount(<ArcaneCard data={legacy} />);
    await tick();
    expect(container.querySelector('[data-testid="stat-badge"]')).not.toBeNull();
    unmount();
  });

  it('hides type line and collector strip when their fields are empty', async () => {
    const { container, unmount } = mount(
      <ArcaneCard data={{ ...classicDefaults, typeLine: '', collector: '  ' }} />,
    );
    await tick();
    expect(container.querySelector('[data-testid="rarity-gem"]')).toBeNull();
    expect(container.querySelector('[data-testid="collector-strip"]')).toBeNull();
    unmount();
  });
});

describe('full-art template and card back', () => {
  it('registers the fullart layout alongside the classic frame', () => {
    expect(getLayout('arcane', 'fullart').Render).toBeDefined();
    expect(getLayout('arcane', 'fullart').fields).toBe(arcaneFields);
  });

  it('renders full-bleed art layer with floating plates', async () => {
    const { ArcaneFullArtCard } = await import('./ArcaneFullArtCard');
    const { container, unmount } = mount(
      <ArcaneFullArtCard data={{ ...classicDefaults, name: 'Nyra, Unbound' }} />,
    );
    await tick();
    expect(container.querySelector('[data-testid="fullart-art"]')).not.toBeNull();
    expect(container.textContent).toContain('Nyra, Unbound');
    expect(container.querySelector('[data-testid="stat-badge"]')).not.toBeNull();
    unmount();
  });

  it('renders the Cartis card back', async () => {
    const { ArcaneCardBack } = await import('./ArcaneCardBack');
    const { container, unmount } = mount(<ArcaneCardBack />);
    await tick();
    expect(container.querySelector('[data-testid="card-back"]')).not.toBeNull();
    expect(container.textContent).toContain('CARTIS');
    expect(container.querySelectorAll('[data-testid="filigree"]').length).toBe(4);
    unmount();
  });
});

describe('foil variants and mythic aura', () => {
  it('selects the etched foil layer from card data', async () => {
    const { container, unmount } = mount(
      <ArcaneCard data={{ ...classicDefaults, foilStyle: 'etched' }} holo />,
    );
    await tick();
    expect(container.querySelector('[data-holo-variant="etched"]')).not.toBeNull();
    unmount();
  });

  it('defaults to the full-gloss foil layer', async () => {
    const { container, unmount } = mount(<ArcaneCard data={classicDefaults} holo />);
    await tick();
    expect(container.querySelector('[data-holo-variant="full"]')).not.toBeNull();
    unmount();
  });

  it('gives mythic cards a prismatic aura', async () => {
    const { container, unmount } = mount(
      <ArcaneCard data={{ ...classicDefaults, rarity: 'mythic' }} />,
    );
    await tick();
    const root = container.querySelector('[data-card-root="true"]') as HTMLElement;
    expect(root.style.boxShadow).toContain('rgba(194, 37, 37');
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
