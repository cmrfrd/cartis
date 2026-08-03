# Unified Saved cards view — renders grouped under cards, with search

**Date:** 2026-08-02 · **Status:** approved (brainstorm 2026-08-02)

## Context

The Gallery currently splits three tabs: Renders (exports grid), Library (images), Saved
cards (card rows). Renders and saved cards are two views of the same thing — a card and
its printable outputs — so they merge into ONE "Saved cards" view where the card is the
unit and its renders hang off it. A search input filters the unified view. The Gallery
drops to two tabs: **Saved cards** and **Library**.

## Decisions (locked during brainstorm)

1. **Renders grouped under their card.** Each saved-card entry shows the card info +
   action buttons, with thumbnails of ITS exports beneath. Requires linking exports to
   cards: `ExportRecord`/`StoredExport` gains an optional `cardId`.
2. **Legacy exports** (no `cardId` — everything exported before this change) fall back
   to an **"Other renders"** section at the bottom of the view. No migration; the
   optional field decodes absent harmlessly (lenient store philosophy).
3. **Search** filters the unified view (user addition).

## Model changes

- `src/contracts/records.ts` `ExportRecord`: add `cardId: Schema.optional(Schema.String)`.
- `src/storage/CardArchive.ts` `saveExport` input gains optional `cardId`, stored on the
  record. (`StoredExport = ExportRecordT` alias updates automatically.)
- `src/export/ExportBar.tsx`: exports made from the Builder pass the open document's
  `savedId` as `cardId` — **only when the card has been saved**; exports of unsaved
  cards (and the card-back export) carry no `cardId` and land in Other renders.
  ExportBar receives the id via its existing props path from BuilderView (exact prop
  plumbing decided at plan time; no behavior change otherwise).

## UI (`src/gallery/GalleryView.tsx`)

- `SECTIONS` → `[{ id: 'cards', label: 'Saved cards' }, { id: 'images', label: 'Library' }]`;
  default section becomes `cards`. `GalleryExports` is absorbed into `GalleryCards`.
- **Unified card entry:** the existing row (clickable open, themeId · layoutId · date,
  Open in builder / Duplicate / Delete) plus, when the card has exports, a thumbnail
  strip beneath (same Download/Delete affordances per render as today's grid).
  Deleting a card does NOT delete its renders — they move to Other renders (still
  carrying a dangling cardId; grouping is computed against existing cards).
- **Other renders:** exports whose `cardId` is absent OR doesn't match any existing
  card, rendered as today's grid under a heading at the bottom. Hidden when empty.
- **Search:** a text input at the top of the Saved cards view. Case-insensitive
  substring match against: card `name`, `themeId`, `layoutId`, and the card's
  `typeLine`/`ability` data values (stringified). A card matches → its whole entry
  (with renders) shows. Other renders filter by export `name`. Empty query = show all.
  Pure client-side filtering of already-loaded state — no store/bridge changes.

## Engineering requirements (binding)

Repo standards apply (no `any`/`!`/`as`-on-external-data; `cardId` flows through the
existing Schema-decoded contracts). Search/grouping are pure functions over reactive
state — extracted as testable helpers (`groupExports(cards, exports)`,
`matchesQuery(card, query)`) rather than inline JSX logic. Tests: contract decode with
and without `cardId`; grouping (linked, legacy-absent, dangling cardId); search matrix
(name/theme/layout/data hits, case-insensitivity, empty query); saveExport persists
`cardId`; Builder export passes `savedId` only when saved; UI renders grouped
thumbnails + Other renders + two tabs. `bun run verify` green.

## Out of scope

Migrating legacy exports (name-based inference rejected — ambiguous); searching the
Library tab (can adopt the same helper later); deleting renders when their card is
deleted; server-side search.
