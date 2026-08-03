# Agent-Action Log + Unified Saved Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream every agent action into the activity log (specs: `2026-08-02-agent-activity-observability-design.md`) and merge Renders into a searchable, grouped Saved cards view (`2026-08-02-unified-saved-cards-design.md`).

**Architecture:** (A) A session-scoped watcher in the bridge subscribes to the opencode SDK's event stream (`client.event.subscribe` + AbortController via `Effect.acquireRelease`), maps decoded events to ActivityBus lines through a pure `mapAgentEvent(event, state, now)` reducer (dedupe + throttle live in the state), exposed as an `AgentClient.withActivity(sessionId, effect)` capability — identity in test layers; `runFillAgent` regains a 5s heartbeat. (B) `ExportRecord` gains optional `cardId`; the Builder passes `savedId` on export; the Gallery drops to two tabs with pure `groupExports`/`matchesQuery` helpers driving a unified, searchable Saved cards view.

**Tech Stack:** effect 3.22 (Schema lenient decode, acquireRelease, forkScoped, Schedule), @opencode-ai/sdk 1.18 `event.subscribe({ onSseEvent, signal })`, expressive components, vitest 4 + test/effect.ts.

## Global Constraints

- Both specs' Engineering-requirements sections are binding: no `any`/`!`/`as`-on-external-data; SSE payloads Schema-decoded leniently (unknown events skipped); pure helpers extracted and unit-tested; TestClock for the heartbeat; deterministic `now`-parameter throttle tests; transition-dedupe (same `callID` running twice → one line); watcher aborted when the prompt settles.
- Gate after EVERY task: `bun run verify` green.
- Push allowed; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Agent-action watcher + heartbeat (Feature A)

**Files:**
- Modify: `src/contracts/opencode.ts` (add `AgentEvent` lenient schema)
- Modify: `src/server/agentBridge.ts` (`mapAgentEvent` + state, `OpencodeClient.event`, `withActivity` on AgentClient + live impl, heartbeat in `runFillAgent`, compose wrapped)
- Test: `src/server/agentBridge.test.ts`

**Interfaces:**
- Produces: `AgentEvent` schema (contracts/opencode.ts): lenient struct over `{ type: string, properties?: { part?: { type?, sessionID?, messageID?, callID?, tool?, state?: { status?, title?, error?, time?: { start?, end? } } }, error?: unknown } }` — only fields read.
- `mapAgentEvent(event: unknown, state: WatchState, now: number): { message?: string; state: WatchState }` with `WatchState = { runningCalls: ReadonlySet<string>; reasonedMessages: ReadonlySet<string>; lastTextLogAt: number; textChars: number }` (exported for tests; `initialWatchState`).
- `AgentClient` shape gains `withActivity<A, E>(sessionId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E>` — live forks the watcher scoped around `effect`; ALL stub layers implement it as `(_s, e) => e`.
- `runFillAgent`: prompt call becomes `agent.withActivity(sessionId, agent.prompt(...))` + `Effect.scoped` heartbeat (`still working… (${secs}s)`, `Schedule.spaced('5 seconds')`, elapsed via `Clock.currentTimeMillis`). `composeArtPrompt`: prompt wrapped in `withActivity` too.
- Watcher live internals: `agentClientLive` layer now REQUIRES `ActivityBus` (`Layer.Layer<AgentClient, never, ActivityBus>` — update `BridgeRuntime`'s layer wiring: agentClientLive moves out of `leaves` into the provided-with-bus group like replicateClientLive). Subscribe handler runs `Runtime.runSync(runtime)(bus.emit('agent', msg))` (emit is sync-capable: Ref + PubSub.publish + console.log); runtime captured via `Effect.runtime<never>()` at layer build.

Message lines (exact strings, tests assert them):
- step-start part → `step started`
- tool running (first time per callID) → `tool ${tool}: running${title ? ` — ${title}` : ''}`
- tool completed → `tool ${tool}: done — ${title} (${secs}s)` (secs = `Math.round((end-start)/1000 * 10) / 10` rendered with one decimal, e.g. `2.1s`)
- tool error → `tool ${tool}: FAILED — ${error}`
- first reasoning part per messageID → `thinking…`
- text part → `writing response… (${chars} chars)` gated: first text OR `now - lastTextLogAt >= 2000`
- event type `session.error` → `agent error: ${message-ish or 'unknown'}`
- anything else / decode miss → no message.

- [ ] Write failing tests: `mapAgentEvent` unit matrix (each line above; dedupe: two running events same callID → second yields no message; reasoning dedupe per messageID; throttle: text at now=0 logs, now=1500 silent, now=2100 logs; session filter: part with OTHER sessionID → none — filtering lives in the caller: mapAgentEvent takes pre-filtered events? NO — fold the filter in: mapAgentEvent gets `sessionId` too and skips non-matching parts); malformed event → none. `withActivity` lifecycle test: fake `OpencodeClient` whose `event.subscribe` captures `{ onSseEvent, signal }`; build the live service via `agentClientFromSdk`-equivalent path (use `agentClientLive` with a test-injected client? simpler: export `withSessionActivity(client, sessionId)` internal and test through a layer built from `agentClientFromSdk(fake, runtime-ish)`) — assert: events fired through the captured handler land on the test ActivityBus; after the wrapped effect resolves, `signal.aborted === true`. Heartbeat test: stub AgentClient whose prompt delays 6s; TestClock.adjust 5s → `still working… (5s)` in history; adjust rest, join.
- [ ] Run — expect failures.
- [ ] Implement (schema → mapper → withActivity live/stubs → heartbeat → BridgeRuntime layer wiring).
- [ ] `bun run verify` green.
- [ ] Commit: `feat(bridge): stream per-action agent activity + fill heartbeat`.

---

### Task 2: Export↔card linkage (Feature B model)

**Files:**
- Modify: `src/contracts/records.ts` (`ExportRecord` + `cardId: Schema.optional(Schema.String)`)
- Modify: `src/storage/CardArchive.ts` (`saveExport` input + record gains optional `cardId`)
- Modify: `src/export/ExportBar.tsx` (optional `cardId` prop → passed into `saveExport`)
- Modify: `src/builder/BuilderView.tsx` (`<ExportBar … cardId={savedId} />`)
- Test: `src/contracts/contracts.test.ts`, `src/storage/storage.test.ts`, `src/export/export.test.tsx`

- [ ] Failing tests: ExportRecord decodes with/without `cardId`; `saveExport({ …, cardId: 'c1' })` persists it (memory store) and without stays undefined; ExportBar component test passes its `cardId` prop through to `archive.saveExport` (extend the existing `intoArchive` seam test).
- [ ] Implement the four touches; `BuilderPreview` destructures `savedId` and forwards it (undefined until first save — exactly the only-when-saved rule).
- [ ] `bun run verify` green.
- [ ] Commit: `feat(export): link renders to their card via optional cardId`.

---

### Task 3: Unified Saved cards view + search + docs (Feature B UI)

**Files:**
- Create: `src/gallery/gallery-helpers.ts` — `groupExports(cards, exports): { byCard: ReadonlyMap<string, StoredExport[]>; other: StoredExport[] }` (an export joins `byCard` only when its `cardId` matches an existing card, else `other`); `matchesQuery(card: StoredCard, query: string): boolean` (trimmed, lowercased substring over `name`, `themeId`, `layoutId`, `String(data.typeLine ?? '')`, `String(data.ability ?? '')`; empty query → true); `exportMatchesQuery(exp: StoredExport, query: string): boolean` (name).
- Test: `src/gallery/gallery-helpers.test.ts` (pure unit matrix: linked/legacy/dangling grouping; search hits per field; case-insensitivity; empty query).
- Modify: `src/gallery/GalleryView.tsx` — `SECTIONS` = Saved cards (`cards`, default) + Library; `query = ''` state on GalleryView; `GalleryCards` renders: search `TextInput`, filtered card entries (existing row + a thumbnail strip of that card's renders with Download/Delete), then an `Other renders` heading + grid (filtered, hidden when empty); delete `GalleryExports`.
- Modify: `src/gallery/gallery.test.tsx` — existing tests referencing the `Renders` tab / `Saved cards` tab-switching adjust (cards is now the default section; the exports assertions move into the unified view); add: grouped thumbnail renders under the right card; legacy export shows under Other renders; search narrows entries (name hit, ability hit, no-hit hides) and filters Other renders.
- Modify: `README.md` — Gallery paragraph: two tabs, unified searchable Saved cards with grouped renders (legacy renders under Other renders).

- [ ] Failing tests (helpers first, then mounted).
- [ ] Implement helpers → view → README.
- [ ] `bun run verify` + `bun run build` green; quick dev smoke (two tabs, search filters, Henge card shows its render grouped).
- [ ] Commit: `feat(gallery): unified searchable Saved cards with grouped renders`.
