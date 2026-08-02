# Themes & Layouts — data-model + builder redesign

**Date:** 2026-08-01 · **Revised:** 2026-08-02 (user feedback round 1) · **Status:** in review

## Context

The card system's single flat concept, `CardTemplate`, blends three things: world/feel
(palette, prompt flavor, shared parts), the card-data vocabulary (fields/defaults), and
presentation (Render, artAspect). The strain is visible: `kitId: 'arcane'` is a grouping
string with no backing entity, `arcane-hero-fullart` is a spread of `arcane-hero` with two
overrides, and the Image Lab lists *templates* as art styles when the style is really the
world's look.

This redesign introduces two first-class concepts, and reshapes the app around them:

- **Theme** — a collection/world (à la an MTG set or Pokémon series): identity, palette,
  SVG assets, raw building components, and a prose **look-and-feel prompt** that lets AI
  generate on-theme art and fill on-theme cards.
- **Layout** — how a card face organizes a set of components, **parameterized by
  arguments** (name, element, ability text, art, …). Many layouts per theme.

Alongside the model change, the app itself changes: the Code Lab is removed, the Builder
gains an AI fill flow, card-art generation becomes an explicit LLM-composed step driven by
the layout's arguments, and the Gallery becomes a true edit-roundtrip surface.

## Decisions

1. **Code-defined themes, data-shaped identity.** A theme remains a code module
   (components are TSX), but its identity fields — `id`, `name`, `description`,
   `lookAndFeel` — are plain data on the theme object, validated by an effect Schema at
   registration. (No separate "manifest" wrapper — the look-and-feel prompt is simply part
   of the theme.) Fully data-defined/runtime-authorable themes are a future project.
2. **Clean break on saved data.** No migration, no compat decode. Old card sidecars fail
   the new row schema and are dropped by the existing lenient list decode. `cartis-data/cards`
   restarts from scratch.
3. **Layouts own their arguments.** A layout declares the argument spec it renders
   (`fields` + `defaults`, reusing the existing `FieldSpec` machinery). Layouts in the same
   theme share field definitions through ordinary code reuse (the theme module exports its
   common field list). Switching layouts preserves values for argument keys both layouts
   share; keys the new layout doesn't declare are simply not rendered or edited.
4. **Art is a function of the layout's arguments, composed by an LLM.** No more static
   per-template `artStylePrompt`. See "AI pipelines" below.
5. **The Code Lab is removed.** The opencode agent infrastructure is *repurposed* (AI form
   fill, art-prompt composition), not deleted.
6. **Card types are deliberately deferred.** If themes later need creature-vs-spell style
   variation, that becomes a grouping above layouts; not modeled now.

## Model (`src/cards/types.ts`)

`CardTemplate` is retired. `CardData`, `FieldValue`, `FieldSpec`, `FieldCondition`,
`CardRenderProps`, `CardRenderer` are unchanged.

```ts
interface Theme {
  // -- data-shaped identity, Schema-validated at registration --
  id: string;           // 'arcane'
  name: string;         // 'Arcane'
  description: string;  // world blurb (shown in pickers)
  lookAndFeel: string;  // prose visual identity, consumed by AI pipelines
  // -- code --
  CardBack: CardRenderer;         // shared back, promoted from ad-hoc export
  layouts: readonly Layout[];     // ordered; layouts[0] is the default
  /** Optional per-card flavor derived from data (e.g. essence artFlavor from the palette),
   *  appended to the LLM art-prompt context. */
  artFlavor?: (data: CardData) => string;
}

interface Layout {
  id: string;                     // unique within the theme: 'classic', 'fullart'
  name: string;
  description: string;
  fields: readonly FieldSpec[];   // the ARGUMENTS this layout takes
  defaults: CardData;             // seed values for a new card
  artAspect?: string;             // preferred replicate aspect for the art slot
  Render: CardRenderer;           // organizes theme components, consumes the arguments
}
```

The theme-identity Schema (`ThemeIdentity`) lives in `src/contracts/theme.ts`;
`registerTheme` decodes it and rejects duplicate theme ids or duplicate layout ids within
a theme.

## Registry (`src/cards/registry.ts`)

- `registerTheme(theme)` — validates identity (Schema) + layout-id uniqueness.
- `getTheme(id)`, `listThemes()`, `getLayout(themeId, layoutId)`.
- `__clearThemesForTests()`; `registerBuiltinTemplates()` → `registerBuiltinThemes()`
  (main.tsx, test/setup.ts).

## Arcane split (`src/cards/arcane/`)

`template.ts` → `theme.ts` exporting `arcaneTheme`:

- identity: id `arcane`, name `Arcane`, existing kit blurb, `lookAndFeel` distilled from
  today's shared prompt prose ("Fantasy oil painting … painterly oil brushwork, ornate
  trading card illustration") minus per-essence bits.
- `artFlavor`: `paletteFor(essence).artFlavor` (per-card palette flavor, as today).
- `CardBack`: `ArcaneCardBack`.
- layouts `classic` (Render `ArcaneCard`, artAspect `3:2`) and `fullart` (Render
  `ArcaneFullArtCard`, artAspect `3:4`); both declare the same field list (exported once
  from the theme module), with fullart's defaults overriding `{ name: 'Nyra, Unbound',
  flavor: '' }`.
- `palette.ts`, `parts.tsx`, `glyphs.tsx`, `typography.ts`, card TSX renders: untouched.

## AI pipelines (opencode LLM + replicate, both via the bridge)

Two agent-backed features replace the Code Lab's code generation. Both receive **theme
context** = `{ lookAndFeel, palette summary, layout argument spec }` as prose/JSON, never
component code.

**1. AI form fill (Builder).** New bridge endpoint `POST /api/agent/fill`:
request `{ themeContext, fields: FieldSpec-shaped summary, currentData, userPrompt }` →
opencode session → response decoded against a Schema derived from the field spec →
`{ data: CardData }`. The Builder merges returned values into the form; every field
remains hand-editable afterwards; re-prompting adjusts the current values (the LLM sees
`currentData`).

**2. LLM-composed art prompts.** Card-art generation is no longer a fixed template
string. `POST /api/image/generate` gains a composition step ahead of replicate: the bridge
gives the LLM (a) a base instruction ("you are writing an image-generation prompt for a
trading-card art slot"), (b) the theme's `lookAndFeel` + `artFlavor(data)`, (c) the
layout's current argument values (so element `fire` shapes the art), and (d) the source
image, if one was provided. The LLM returns the final generation prompt; the bridge then
runs the existing replicate create-and-poll with it. Both steps emit activity events
(prompt composed → generation progress). The stub provider path skips composition and
keeps its deterministic behavior for tests/offline.

## App changes

**Code Lab removal.** Delete `src/editor/` (EditorView, CodePane, compile, Sandbox,
starter) and its tests; AppShell drops to three tabs (Builder / Image Lab / Gallery);
`codemirror`, `@codemirror/lang-javascript`, and `sucrase` leave package.json. The
`/api/agent/card` route and `buildAgentPrompt`/`extractCode` die with it; `AgentClient`
(opencode session machinery) stays and now serves `/api/agent/fill` and art-prompt
composition. `AgentApi` (browser service) is reshaped to `fill(...)` accordingly.

**Builder.**
- Sidebar: THEME select, LAYOUT select, then an **AI prompt field above the form** with a
  "Fill with AI" action (busy/note states per the standard boundary pattern). Below it,
  the ordinary form renders the layout's arguments.
- A new card immediately renders the layout's defaults in the preview — a real base card —
  with an **empty art placeholder** in the art slot (no auto-generation).
- Art generation is explicit: a "Generate art" action on the art field (PortraitSection)
  runs the LLM-composed pipeline above, using the current argument values; the AI fill
  flow may also trigger it as part of a prompted request. A source photo remains optional
  input to the composition step.
- State: `templateId` → `themeId` + `layoutId`; switching layouts preserves overlapping
  argument values (decision 3).

**Gallery roundtrip.** Clicking a saved card opens it in the Builder (existing
`pendingCard` mechanism, made the card's primary click action): theme + layout + data
load, `savedId` is retained, and Save **updates the same record** rather than duplicating.
"Saved" list entries show `themeId/layoutId`.

**Image Lab.** Kept as-is functionally; its style picker lists themes ("Arcane style" +
"Freestyle") instead of templates, and theme styles route through the same LLM composition
step with the theme context (freestyle remains a raw user prompt).

## Persistence & contracts

- `CardRecord` / `StoredCard`: `templateId` → required `themeId` + `layoutId`. Old
  sidecars drop on decode (decision 2) — no other code needed.
- `ImageRecord.styleId` keeps its name/type; values become theme ids or `'freestyle'`.
- `src/contracts/theme.ts`: `ThemeIdentity` schema + the theme-context block shape shared
  by fill and image-generate requests.
- `src/contracts/api.ts`: `AgentCardRequest/Response` replaced by `AgentFillRequest/Response`;
  `ImageGenerateRequest` gains theme-context + argument-values fields for composition.

## Testing

- Registry: register/get/list/getLayout, duplicate rejection, identity-schema failure.
- Contracts: ThemeIdentity decode success/failure; CardRecord requires themeId/layoutId
  (old templateId row fails decode — asserting the clean break); AgentFill shapes.
- Bridge: `/api/agent/fill` happy path + malformed-LLM-output failure (Schema rejects);
  image-generate composition step (stub LLM layer) feeding replicate; activity events for
  both steps.
- Builder: AI fill merges values and leaves fields editable; layout switch preserves
  overlapping values; empty art placeholder on new card; explicit generate action.
- Gallery: click-to-open roundtrip, re-save updates in place.
- Removals: no `src/editor` references; AppShell renders three tabs.
- Gate throughout: `bun run verify`.

## Out of scope

Runtime/data-defined themes and theme-authoring UI; card types; multi-theme Code Lab
replacement (code-level layout authoring is gone until a future need); any change to card
visual output (renders untouched — pixel output identical).
