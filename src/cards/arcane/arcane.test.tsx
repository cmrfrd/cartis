import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../../test/util';
import { getTemplate } from '../registry';
import { ArcaneCard } from './ArcaneCard';
import { paletteFor } from './palette';
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
});
