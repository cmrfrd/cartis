import { describe, expect, it } from 'vitest';
import { titleSizeFor } from './typography';

describe('titleSizeFor', () => {
  it('keeps short names at full size', () => {
    expect(titleSizeFor('Nyra, Ember Sage')).toBe(17);
    expect(titleSizeFor('Zed')).toBe(17);
  });

  it('shrinks monotonically for longer names', () => {
    let last = titleSizeFor('a'.repeat(16));
    for (let n = 17; n <= 40; n++) {
      const size = titleSizeFor('a'.repeat(n));
      expect(size).toBeLessThanOrEqual(last);
      last = size;
    }
  });

  it('never drops below the readable floor', () => {
    expect(titleSizeFor('a'.repeat(200))).toBe(11);
  });
});
