# Themes & Layouts — data-model redesign

**Date:** 2026-08-01 · **Status:** approved (brainstorm 2026-08-01)

## Context

The card system's single flat concept, `CardTemplate`, blends three things: world/feel
(palette, prompt flavor, shared parts), the card-data vocabulary (fields/defaults), and
presentation (Render, artAspect). The strain is visible: `kitId: 'arcane'` is a grouping
string with no backing entity, `arcane-hero-fullart` is a spread of `arcane-hero` with two
overrides, and the Image Lab lists *templates* as art styles when the style is really the
world's look.

This redesign introduces two first-class concepts:

- **Theme** — a collection/world (à la an MTG set or Pokémon series): identity, palette,
  SVG assets, raw building components, shared card-data vocabulary, and a prose
  **look-and-feel prompt** that lets AI generate on-theme art and compose on-theme layouts.
- **Layout** — an explicit arrangement of a card face within a theme (classic
  portrait-plus-details vs. full-art showcase). Many layouts per theme.

## Decisions (locked during brainstorm)

1. **Code-defined themes, data-shaped manifest.** A theme remains a code module
   (components are TSX), but its manifest — id, name, description, look-and-feel prompt —
   is a plain data object validated by an effect Schema at registration. Fully
   data-defined/runtime-authorable themes are a separate future project.
2. **Clean break on saved data.** No migration, no compat decode. Old card sidecars fail
   the new row schema and are dropped by the existing lenient list decode. The user
   restarts `cartis-data/cards` from scratch.
3. **The look-and-feel prompt drives both AI surfaces now:** the art pipeline
   (Image Lab + portrait generation) and the Code Lab agent's context.
4. **Fields live on the theme, not the layout.** Both existing layouts edit the same data;
   theme-level fields make layout switching lossless. Layouts may override *defaults* and
   simply not render fields they don't use.
5. **Card types are deliberately deferred.** A future dimension (creature vs. spell with
   different fields and eligible layouts) can become `cardTypes` on the theme precisely
   because fields are theme-level today. Not modeled now.

## Model (`src/cards/types.ts`)

`CardTemplate` is retired. `CardData`, `FieldValue`, `FieldSpec`, `FieldCondition`,
`CardRenderProps`, `CardRenderer` are unchanged.

```ts
/** Pure data; validated by ThemeManifest schema at registration. */
interface ThemeManifest {
  id: string;           // 'arcane'
  name: string;         // 'Arcane'
  description: string;  // world blurb (shown in pickers)
  lookAndFeel: string;  // prose visual identity, consumed by AI pipelines
}

interface Theme {
  manifest: ThemeManifest;
  fields: readonly FieldSpec[];   // card-data vocabulary for the whole theme
  defaults: CardData;
  /** manifest.lookAndFeel + per-card palette flavor (e.g. essence artFlavor). */
  artStylePrompt: (data: CardData) => string;
  CardBack: CardRenderer;         // shared back, promoted from ad-hoc export
  layouts: readonly Layout[];     // ordered; layouts[0] is the default
}

interface Layout {
  id: string;                     // unique within the theme: 'classic', 'fullart'
  name: string;
  description: string;
  artAspect?: string;             // preferred replicate aspect for the art slot
  defaults?: Partial<CardData>;   // overrides on theme defaults
  Render: CardRenderer;
}
```

A `ThemeManifest` Schema lives in `src/contracts/theme.ts`; `registerTheme` decodes the
manifest and rejects duplicate theme ids or duplicate layout ids within a theme.

## Registry (`src/cards/registry.ts`)

Theme-keyed replacement for the template registry:

- `registerTheme(theme)` — validates manifest (Schema) + layout-id uniqueness, throws on
  duplicate theme id.
- `getTheme(id)`, `listThemes()`
- `getLayout(themeId, layoutId)` — throws on unknown theme or layout.
- `__clearThemesForTests()`

`registerBuiltinTemplates()` becomes `registerBuiltinThemes()` (main.tsx, test/setup.ts).

## Arcane split (`src/cards/arcane/`)

`template.ts` is replaced by `theme.ts` exporting `arcaneTheme`:

- **manifest:** id `arcane`, name `Arcane`, existing kit blurb as description,
  `lookAndFeel` distilled from today's shared prompt prose ("Fantasy oil painting …
  painterly oil brushwork, ornate trading card illustration") minus per-essence bits.
- **fields/defaults:** today's shared field list and defaults, unchanged.
- **artStylePrompt:** `lookAndFeel` + `paletteFor(essence).artFlavor` — same output
  strings as today.
- **CardBack:** `ArcaneCardBack`.
- **layouts:** `classic` (Render `ArcaneCard`, artAspect `3:2`) and `fullart`
  (Render `ArcaneFullArtCard`, artAspect `3:4`, defaults override
  `{ name: 'Nyra, Unbound', flavor: '' }`).

`palette.ts`, `parts.tsx`, `glyphs.tsx`, `typography.ts`, card TSX renders: untouched.

## Persistence & contracts

- `CardRecord` (`src/contracts/records.ts`) and `StoredCard`: `templateId: string` →
  `themeId: string` + `layoutId: string` (both required). Old sidecars drop on decode
  (decision 2) — no other code needed.
- `ImageRecord.styleId` keeps its name and string type; values are now theme ids or
  `'freestyle'`. Old records still decode; stale values are harmless.
- `AgentCardRequest` (`src/contracts/api.ts`) gains an optional theme-context block:
  `{ themeContext?: { lookAndFeel: string; palette: string; parts: string } }` — prose
  summaries, not component code.

## Consumers

- **BuilderView:** state `templateId` → `themeId` + `layoutId`. Sidebar shows two stacked
  selects, THEME then LAYOUT (theme select has one entry today — honest about the
  direction). Fields from theme; `Render`/`artAspect` from layout. Merged defaults
  (theme defaults + layout overrides) seed a NEW card only — switching layouts never
  re-applies defaults over data the user has entered (lossless switching is the point of
  theme-level fields). Save/load and `pendingCard` carry both ids.
- **PortraitSection:** prompt from `theme.artStylePrompt(data)`; `styleId` = theme id;
  aspect from the active layout.
- **ImageLabView:** style select lists `'freestyle'` + one entry per theme
  ("Arcane style"); prompt preview from `theme.artStylePrompt(theme.defaults)`.
- **GalleryView:** displays `themeId/layoutId`; open-in-builder passes both.
- **EditorView / agent bridge:** the editor includes the default theme's context block in
  its `AgentCardRequest`; `buildAgentPrompt` injects it so Code Lab generations are
  on-theme. (A Code Lab theme picker is future work.)
- **Untouched:** card renders, parts, CardSurface, textures, export pipeline, compile
  sandbox `MODULE_MAP`, starter code.

## Testing

- Registry tests → theme registry (register/get/list/getLayout, duplicate rejection,
  manifest validation failure).
- Contracts tests: ThemeManifest decode success/failure; CardRecord requires
  themeId/layoutId (old templateId row fails decode — asserting the clean break).
- Builder/gallery/images/portrait tests: id updates + the new two-select flow.
- One agentBridge test: theme context present in the built prompt.
- Gate throughout: `bun run verify`.

## Out of scope

Runtime/data-defined themes and theme authoring UI; card types; Code Lab theme picker;
any change to card visual output (renders are untouched — pixel output identical).
