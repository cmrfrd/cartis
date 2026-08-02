# Cartis — Card Studio

A local app for building custom trading cards: pick a **theme** and **layout**,
fill the card's arguments by hand or in conversation with an AI assistant
(Builder), generate on-theme card art from those arguments, and export
print-ready files (Gallery). Everything runs on your machine; nothing is
pushed anywhere.

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

## Concepts

- **Theme** — a collection/world (à la an MTG set): identity
  (`id`/`name`/`description`), a prose **look-and-feel** consumed by the AI
  pipelines, a shared card back, an optional per-card `artFlavor` (e.g. essence
  palette flavor), and its layouts. `src/cards/arcane` is the built-in example.
- **Layout** — how a card face organizes theme components, **parameterized by
  arguments** (`fields` + `defaults`): arcane ships `classic` (portrait +
  details, art 3:2) and `fullart` (full-bleed art, floating plates, art 3:4).
  Switching layouts preserves values for argument keys both layouts share.

The reference card for what the fullart layout should express lives at
`docs/reference/great-henge-reference.jpg` (see the design spec's field
mapping).

## The AI assistant

Two agent-backed features run through the dev-server bridge (both stream into
the **AI activity bar** at the bottom, mirrored to the terminal as
`[cartis:agent]` / `[cartis:image]` lines):

- **Fill with AI** (Builder) — a conversational session per card-editing
  episode: describe the card ("a fire mage with a phoenix companion") and the
  assistant fills the layout's arguments as a **targeted patch** (asked to
  change the title, it changes only the title). Every field stays
  hand-editable; later prompts see your edits (they always win). When a prompt
  concerns the art, the assistant sees the current art (vision) and can
  trigger generation or an edit of it. The session resets when you switch
  card, theme, or layout.
- **Art generation** (Builder art tools) — text-first: an LLM composes the
  image prompt from the theme's look-and-feel + the card's current argument
  values (element `fire` shapes the art), then flux-kontext-pro renders it.
  Attaching a photo (upload/webcam) steers identity/pose; picking from the
  library reuses existing art.

### Optional integrations (off by default; the app is fully offline without them)

- **Real image generation** — put `REPLICATE_API_TOKEN=r8_…` in `.env` (see
  `.env.example`). Without it, a local canvas "stub stylizer" fakes the effect
  (deterministic gradient art for text-first generations) and nothing leaves
  your machine.
- **AI fill + prompt composition** — [opencode](https://opencode.ai): install
  it, run `opencode auth login` once. Fill works best on a sonnet-class model —
  set `OPENCODE_MODEL=anthropic/claude-sonnet-4-6` (or better) in `.env`.

## Your data

Everything lives as real files under `./cartis-data` (gitignored):
`images/` and `exports/` hold the actual PNGs with a `.json` metadata sidecar,
`cards/` holds one editable JSON per saved card. Filenames come from the
record's name (`ember-duelist-4d356a.png`). Copy the folder to back up; edit
sidecars by hand and reload if you like.

Saved cards record their `themeId` + `layoutId`. Cards saved before the
themes/layouts migration used a `templateId` and are deliberately not
migrated — old rows fail decode and are skipped (clean break); delete
`cartis-data/cards/*` from that era if you want the folder tidy.

Gallery is the roundtrip surface: click a saved card to reopen it in the
Builder; saving again updates the **same** record.

## Adding a theme / adding a layout

1. Create `src/cards/<theme>/` with your parts and `Component` cards
   (see `arcane/` — capital-letter methods are overridable subcomponents).
2. Define a `Theme` object (`src/cards/types.ts`): identity + `lookAndFeel` +
   `CardBack` + `layouts` (each layout owns `fields`, `defaults`, `artAspect`,
   `Render`). Share one exported field list across layouts for lossless
   switching — `src/cards/arcane/theme.ts` is the worked example.
3. Register it in `registerBuiltinThemes()` (`src/cards/index.ts`).
4. Done — the Builder's theme/layout selects, AI fill context, and art
   pipeline all pick it up from the registry. A new layout is just another
   entry in an existing theme's `layouts` array.

## Printing

The preview is print-faithful: fonts are embedded, textures are pre-rasterized
bitmaps, and interactive effects (pointer foil/tilt) are stripped at export, so
the PNG is exactly what you saw at rest.

- Exports are 750×1050 px = 2.5"×3.5" at 300 DPI (600 DPI selectable).
- **Bleed + marks** adds a standard 1/8" bleed and corner crop marks for print
  shops; **Sheet 3×3** tiles nine copies on A4 with cut lines for home printing.
- **Show back** previews/exports the theme's card back for double-sided
  decks. For the holographic look, print on holo/foil sticker paper.

## State architecture

Expressive-mvc only (no React idioms): views are `Component` classes, shared
stores (`ImageLibrary`, `CardArchive`) are adopted children of `AppShell`, and
persistence is file-based (`./cartis-data`). Cross-model access uses `get(Type)`
context fields with transitive subscription — see the expressive skills repo
(<https://github.com/gabeklein/expressive-mvc/tree/main/skills>).

## Effect architecture

Business logic is in [Effect v3](https://effect.website) using
`@effect/platform` HttpClient (no HttpApi/HttpServer).

### Contracts layer — `src/contracts/`

Schemas (`effect` core `Schema`) + `Data.TaggedError` classes shared between
client and server. `errors.ts` is the canonical tagged-error registry;
`api.ts`, `records.ts`, `theme.ts`, `replicate.ts`, `opencode.ts`,
`activity.ts` are wire schemas for the bridge routes, theme identity/context,
and the SSE activity feed.

### Services and layers

| Service | Tag | Description |
|---|---|---|
| `StoreClient` | `cartis/StoreClient` | Browser: CRUD over `/api/store/:store` |
| `ImageProvider` | `cartis/ImageProvider` | Browser: generate art (stub or bridge/Replicate) |
| `AgentFill` | `cartis/AgentFill` | Browser: POST to `/api/agent/fill` (conversational fill) |
| `ActivityClient` | `cartis/ActivityClient` | Browser: SSE stream from `/api/activity` |
| `ActivityBus` | `cartis/ActivityBus` | Server: fan-out activity log (in-memory) |
| `FileStore` | `cartis/FileStore` | Server: binary + sidecar I/O under `cartis-data/` |
| `AgentClient` | `cartis/AgentClient` | Server: opencode session + prompt (text + vision parts) |
| `ReplicateSdk` | `cartis/ReplicateSdk` | Server: thin Effect wrapper over replicate SDK |
| `ReplicateClient` | `cartis/ReplicateClient` | Server: create prediction, poll, download |

### Browser runtime seam — `src/app/runtime.ts`

`runApp` / `runAppExit` / `forkApp` run Effects against the live layer. Tests
call `setAppLayer(customLayer)` to swap in stubs; production never calls it.
This is the only place where Effect exits into Expressive-mvc.

### Expressive ↔ Effect boundary

- **Snapshot reactive fields into locals** before entering `Effect.gen`; never
  read `this.*` inside a generator (reading inside Effect executes lazily, after
  the snapshot window closes, breaking the expressive dependency tracker).
- **Guard for destroyed models** with `if (this.get(null)) return` at the top
  of any async method — the model may be destroyed while an Effect is in flight.
- **`as` casts are banned on external data**; use Schema decode or type
  narrowing. Sanctioned exceptions: type-level bridges on validated or
  self-produced values (e.g. `StoreClient` generic bridges after Schema decode)
  and SDK-boundary narrowing where the import returns `unknown` (e.g.
  `client as unknown as OpencodeClient` in `agentBridge.ts`).

### Testing

Tests use `test/effect.ts` — a minimal `@effect/vitest`-compatible adapter over
vitest 4 + effect core. It exposes `it.effect` (TestClock-controlled),
`it.scoped` (body may require `Scope`), and `it.live` (real clock). When
`@effect/vitest` adds vitest 4 support, the adapter collapses to
`export * from '@effect/vitest'`. TestClock drives all polling tests
(ReplicateClient) so time advances are deterministic; agent behavior
(fill patches, art composition) is tested through stub `AgentClient` layers.
