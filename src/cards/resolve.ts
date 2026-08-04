/**
 * THE image-field resolution — the single definition of how a card's stored
 * image references become displayable URLs. Used by BOTH the Builder preview
 * and the Gallery tiles, so the two renders are identical BY CONSTRUCTION
 * (they were previously hand-copied duplicates — a silent-drift hazard).
 *
 * Resolution per image field: library id → object URL from `urls`; already
 * displayable blob:/data: values pass through; anything else → undefined
 * (the layout renders its placeholder).
 */

import type { CardData, Layout } from './types';

export function resolveImageFields(
  data: CardData,
  layout: Layout,
  urls: Record<string, string>,
): CardData {
  const out: CardData = { ...data };
  for (const field of layout.fields) {
    if (field.kind !== 'image') continue;
    const raw = out[field.key];
    const id = typeof raw === 'string' ? raw : '';
    out[field.key] =
      urls[id] ?? (id.startsWith('blob:') || id.startsWith('data:') ? id : undefined);
  }
  return out;
}
