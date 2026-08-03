# Card document lifecycle — Builder as a document editor

**Date:** 2026-08-02 · **Status:** approved (brainstorm 2026-08-02)

## Context

Cards already persist, reopen from the Gallery, and re-save in place (`savedId` upsert,
themes/layouts redesign). What is missing is the *feel* of a document tool: an explicit
**New**, visible document identity, protection against silently losing unsaved work, and
forking. This spec adds document semantics on top of the existing persistence — no
storage, contract, or AI-pipeline changes.

## Decisions (locked during brainstorm)

1. **Manual save.** A card is written only by an explicit Save action (today's
   behavior). Everything else is in-memory working state.
2. **Confirm dialog on destructive intents.** New and opening another card while dirty
   show a Save first / Discard / Cancel choice. Rendered inline in the Builder (not
   `window.confirm` — testable in happy-dom, styleable).
3. **Fork on both surfaces.** "Save as copy" in the Builder; "Duplicate" on gallery
   rows. Both write a fresh record.
4. **Theme switch edits the same document.** `pickTheme` keeps `savedId`, preserves
   overlapping argument values, marks dirty. **New is the only way to start fresh.**
5. **YAGNI:** no Revert-to-saved, no autosave, no drafts, no version history. Revert is
   a cheap later add (`loadCard` from the archive by `savedId`).

## Document model (`src/builder/BuilderView.tsx`)

Document state on `BuilderView`:

- `savedId?: string` (exists) — the record this document is bound to; `undefined` = new.
- `dirty: boolean` (new) — modified-flag semantics, no deep comparison:
  - **set true** by: `setField`, holo toggle, `pickLayout`, `pickTheme`, art applied
    (generate or library pick), AI fill patch merge, artAction art.
  - **set false** by: `saveCard` success, `loadCard`, `newCard`, save-as-copy success.
- `pendingIntent?: { kind: 'new' } | { kind: 'open'; card: StoredCard }` (new) — a
  guarded destructive intent awaiting the user's Save/Discard/Cancel choice.

### Actions

- **`newCard()`** — blank card in the *current* theme + layout: merged defaults seed
  `data`, clears `savedId`, `dirty`, `fillSessionId`, `aiNote`, `savedNote`,
  `portraitKey`. Guarded when dirty.
- **`saveCard()`** — unchanged upsert (binds `savedId` on first save); clears `dirty`.
- **`saveAsCopy()`** — saves with a fresh id and name `` `${name} copy` `` (data
  unchanged, including the art reference — both records point at the same library
  image); the Builder switches to editing the copy (`savedId` = new id, `dirty` false).
- **`pickTheme(id)`** — becomes an EDIT: keeps `savedId`; switches to the theme's first
  layout; preserves values for argument keys present in that layout's fields (the same
  preservation logic `pickLayout` uses); seeds that layout's defaults for missing keys;
  marks dirty; discards the fill session (spec decision 6 of the themes redesign).
  No guard.
- **`pickLayout(id)`** — as today, plus marks dirty. No guard.
- **`loadCard(card)`** — as today, plus clears `dirty`.

### Dirty guard flow

`requestNew()` / gallery-open route through the guard:

- Not dirty → execute immediately.
- Dirty → set `pendingIntent`; the Builder renders the inline confirm:
  "Unsaved changes on *{title}*" with **Save first** (save, then execute the intent —
  a failed save cancels the intent and shows the save error), **Discard** (execute
  without saving), **Cancel** (clear the intent, stay put).

Gallery opens guard at consume time: `AppShell.pendingCard` is set and the view
switches as today; `BuilderView`'s `consumePending` checks `dirty` — if dirty, it
holds the card in `pendingIntent` (clearing `shell.pendingCard`) and shows the confirm
instead of loading. Cancel keeps the current document.

## UI

**Document bar** — a strip at the top of the Builder form (above the Theme panel):

- Title: `data.name` (or "Untitled card" when blank/absent), with a `·` unsaved dot +
  "Unsaved changes" when dirty, "Saved" after a save (replaces today's inline
  `savedNote` placement; the saved-note text itself is preserved).
- Actions: **New**, **Save**, **Save as copy** (copy disabled until the card has ever
  been saved OR has content — enabled whenever `data` is non-default or `savedId`
  exists; simplest: always enabled).
- The inline confirm renders in/under this bar when `pendingIntent` is set.

**Gallery** — each saved-card row gains **Duplicate** (between Open and Delete):
`archive.saveCard({ ...card, id: undefined, name: `${card.name} copy` })`. The list
re-sorts by `updatedAt` as usual; no navigation.

## Out of scope / untouched

Persistence contracts (`CardRecord`), StoreClient/FileStore, AI pipelines (fill + art),
card renders, exports. Fill-session discard rules unchanged (card/theme/layout switch
discards; New now also discards, via `newCard`).

## Testing

- Dirty transitions: each mutating action sets it; save/load/new clear it.
- Guard: for both intents (new, open) × all three resolutions (save-first → intent
  executes and record persisted; discard → intent executes, nothing persisted;
  cancel → document unchanged, intent cleared). Save-first with a failing store keeps
  the document and shows the error.
- Theme switch: keeps `savedId`, preserves overlapping keys, marks dirty, discards
  fill session.
- Save as copy: new id ≠ old id, name suffixed, Builder now bound to the copy, both
  records in the archive.
- Gallery duplicate: two records, original untouched.
- Document bar: title fallback, dirty indicator appears/disappears.
