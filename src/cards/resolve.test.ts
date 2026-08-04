import { describe, expect, it } from 'vitest';
import { resolveImageFields } from '@/cards/resolve';
import type { Layout } from '@/cards/types';

const layout = {
  fields: [
    { kind: 'image', key: 'art', label: 'Art' },
    { kind: 'text', key: 'name', label: 'Name' },
  ],
} as unknown as Layout;

describe('resolveImageFields (THE shared builder/gallery resolution)', () => {
  it('maps library ids through urls, passes displayable values, drops the rest', () => {
    const urls = { 'img-1': 'blob:resolved' };
    expect(resolveImageFields({ art: 'img-1', name: 'A' }, layout, urls)).toEqual({
      art: 'blob:resolved',
      name: 'A',
    });
    expect(resolveImageFields({ art: 'blob:direct' }, layout, {}).art).toBe('blob:direct');
    expect(resolveImageFields({ art: 'data:image/png;base64,QQ==' }, layout, {}).art).toBe(
      'data:image/png;base64,QQ==',
    );
    expect(resolveImageFields({ art: 'unknown-id' }, layout, {}).art).toBeUndefined();
    // non-image fields untouched
    expect(resolveImageFields({ name: 'keep' }, layout, {}).name).toBe('keep');
  });
});
