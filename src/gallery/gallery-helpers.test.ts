import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { CardId, ExportId, LayoutId, ThemeId, Timestamp } from '../contracts/ids';
import type { StoredCard, StoredExport } from '../storage/CardArchive';
import {
  exportMatchesQuery,
  groupExports,
  layoutOf,
  matchesQuery,
  resolveCardData,
} from './gallery-helpers';

const card = (over: Partial<StoredCard> = {}): StoredCard => ({
  id: CardId.make('c1'),
  name: 'The Great Henge',
  themeId: ThemeId.make('arcane'),
  layoutId: LayoutId.make('fullart'),
  data: { name: 'The Great Henge', typeLine: 'Legendary Artifact', ability: 'Gain 2 life.' },
  holo: false,
  updatedAt: Timestamp.make(1),
  ...over,
});

const exp = (over: Partial<StoredExport> = {}): StoredExport => ({
  id: ExportId.make('e1'),
  name: 'the-great-henge.png',
  format: 'png',
  type: 'image/png',
  createdAt: Timestamp.make(1),
  ...over,
});

describe('groupExports', () => {
  it('groups linked exports under their card; legacy and dangling go to other', () => {
    const cards = [card()];
    const exports = [
      exp({ id: ExportId.make('e1'), cardId: CardId.make('c1') }),
      exp({ id: ExportId.make('e2') }), // legacy: no cardId
      exp({ id: ExportId.make('e3'), cardId: CardId.make('deleted-card') }), // dangling
    ];
    const { byCard, other } = groupExports(cards, exports);
    expect(byCard.get('c1')?.map((e) => e.id)).toEqual(['e1']);
    expect(other.map((e) => e.id)).toEqual(['e2', 'e3']);
  });
});

describe('matchesQuery', () => {
  it('matches name, theme, layout, typeLine, and ability case-insensitively', () => {
    const c = card();
    expect(matchesQuery(c, 'henge')).toBe(true);
    expect(matchesQuery(c, 'ARCANE')).toBe(true);
    expect(matchesQuery(c, 'fullart')).toBe(true);
    expect(matchesQuery(c, 'legendary art')).toBe(true);
    expect(matchesQuery(c, 'gain 2 life')).toBe(true);
    expect(matchesQuery(c, 'dragon')).toBe(false);
  });

  it('empty or whitespace query matches everything', () => {
    expect(matchesQuery(card(), '')).toBe(true);
    expect(matchesQuery(card(), '   ')).toBe(true);
  });
});

describe('exportMatchesQuery', () => {
  it('matches the render name case-insensitively; empty matches all', () => {
    expect(exportMatchesQuery(exp(), 'HENGE')).toBe(true);
    expect(exportMatchesQuery(exp(), 'dragon')).toBe(false);
    expect(exportMatchesQuery(exp(), '')).toBe(true);
  });
});

describe('layoutOf', () => {
  it('resolves registered layouts as Some and unknown ones as None (no throw-and-catch)', () => {
    expect(Option.getOrUndefined(layoutOf(card()))?.id).toBe('fullart');
    expect(Option.isNone(layoutOf(card({ themeId: ThemeId.make('gone') })))).toBe(true);
    expect(Option.isNone(layoutOf(card({ layoutId: LayoutId.make('gone') })))).toBe(true);
  });
});

describe('resolveCardData', () => {
  it('maps image field ids through the library urls', () => {
    const c = card({ data: { name: 'X', art: 'img-1' } });
    const layout = Option.getOrUndefined(layoutOf(c));
    expect(layout).toBeDefined();
    if (!layout) return;
    const resolved = resolveCardData(c, layout, { 'img-1': 'blob:art-url' });
    expect(resolved.art).toBe('blob:art-url');
    expect(resolved.name).toBe('X');
    const unresolved = resolveCardData(c, layout, {});
    expect(unresolved.art).toBeUndefined();
  });
});
