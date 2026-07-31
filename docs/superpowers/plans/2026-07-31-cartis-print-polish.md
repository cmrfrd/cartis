# Cartis Print Polish Implementation Plan

> Executed inline in-session (executing-plans, small steps, review checkpoints). Covers all 29 improvement items approved by the user. Governing principle: **the preview shows what the printed card will look like** — every effect must rasterize identically through the html-to-image export pipeline.

**Goal:** Make Arcane cards look like professionally printed trading cards — real fonts, printed textures, frame detail, physical foil, print-shop export options.

## Global decisions (locked)

- **No new runtime deps.** Fonts are vendored OFL woff2 files (`src/assets/fonts/` + LICENSE note), textures are procedural SVG `feTurbulence` data-URIs, glyphs/filigree are inline SVG components.
- **Fonts:** Cinzel 700 (titles/stats — Trajan-esque, caps-only by design), EB Garamond 400/400-italic/600 (rules/flavor/type line). Downloaded from fontsource via jsdelivr at build time of this plan, committed to the repo. `@font-face` in `theme.css`; tokens become `--font-display: 'Cinzel', …serif` and `--font-body: 'EB Garamond', …serif`. html-to-image embeds `@font-face` fonts into exports — this also fixes the font-drift class of export bugs.
- **Geometry unchanged:** `CARD_WIDTH/HEIGHT` stay 375×525 (total card incl. new black border); export math untouched by P1–P5.
- **Storage compatibility:** no `StoredCard` schema changes. New knobs (`foilStyle`, `collector`) are template **data fields** (free-form `CardData` — no migration needed). `holo: boolean` stays the on/off switch.
- **Expressive discipline unchanged** (skills idioms). Full-art card is a **separate `Component` composing kit parts** — NOT a `render()` subclass of `ArcaneCard` (expressive composes subclass renders as children; the base would drop them).
- **Interactivity that must not print:** pointer tilt/sheen writes CSS custom properties directly on the card root via `onPointerMove` (no state, no re-render); all vars default to a pleasing static rest state, so exports (pointer on the export button) always capture the rest look. Preview-stage backdrop/shadow live OUTSIDE the export target node.

## Tasks

### P1 — Typography (items 1–4)
- Create `src/assets/fonts/` (4 woff2 + LICENSE.md), `src/cards/arcane/typography.ts` (`titleSizeFor(name): number` pure fn, tested).
- `theme.css`: `@font-face` ×4, retarget `--font-display`/`--font-body`, add `--font-flavor`.
- `parts.tsx`: engraved title (tracking + dual text-shadow), small-caps type line, auto-fit title size, Cinzel stats/cost.
- Tests: `titleSizeFor` bounds; existing render tests stay green.

### P2 — Printed material (items 5–9, 11 + pinline from 10)
- Create `src/cards/base/textures.ts`: `svgTextureUrl(opts)` core + `PARCHMENT_TEXTURE`, `LINEN_TEXTURE`, `GRAIN_TEXTURE` data-URI constants + `HALFTONE_CSS` (repeating radial-gradient) + shared style objects (`plateSurface`, `inkRim`, `bevel`). Tested (valid data-URI, deterministic).
- `CardSurface`: black card border (`--card-border: 12px` padding layer) + gold pinline ring + linen texture on frame area + halftone overlay at ~3% opacity. `data-card-root` + holo overlay still cover the whole card.
- `parts.tsx`: plates get parchment background-image + ink-rim inset shadows + bevel shadows.
- Tests: textures module unit tests; CardSurface test extended for border layer.

### P3 — Identity details (items 12–16)
- Create `src/cards/arcane/glyphs.tsx`: 6 essence glyph SVG components (`EssenceGlyph` keyed by id) + `CornerFiligree`.
- `parts.tsx`: faceted rarity gem (conic-gradient + highlight), stat shield with metallic ring, type-line essence symbol slot, `ArcaneCollectorStrip`.
- `template.ts`: add `collector` text field (default `001/001 · Cartis Original`); `ArcaneCard`: watermark glyph behind rules text, filigree corners, collector strip render.
- Tests: glyph renders per essence, collector strip text, watermark presence.

### P4 — Foil system (items 17–20)
- `theme.css` + `CardSurface`/`HoloFoil`: layered foil (rainbow linear + radial galaxy sparkle + grain modulation), driven by `--px/--py` CSS vars (pointer-tracked via `onPointerMove` on card root; rest defaults). Remove time-based animation (deterministic exports).
- `HoloFoil` gains `variant?: 'full' | 'etched'`; etched masks out the art window (kit supplies mask rect). Mythic rarity adds prismatic edge glint ring.
- `template.ts`: `foilStyle` select data field (full/etched). `ArcaneCard` passes variant.
- Tests: HoloFoil variant markers, data-driven variant selection.

### P5 — Art & presence (items 21–26)
- `parts.tsx`: art window inner shadow. `template.ts`: artStylePrompt gains "visible canvas texture, painterly oil brushwork".
- Create `src/cards/arcane/ArcaneFullArtCard.tsx` + second template `arcane-hero-fullart` (art as full background, translucent plates) — registered in `registerBuiltinTemplates`.
- Create `src/cards/base/CardBack.tsx` (Cartis back: wordmark, glyph ring, textures).
- `CardSurface`: 3D tilt on pointer (CSS vars, rest = flat). Create `PreviewStage` in `src/ui/layout.tsx` (backdrop + floor shadow, outside export target); use in Builder + Code Lab previews. Builder gains Front/Back flip toggle (back is exportable).
- Tests: full-art template registered + renders; CardBack renders; builder flip.

### P6 — Print pipeline (items 27–29)
- `exportCard.ts`: `renderCardBlob(node, format, { dpi?: 300|600, bleed?: boolean })` — bleed pads with black + draws crop marks on a compositing canvas; `renderSheetBlob(node, { columns: 3, rows: 3 })` A4@300dpi with cut lines. Pure helpers (`bleedLayout`, `sheetLayout`) unit-tested.
- `ExportBar`: DPI select, bleed toggle, "Sheet 3×3" button.
- Tests: layout math, mocked-canvas composition calls, ExportBar wiring.

### Reviews
- **F** (after P2): browser + export screenshots — fonts embedded, textures rasterized.
- **G** (after P4): pointer foil interaction, etched/mythic variants, export rest-state.
- **H** (final): full walkthrough, preview-vs-export fidelity, README update, verify sweep, merge via finishing-a-development-branch.
