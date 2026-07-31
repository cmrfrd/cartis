import { describe, expect, it } from 'vitest';
import {
  frameLinenStyle,
  halftoneSurface,
  noiseTextureUrl,
  plateStyle,
  prepareTextures,
  TEXTURES,
} from './textures';

describe('procedural textures', () => {
  it('authors css url() data-URIs with an encoded turbulence filter', () => {
    for (const texture of Object.values(TEXTURES)) {
      expect(texture.startsWith('url("data:image/')).toBe(true);
    }
    const fresh = noiseTextureUrl({ frequency: '0.5', octaves: 3, seed: 1, alpha: 0.2 });
    expect(fresh).toContain(encodeURIComponent('feTurbulence'));
    expect(fresh).toContain('%23n'); // filter reference survives encoding
  });

  it('is deterministic for fixed options', () => {
    const a = noiseTextureUrl({ frequency: '0.5', octaves: 3, seed: 1, alpha: 0.2 });
    const b = noiseTextureUrl({ frequency: '0.5', octaves: 3, seed: 1, alpha: 0.2 });
    expect(a).toBe(b);
  });

  it('prepareTextures resolves even without canvas support (keeps svg fallback)', async () => {
    await expect(prepareTextures()).resolves.toBeUndefined();
    for (const texture of Object.values(TEXTURES)) {
      expect(texture.startsWith('url("data:image/')).toBe(true);
    }
  });

  it('exposes layered material styles', () => {
    expect(plateStyle().backgroundImage).toContain('data:image/');
    expect(String(plateStyle().boxShadow)).toContain('inset');
    expect(frameLinenStyle().backgroundImage).toContain('data:image/');
    expect(halftoneSurface.backgroundSize).toBe('4px 4px');
  });
});
