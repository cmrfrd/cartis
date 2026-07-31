import { describe, expect, it } from 'vitest';
import {
  halftoneSurface,
  LINEN_TEXTURE,
  noiseTextureUrl,
  PAPER_GRAIN,
  PARCHMENT_MOTTLE,
  plateSurface,
} from './textures';

describe('procedural textures', () => {
  it('produces css url() data-URIs with an encoded turbulence filter', () => {
    for (const texture of [PARCHMENT_MOTTLE, PAPER_GRAIN, LINEN_TEXTURE]) {
      expect(texture.startsWith('url("data:image/svg+xml,')).toBe(true);
      expect(texture).toContain(encodeURIComponent('feTurbulence'));
      expect(texture).toContain('%23n'); // filter reference survives encoding
    }
  });

  it('is deterministic for fixed options', () => {
    const a = noiseTextureUrl({ frequency: '0.5', octaves: 3, seed: 1, alpha: 0.2 });
    const b = noiseTextureUrl({ frequency: '0.5', octaves: 3, seed: 1, alpha: 0.2 });
    expect(a).toBe(b);
  });

  it('exposes layered plate material and halftone pattern', () => {
    expect(plateSurface.backgroundImage).toContain('data:image/svg+xml');
    expect(String(plateSurface.boxShadow)).toContain('inset');
    expect(halftoneSurface.backgroundSize).toBe('4px 4px');
  });
});
