import { describe, expect, it } from 'vitest';
import { paletteFor } from './palette';
import { arcaneFields, arcaneTheme } from './theme';

describe('arcaneTheme', () => {
  it('has arcane identity and two layouts sharing one field list', () => {
    expect(arcaneTheme.id).toBe('arcane');
    expect(arcaneTheme.name).toBe('Arcane');
    expect(arcaneTheme.lookAndFeel.toLowerCase()).toContain('oil');
    expect(arcaneTheme.layouts.map((l) => l.id)).toEqual(['classic', 'fullart']);
    expect(arcaneTheme.layouts[0]?.fields).toBe(arcaneFields);
    expect(arcaneTheme.layouts[1]?.fields).toBe(arcaneFields);
  });

  it('classic + fullart carry the right aspects and fullart defaults override', () => {
    expect(arcaneTheme.layouts[0]?.artAspect).toBe('3:2');
    expect(arcaneTheme.layouts[1]?.artAspect).toBe('3:4');
    expect(arcaneTheme.layouts[1]?.defaults.name).toBe('Nyra, Unbound');
    expect(arcaneTheme.layouts[1]?.defaults.flavor).toBe('');
  });

  it('artFlavor pulls per-essence flavor from the palette', () => {
    expect(arcaneTheme.artFlavor?.({ essence: 'tide' })).toBe(paletteFor('tide').artFlavor);
  });
});
