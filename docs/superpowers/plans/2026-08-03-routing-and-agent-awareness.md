# Routing + Agent Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** URL paths with refresh restoration as a pure projection of expressive state; agent knobs setLayout/setTheme/setHolo; per-turn card-render vision — per `docs/superpowers/specs/2026-08-03-routing-and-agent-awareness-design.md`.

**Architecture:** AppShell stays the ONLY route-level state authority (`view` + new `openCardId`); a pure codec (`src/app/routes.ts`) and one sync module (`src/app/history.ts`) project state → History API with microtask-coalesced writes, and apply popstate/boot URLs back through the existing guard seams (`pendingCard`/`requestOpen`). Agent knobs extend the DocAction transport and execute through the SAME BuilderView methods the UI buttons call; vision rides as an optional `previewDataUrl` attached unnamed by the bridge.

**Tech Stack:** effect Schema/Option, expressive listeners (`model.set(key, cb)`), History API (zero new deps), html-to-image `toCanvas`.

## Global Constraints

- `bun run verify` green after every task; check TRUE exit codes, never through pipes.
- ZERO new dependencies (react-router formally reversed in the spec).
- Expressive is the only state system; URL is a projection. Snapshot rule, `this.get(null)` guards, Option boundary rule, `Match.exhaustive` in client code.
- Coalescing rule verbatim: **one user action = ONE history entry** (microtask-batched writes).
- push vs replace verbatim: tab switches and card opens push; FIRST save of a new card (openCardId undefined→defined while view stays 'builder') replaces; popstate reconciliation and boot normalization replace.
- Knob ordering verbatim: settings knobs apply FIRST (synchronously with the patch, before art), then art, then save/export.
- Snapshot: taken AFTER the optimistic bubble renders; literal (captures showBack if shown); failure → turn proceeds without.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `feat/routing-agent-awareness`, ff-merge + push + delete at end.

---

### Task 1: Route codec (`src/app/routes.ts`)

**Files:** Create `src/app/routes.ts`; Test `src/app/routes.test.ts`.

**Interfaces (produces):**
```ts
export type RouteT = { view: 'builder'; cardId?: CardIdT } | { view: 'gallery' };
export function parseRoute(pathname: string): Option.Option<RouteT>;
export function formatRoute(route: RouteT): string;
```

- [ ] Failing tests (table): `/builder`→builder; `/builder/abc`→builder+cardId 'abc'; `/gallery`→gallery; `/`, `/nope`, `/builder/a/b`, `/gallery/x` → none; format round-trips all three shapes; trailing slash tolerated (`/builder/` → builder).
- [ ] Implement: split pathname on '/', filter empties; `[]`→none (boot normalizes), `['builder']`, `['builder', id]` (CardId.make), `['gallery']`; else none.
- [ ] `bun run verify` green; commit `feat(app): pure route codec`.

### Task 2: `openCardId` on AppShell + BuilderView reporting

**Files:** Modify `src/app/AppShell.tsx` (field), `src/builder/BuilderView.tsx` (`loadCard`/`newCard`/`saveCard`/`saveAsCopy` report); Test `src/builder/builder.test.tsx`.

**Interfaces (produces):** `AppShell.openCardId?: CardIdT` — set to `card.id` in loadCard, `saved.id` in saveCard/saveAsCopy success, `undefined` in newCard.

- [ ] Failing test: mounted — open a card via `shell.pendingCard` → `shell.openCardId === card.id`; `requestNew` (clean doc) → undefined; save → defined.
- [ ] Implement: `openCardId?: CardIdT = undefined;` on AppShell; in BuilderView the four write sites (`this.shell && (this.shell.openCardId = …)`).
- [ ] Verify green; commit `feat(app): AppShell.openCardId — upward route-state report`.

### Task 3: History sync (`src/app/history.ts`)

**Files:** Create `src/app/history.ts`; Modify `src/app/AppShell.tsx` (wire in mount); Test `src/app/history.test.tsx` (mounted, happy-dom History API).

**Interfaces (produces):** `export function syncHistory(shell: AppShell): () => void` — returns cleanup (removes popstate listener + expressive listeners).

Behavior (from spec, all in this one module):
- `routeOf(shell): RouteT` = `{view: shell.view, ...(view==='builder' && openCardId ? {cardId} : {})}`.
- **Coalesced projection:** listeners on `view` + `openCardId` schedule ONE `queueMicrotask(reconcile)` (dedup flag). `reconcile(mode)`: format route; if `location.pathname` differs → `history.pushState`/`replaceState(null, '', path)`; replace when mode==='replace' OR the first-save rule (prev route builder-no-card → builder-with-card with view unchanged); else push. Track `prevRoute` after each write/apply. Sync `document.title` (`Cartis — ${cardName}` via `shell.archive.cards` lookup, else `Cartis — Card Studio`).
- **popstate:** parse; none → reconcile('replace') (normalize). Some: set `applying=true`; apply view; if cardId differs from openCardId → find in `archive.cards`; found → `shell.pendingCard = card` (guard-integrated consumption); missing → nothing; `applying=false`; then `queueMicrotask(() => reconcile('replace'))` — if state followed, URL matches (no write); guard-pending/cancel/unknown → URL snaps back to actual state (the documented bounce).
- **Boot:** parse `location.pathname`; none → `replaceState(formatRoute(routeOf(shell)))`. builder+cardId → set view; when `archive.ready` (immediate check + `archive.set('ready', cb)` once) find card → `pendingCard = card`; unknown → reconcile('replace'). gallery → `shell.view='gallery'`.
- `applying` flag: state listeners skip scheduling while popstate/boot applies (loop-free).

- [ ] Failing mounted tests: (a) tab switch → ONE new entry `/gallery` (compare `history.length` where reliable, else spy `pushState`); (b) gallery-open (pendingCard + view in one action) → exactly ONE pushState call with `/builder/<id>` (spy on History.prototype.pushState); (c) first save → replaceState to `/builder/<id>`, no push; (d) `popstate` after tab push flips `shell.view` back; (e) boot with `location` at `/builder/<id>` + seeded memory archive → card opens (name in form), URL kept; (f) boot at `/unknown` → replaceState `/builder`.
- [ ] Implement + wire `syncHistory(this)` in AppShell.mount (compose cleanups with the pendingCard consumer).
- [ ] Verify green; commit `feat(app): expressive-native URL projection (coalesced history sync + deep-link boot)`.

### Task 4: Agent knobs — transport + prompt + appliers

**Files:** Modify `src/contracts/api.ts` (DocAction union + DocContext + ChatTurnRequest.docContext), `src/contracts/materialize.ts` (CARD_SETTINGS_TOOL chip), `src/server/agentBridge.ts` (CHAT_GUIDE + chatPromptText docContext line), `src/chat/ThreadState.ts` (ChatContext members + knob partition ordering), `src/builder/BuilderView.tsx` (appliers + docContext in chatContext), `src/chat/MessageView.tsx` (chip labels); Tests: contracts, materialize, agentBridge, ThreadState, ThreadPanel.

**Interfaces (produces):**
```ts
// api.ts
DocAction |= { kind:'setLayout', layoutId: string } | { kind:'setTheme', themeId: string } | { kind:'setHolo', value: boolean }
export const DocContext = Schema.Struct({ themeId: Schema.String, themeOptions: Schema.Array(Schema.String), layoutId: Schema.String, layoutOptions: Schema.Array(Schema.String), holo: Schema.Boolean });
ChatTurnRequest.docContext = Schema.optional(DocContext)
// ThreadState ChatContext
setLayout(layoutId: string): boolean; setTheme(themeId: string): boolean; setHolo(value: boolean): boolean;
// materialize
export const CARD_SETTINGS_TOOL = 'card_settings';
```

- [ ] Failing tests: DocAction decodes the three kinds + drops mistyped (`{kind:'setLayout'}` without layoutId); materializer emits `card_settings` chips; chatPromptText contains `Layouts: classic, fullart (current: classic)` when docContext present; ThreadState: `setLayout` applied SYNCHRONOUSLY before `runArt` starts (order array: knob → art → save); failed knob (`setLayout` returns false) → note `action failed: setLayout`; BuilderView applier flips `layoutId` via a real registry layout and rejects unknown ids.
- [ ] Implement: partition in `applyTurnExit` — knobs (`setLayout|setTheme|setHolo`) run synchronously right after `applyPatch`, in array order, each failure noting `action failed: <kind>`; remaining actions (save/copy/export) go to `runPostTurn` as today. BuilderView: `setLayout` validates against `getTheme(this.themeId).layouts`, calls `pickLayout`; `setTheme` against `listThemes()`, calls `pickTheme`; `setHolo` sets + dirty. `chatContext()` gains `docContext: { themeId, themeOptions: listThemes().map(t=>t.id), layoutId, layoutOptions: theme.layouts.map(l=>l.id), holo }`. CHAT_GUIDE documents the kinds; chatPromptText renders the options line. MessageView DocActionChip labels: `layout: <id>` / `theme: <id>` / `holo: on|off` (kind-discriminated from argsText).
- [ ] Verify green; commit `feat(chat): agent layout/theme/holo knobs with option-aware prompt`.

### Task 5: Card vision — per-turn preview snapshot

**Files:** Modify `src/export/exportCard.ts` (`renderPreviewSnapshot`), `src/contracts/api.ts` (`ChatTurnRequest.previewDataUrl: Schema.optional(DataUrl)`), `src/chat/ThreadState.ts` (ChatContext.snapshotPreview + send/regenerate wiring), `src/builder/BuilderView.tsx` (impl), `src/server/agentBridge.ts` (unnamed PromptFile + CHAT_GUIDE line); Tests: agentBridge, ThreadState.

**Interfaces (produces):**
```ts
// exportCard.ts
export function renderPreviewSnapshot(node: HTMLElement): Effect.Effect<string, ExportError>; // jpeg data-URL, pixelRatio 0.5, quality 0.7
// ChatContext
snapshotPreview(): Promise<{ mime: string; dataUrl: string } | undefined>;
```

- [ ] Failing tests: bridge — request with `previewDataUrl` → files order `[user attachments…, {mime:'image/jpeg', url:<preview>} (unnamed), {…art} (unnamed)]`; ThreadState — stub context returning a snapshot → request carries `previewDataUrl`; snapshot promise resolving `undefined` → field absent; bubble appended BEFORE snapshot resolves (assert messages non-empty while snapshot promise still pending via a deferred).
- [ ] Implement: send(): push bubble → `const snap = await ctx.snapshotPreview()` (try/catch → undefined) → request `...(snap ? { previewDataUrl: DataUrl.make(snap.dataUrl) } : {})`. BuilderView: `snapshotPreview` runs `renderPreviewSnapshot(previewEl.current)` via `runAppExit`, Exit-matched to undefined on failure. Bridge `runChatTurn`: `...(req.previewDataUrl ? [{ mime: 'image/jpeg', url: req.previewDataUrl }] : [])` between attachments and art. CHAT_GUIDE: 'An image of the CURRENT rendered card is attached to every turn — use it to judge the visual state before deciding on changes.'
- [ ] Verify green; commit `feat(chat): per-turn rendered-card vision (unnamed preview attach)`.

### Task 6: Docs, sweep, live browser e2e, merge

- [ ] README: routing paragraph (URLs, refresh restore, back/forward) + knob/vision bullets in the chat section.
- [ ] Live browser e2e (chrome-devtools): tab switch changes URL; open card → `/builder/<id>`; REFRESH restores card + chat; back/forward crosses tabs; chat "switch to the fullart layout" flips the layout select + `card_settings` chip; a vision turn ("what does the card look like right now?") answers from the render.
- [ ] `bun run verify` + `bun run build`; merge ff to main, push, delete branch, update memory.

## Self-review

Spec coverage: codec (T1), openCardId (T2), sync+boot+coalesce+title (T3), knobs+ordering+prompt (T4), vision+ordering (T5), e2e+docs (T6). Type consistency: `RouteT`/`syncHistory`/`CARD_SETTINGS_TOOL`/`snapshotPreview` used consistently. The guard-bounce behavior is emergent from reconcile('replace') after popstate — no special case, as designed.
