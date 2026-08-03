/**
 * Pure helpers for the unified Saved cards view
 * (spec: 2026-08-02-unified-saved-cards-design).
 */

import type { StoredCard, StoredExport } from '../storage/CardArchive';

/** Group exports under their card; legacy (no cardId) and dangling links go to `other`. */
export function groupExports(
  cards: readonly StoredCard[],
  exports: readonly StoredExport[],
): { byCard: ReadonlyMap<string, StoredExport[]>; other: StoredExport[] } {
  const known = new Set(cards.map((c) => c.id));
  const byCard = new Map<string, StoredExport[]>();
  const other: StoredExport[] = [];
  for (const item of exports) {
    if (item.cardId !== undefined && known.has(item.cardId)) {
      const bucket = byCard.get(item.cardId) ?? [];
      bucket.push(item);
      byCard.set(item.cardId, bucket);
    } else {
      other.push(item);
    }
  }
  return { byCard, other };
}

const normalize = (query: string): string => query.trim().toLowerCase();

/** Case-insensitive substring search over a card's identity + key text fields. */
export function matchesQuery(card: StoredCard, query: string): boolean {
  const q = normalize(query);
  if (q.length === 0) return true;
  const haystack = [
    card.name,
    card.themeId,
    card.layoutId,
    String(card.data.typeLine ?? ''),
    String(card.data.ability ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** Case-insensitive substring search over a render's name. */
export function exportMatchesQuery(item: StoredExport, query: string): boolean {
  const q = normalize(query);
  if (q.length === 0) return true;
  return item.name.toLowerCase().includes(q);
}
