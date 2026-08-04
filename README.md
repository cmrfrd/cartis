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

The app has real URLs — `/builder`, `/builder/<cardId>`, `/gallery` — as a
pure projection of app state (no router dependency): refreshing on a saved
card reopens it (chat conversation included), back/forward crosses tabs and
cards through the same unsaved-changes guard the UI uses, and the tab title
follows the open card.

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

Two agent-backed features run through the dev-server bridge. All agent activity
now streams into the **chat sidebar** (right of the Builder), mirrored to the
terminal as `[cartis:agent]` / `[cartis:image]` lines — there is no separate
activity bar.

- **Chat sidebar** (Builder, right) — a ChatGPT-style conversation that edits
  the open card. It speaks assistant-ui's model (threads of ordered parts, tool
  calls with visible status, edit/regenerate/branch, a composer) but every
  affordance is backed by a real [opencode](https://opencode.ai) **session**,
  one per card. Ask it to rename the title, rewrite the ability, or generate
  art: field changes arrive as a **targeted patch** applied to the document and
  shown as a `card_patch` chip; art requests stream progress as a
  `card_generate_art` strip. Every field stays hand-editable and later turns see
  your edits (they always win). The full capability set is native:
  - **Attachments** — the composer's `+` button, pasting into the input, and
    dropping files on the panel all attach **images + text files**
    (`image/*`, `text/*`, `application/json`, `.md`; 8 MB / 6 per message —
    rejections surface in a dismissible note strip). Images reach the model as
    vision ("make the art like this reference"); text files as readable
    context. Attachments persist in the session and survive reopen/restart.
  - **Document actions** — the agent has the author's own document powers:
    "looks good, save it" persists the card (Save / Save as copy), and
    "export a print PNG" runs the real export pipeline (`png` 300 DPI /
    `print` 600 DPI + bleed / `sheet` 3×3 A4), sequenced AFTER any art
    generation in the same turn so exports capture the new art. It can also
    turn the document knobs — "make it fullart" / switch theme / toggle holo
    — which apply BEFORE art so a same-turn generation uses the new layout's
    aspect. Each action shows a receipt chip in the thread.
  - **The agent sees the card** — every turn attaches a downscaled snapshot
    of the live preview as vision, so "what does it look like?" and layout
    judgments work from the actual render (literally what you see, card back
    included if you're showing it).
  - **Cancel** a running turn (Stop button → session abort; the turn finalizes
    incomplete).
  - **Edit** an earlier message — this *forks* the session (native branching) so
    the original survives, reverts to that point, and resends.
  - **Regenerate** the last reply (revert + replay; offered on the last reply
    only).
  - **‹ n/m › branch arrows** on the message where sibling branches diverge —
    step between a session's forks in place (ChatGPT-style).
  - **Permission prompts** (Allow / Deny) when the agent requests one.
  - A failed turn shows an inline error strip (opencode down / not
    authenticated surfaces here on the first turn — there is no preflight).
  - Assistant replies render as **markdown**; the panel is **drag-resizable**
    (left edge, 340–600px, double-click resets).
  The conversation **persists per card**: a saved card stores its
  `chatSessionId` in `cartis-data/`, and reopening rehydrates the thread from
  opencode (surviving dev-server restarts). Copies (Save as copy / gallery
  Duplicate) start a fresh chat. Switching theme/layout keeps the session — it
  belongs to the card, not the theme.
- **Art generation** (Builder art tools + chat) — text-first: an LLM composes
  the image prompt from the theme's look-and-feel + the card's current argument
  values (element `fire` shapes the art), then flux-kontext-pro renders it.
  Attaching a photo (upload/webcam) steers identity/pose; picking from the
  library reuses existing art.

Under the hood the card's chat is the full assistant-ui thread model expressed
natively in effect Schema + Effect services + expressive, with opencode as the
runtime — see `docs/superpowers/specs/2026-08-03-card-chat-panel-design.md`.
Card actions ride a v1 JSON transport materialized into real ToolCall parts by a
single shared materializer (`src/contracts/materialize.ts`), used identically by
live turns and rehydrated history, so raw JSON never reaches the UI.

### Optional integrations (off by default; the app is fully offline without them)

- **Real image generation** — put `REPLICATE_API_TOKEN=r8_…` in `.env` (see
  `.env.example`). Without it, a local canvas "stub stylizer" fakes the effect
  (deterministic gradient art for text-first generations) and nothing leaves
  your machine.
- **Chat + prompt composition** — [opencode](https://opencode.ai): install
  it, run `opencode auth login` once. The chat works best on a sonnet-class
  model — set `OPENCODE_MODEL=anthropic/claude-sonnet-4-6` (or better) in
  `.env`.

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

The Builder is a document editor: the **document bar** at the top of the form
shows the open card's title and status (New card / Saved / ● Unsaved changes)
with **New**, **Save**, and **Save as copy** actions. New and opening another
card while you have unsaved changes ask first — **Save first / Discard /
Cancel**. Switching theme or layout edits the open document (values for shared
argument keys carry over); New is the only fresh start. The Gallery has two
tabs: a unified, searchable **Saved cards** view — tile view by default (each
entry shows the full live card face, mini-rendered) with a list toggle; both
show the same info: name, theme · layout, actions, and the card's renders
grouped beneath it (renders exported before card-linking existed appear under
**Other renders**). Click to reopen in the Builder (saving again updates the
**same** record), **Duplicate** for a fresh copy — and the image **Library**.
Every agent action (steps, tool calls, thinking, writing progress) streams
into the chat sidebar while a turn or art generation runs.

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
`api.ts`, `records.ts`, `theme.ts`, `replicate.ts`, `opencode.ts` are wire
schemas for the bridge routes, theme identity/context, and opencode reads.
`thread.ts` is the canonical chat vocabulary (`ThreadPart`/`ThreadMessage`/
`ThreadEvent`/`ThreadSummary`) — it imports no opencode shapes (the bridge maps
opencode → thread; the client consumes thread only). `materialize.ts` is the one
shared v1-transport materializer.

### Services and layers

| Service | Tag | Description |
|---|---|---|
| `StoreClient` | `cartis/StoreClient` | Browser: CRUD over `/api/store/:store` |
| `ImageProvider` | `cartis/ImageProvider` | Browser: generate art (stub or bridge/Replicate) |
| `ChatThread` | `cartis/ChatThread` | Browser: session passthrough (turn/history/abort/revert/regenerate/fork/siblings/permission) |
| `ChatEvents` | `cartis/ChatEvents` | Browser: `Stream<ThreadEvent>` over `/api/chat/events` (SSE) |
| `ThreadBus` | `cartis/ThreadBus` | Server: fan-out `ThreadEvent` stream (in-memory) |
| `FileStore` | `cartis/FileStore` | Server: binary + sidecar I/O under `cartis-data/` |
| `AgentClient` | `cartis/AgentClient` | Server: opencode session ops (create/prompt/messages/abort/revert/fork/children) |
| `ReplicateSdk` | `cartis/ReplicateSdk` | Server: thin Effect wrapper over replicate SDK |
| `ReplicateClient` | `cartis/ReplicateClient` | Server: create prediction, poll, download |

The card's chat store is `ThreadState` (an expressive State adopted by
BuilderView): it folds `ChatEvents` into a message list via the pure
`src/chat/fold.ts` reducer, runs turns through the Effect boundary, and applies
the resulting patch/art to the document through an injected `ChatContext`.

### Type discipline

Beyond Schema-decoded boundaries, the codebase enforces (spec:
`docs/superpowers/specs/2026-08-03-type-safety-and-contract-hardening-design.md`):

- **Branded ids + validated strings** (`src/contracts/ids.ts`): `CardId`,
  `SessionId`, `ThemeId`, `LayoutId`, `MessageId`, … are nominal brands — the
  compiler rejects passing one where another is expected. `DataUrl` is a
  refined brand: "valid non-empty base64 data URL" is part of the type (the
  empty-`input_image` bug class is unrepresentable). `Timestamp` is a
  non-negative integer. The Replicate token flows as `Redacted<string>` and
  cannot stringify into a log.
- **The Option boundary rule**: pure logic and service returns speak
  `Option<T>` (composition); expressive reactive fields and JSX props speak
  `T | undefined` (the DOM can't consume an Option, and boxing defeats
  value-equality change-skips). Conversion happens exactly once, at the seam,
  via `Option.getOrUndefined`.
- **`Match.exhaustive`** replaces tagged-union switches — a new
  `ThreadEvent`/`ThreadPart`/field-kind variant fails `tsc` instead of
  silently falling through. (The bridge's raw-wire `part.type` dispatch stays
  a tolerant switch by design.)
- **Typed errors end-to-end**: `src/contracts/errors.ts` is the documented
  catalog (tag → producer → HTTP status → UX → propagation). A server failure
  crosses the wire as `ErrorBody { tag, error }` with a mapped status, and the
  client's typed error carries the server tag as `remoteTag`.
- **Constraint-honoring agent patches**: `schemaFromFields` enforces each
  field's `min`/`max`/`options`, which travel on the wire `FieldSummary` — a
  chat turn cannot set `cost: 999` or an out-of-set select value.

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
