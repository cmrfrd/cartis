# Cartis — Card Studio

A local app for building custom trading cards: pick a template and fill a form
(Builder), free-code a card in TSX with an optional AI agent (Code Lab), turn a
photo of a person into stylized card art (Image Lab), and export print-ready
files. Everything runs on your machine; nothing is pushed anywhere.

## Run

```bash
bun install
bun run dev        # http://localhost:5173
```

The dev server **is** the app: the AI bridge endpoints (`/api/*`) exist only
under `bun run dev`. `bun run build` is kept as a compile smoke test, not a
deployment story.

Quality gates (run before every commit in this repo):

```bash
bun run verify     # biome ci + tsc --noEmit + vitest
bun run check      # auto-format + lint fixes
```

## Optional AI integrations

Both are off by default; the app is fully offline without them.

- **Real image generation** — flux-kontext-pro via Replicate:
  `REPLICATE_API_TOKEN=r8_… bun run dev`. Without it, a local canvas "stub
  stylizer" fakes the effect.
- **Code Lab agent** — [opencode](https://opencode.ai) writes card TSX:
  install opencode, run `opencode auth login` once, then optionally pick a
  model with `OPENCODE_MODEL=anthropic/claude-fable-5 bun run dev`.

## Vocabulary

- **Kit** — a style library of composable card part components (`src/cards/arcane`).
- **Template** — a registered card definition: form schema + defaults + art
  style prompt + renderer. The Builder's dropdown lists all registered templates.

## Adding a new card style

1. Create `src/cards/<kit>/` with your parts and a `Component` card
   (see `arcane/` — capital-letter methods are overridable subcomponents).
2. Define a `CardTemplate` (`fields`, `defaults`, `artStylePrompt`, `Render`).
3. Register it in `registerBuiltinTemplates()` (`src/cards/index.ts`) and
   export your parts from the barrel so the Code Lab can import them.
4. Done — the Builder dropdown, portrait styling, Image Lab style list, and
   Code Lab imports all pick it up from the registry.

## Printing

Exports are 750×1050 px = 2.5"×3.5" at 300 DPI (standard trading-card size).
Print at 100% scale on cardstock; for the holographic look, enable the Holo
toggle and print on holo/foil sticker paper.

## State architecture

Expressive-mvc only (no React idioms): views are `Component` classes, shared
stores (`ImageLibrary`, `CardArchive`) are adopted children of `AppShell`, and
persistence is IndexedDB. Cross-model access uses `get(Type)` context fields
with transitive subscription — see the expressive skills repo
(<https://github.com/gabeklein/expressive-mvc/tree/main/skills>) and the plan in
`docs/superpowers/plans/2026-07-31-cartis-card-studio.md`.
