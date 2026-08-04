# Routing + Agent Awareness — Design

**Date:** 2026-08-03
**Status:** Approved scope (user Q&A). Three parts: (1) URL paths + refresh
restoration, expressive-native (react-router considered and REVERSED — see
rationale); (2) agent document knobs: setLayout / setTheme / setHolo; (3) the
agent sees the rendered card every turn.

## 1. Routing — URL as a projection of expressive state

**Principle:** expressive is the ONLY state system. The URL never becomes a
second source of truth; it is a pure projection of `AppShell`, synced by one
module. (react-router was selected in scoping and reversed on engineering
review: its core behaviors — element switching, nested routes, loaders — are
all unused or actively harmful here, since panes deliberately stay mounted
across tab switches; using it "URL-only" would create a two-sources-of-truth
sync bridge. Zero-dep History API projection instead.)

### Route model + codec (`src/app/routes.ts`, pure)

```ts
type Route = { view: 'builder'; cardId?: CardIdT } | { view: 'gallery' };
parseRoute(pathname: string): Option<Route>   // '/', unknown → none
formatRoute(route: Route): string             // '/builder' | '/builder/<id>' | '/gallery'
```

Paths: `/builder`, `/builder/<cardId>`, `/gallery`. `/` and unknown paths
normalize to `/builder` via `replaceState` at boot. Vite's SPA fallback
already serves index.html for extensionless paths — no server change.

### Canonical state (`AppShell`)

`AppShell` is the single route-level authority: existing `view` plus new
`openCardId?: CardIdT` — set by `BuilderView` on load (savedId), cleared on
`newCard`, set on first save. This mirrors the existing downward
`pendingCard` seam with an upward report; no state is duplicated.

### Sync module (`src/app/history.ts`)

`syncHistory(shell: AppShell): () => void`, wired in `AppShell.mount`
(alongside the pendingCard consumer), using expressive listeners
(`shell.set('view', cb)`, `shell.set('openCardId', cb)`):

- **State → URL:** on view/openCardId change, if the formatted route differs
  from `location.pathname`: tab switches and card opens → `pushState`; the
  FIRST save of a new card (openCardId undefined → defined while already on
  `/builder`) → `replaceState` (saving is not a navigation).
  `document.title` syncs to `Cartis — <card name>` / `Cartis — Card Studio`.
- **URL → state:** `popstate` parses the path and applies it through the SAME
  guard paths the UI uses: view flips directly; a different cardId resolves
  the card from the archive and goes through `requestOpen` (dirty-guard
  included). Guard-cancel or unknown id → `replaceState` back to the ACTUAL
  state's route. A re-entrancy flag (`applying`) prevents projection loops.
- **Boot:** parse `location.pathname`; `/builder/<id>` waits for
  `archive.ready`, resolves the card, and hands it through the existing
  `pendingCard` seam (which also rehydrates the chat); missing/unknown id →
  normalize to `/builder`.

**Out of scope (user-scoped):** gallery sub-state in the URL, unsaved-draft
autosave (an unsaved new card does not survive refresh).

### Testing

Pure codec table (parse/format round-trips, unknown paths). Mounted
(happy-dom supports the History API): tab switch pushes `/gallery`; opening a
card pushes `/builder/<id>`; first save replaces; `popstate` flips tabs;
boot with `/builder/<id>` reopens the card; unknown path normalizes.

## 2. Agent document knobs — setLayout / setTheme / setHolo

Closes the reported "can't change the art layout" gap with the full deferred
knob set.

- **Transport:** `DocAction` union grows
  `{kind:'setLayout', layoutId: string}`, `{kind:'setTheme', themeId: string}`,
  `{kind:'setHolo', value: boolean}` (ids plain strings on the wire; the
  client validates against the registry — the bridge has no registry).
- **Options in the prompt:** `ChatTurnRequest` gains
  `docContext: Schema.optional(Schema.Struct({ themeId, themeOptions, layoutId,
  layoutOptions, holo }))` (ids + string arrays + boolean); `chatPromptText`
  renders it ("Layouts: classic, fullart (current: classic)…") and the
  CHAT_GUIDE documents the three new action kinds.
- **Appliers:** `ChatContext` gains `setLayout(layoutId): boolean`,
  `setTheme(themeId): boolean`, `setHolo(value): boolean` — implemented by
  BuilderView calling the SAME methods the UI buttons call (`pickLayout`,
  `pickTheme`, holo toggle); unknown id → `false` → note `action failed:
  setLayout` etc.
- **Ordering (the load-bearing rule):** settings knobs apply FIRST —
  synchronously in `applyTurnExit`, with the patch, BEFORE art starts — so
  "switch to fullart and generate art" renders art at the fullart aspect.
  Then art, then save/export (existing `runPostTurn`). Documented limitation:
  a same-turn patch validates against the PRE-turn field spec (harmless for
  arcane, whose layouts share one field list).
- **Display:** new `CARD_SETTINGS_TOOL = 'card_settings'` chip
  ("layout: fullart" / "theme: arcane" / "holo: on") via the shared
  materializer + DocActionChip.

## 3. Card vision — the agent sees the rendered card

Every turn auto-attaches a downscaled snapshot of the live preview
(user-scoped choice: always-on, no tool loop).

- `ChatContext.snapshotPreview(): Promise<{mime: string; dataUrl: string} | undefined>`
  — BuilderView renders `previewEl.current` via a new small pure fn in
  exportCard.ts (`renderPreviewSnapshot(node)`: html-to-image `toJpeg`,
  pixelRatio ~0.5, quality ~0.7 → ~50-100KB). Failure or absence (tests,
  unmounted preview) → `undefined`; the turn proceeds without it.
- `ChatTurnRequest` gains `previewDataUrl: Schema.optional(DataUrl)`. The
  bridge attaches it as an UNNAMED `PromptFile` (invisible in history, same
  contract as the art context), ordered after user attachments, before the
  art context.
- CHAT_GUIDE: "An image of the CURRENT rendered card is attached to every
  turn — use it to judge the visual state before deciding on changes."

### Testing

Bridge: previewDataUrl rides as an unnamed file part in the right position.
ThreadState: request carries the snapshot when the context provides one;
absent when it fails. Knobs: applier order (settings before art), registry
validation failure → note, chips render. Live browser e2e before merge:
"switch to the fullart layout" flips the layout selector + chip; a turn's
prompt visibly references the rendered card; refresh on `/builder/<id>`
restores card + chat; back/forward crosses tabs.

## Non-goals

Gallery sub-state URLs, draft autosave, on-request vision (tool loop / P4
MCP inversion), server-side routing.
