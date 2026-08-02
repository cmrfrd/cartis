import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { ThemeContext, ThemeIdentity } from './theme';

describe('ThemeIdentity', () => {
  it('decodes a full identity', () => {
    const decoded = Schema.decodeUnknownSync(ThemeIdentity)({
      id: 'arcane',
      name: 'Arcane',
      description: 'a world',
      lookAndFeel: 'painterly oil brushwork',
    });
    expect(decoded.id).toBe('arcane');
  });

  it('rejects a missing lookAndFeel', () => {
    expect(() =>
      Schema.decodeUnknownSync(ThemeIdentity)({ id: 'x', name: 'X', description: 'd' }),
    ).toThrow();
  });
});

describe('ThemeContext', () => {
  it('decodes the shared context block', () => {
    const decoded = Schema.decodeUnknownSync(ThemeContext)({
      lookAndFeel: 'oil',
      palette: 'ember warm',
      argumentSummary: 'name, essence',
    });
    expect(decoded.palette).toBe('ember warm');
  });
});
