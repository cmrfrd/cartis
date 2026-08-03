import { describe, expect, it } from 'vitest';

const FORBIDDEN_LAYERS = [
  'app',
  'builder',
  'storage',
  'images',
  'editor',
  'export',
  'gallery',
  'server',
];

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('cards/ layering', () => {
  it('scans real files (guard against a silent empty glob)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('never imports upward into app layers', () => {
    for (const [path, content] of Object.entries(sources)) {
      if (path.includes('.test.')) continue;
      for (const layer of FORBIDDEN_LAYERS) {
        expect(content, `${path} must not import ../${layer}`).not.toContain(`from '../${layer}`);
        expect(content, `${path} must not import ../../${layer}`).not.toContain(
          `from '../../${layer}`,
        );
        expect(content, `${path} must not import @/${layer}`).not.toContain(`from '@/${layer}`);
      }
    }
  });
});
