# Pi Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace opencode with the pi SDK in-process AND replace the v1 JSON transport with real tool calling — per `docs/superpowers/specs/2026-08-04-pi-runtime-migration-design.md` (all §-refs below point there).

**Architecture:** New `src/server/pi/` cluster (runtime singletons + session cache, card tools, turn orchestration, event mapper, entry mapper) behind the reshaped bridge routes; client consumes structured `{reply, toolCalls, userEntryId, assistantEntryId}` and re-keys optimistic bubbles to pi entry ids; tree-native branching with durable `leaf_switch` entries. Deterministic full-loop tests via an injected `FakeModelRuntime` (scripted `streamSimple`) driving the REAL pi loop + REAL persistence.

**Tech Stack:** `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` (pinned EXACT), TypeBox (`@sinclair/typebox`, pi's peer), effect, vitest.

## Global Constraints

- Spec §7.1 canary is a HARD GATE: Task 1 proves pi-under-bun + the FakeModelRuntime seam before anything else. STOP on failure.
- `bun run verify` green after EVERY task (true exit codes, never through pipes). Baseline 391+ tests green at branch start.
- Server-side pi files are config-reachable → relative `.ts` imports, no `@/`; heavy pi import stays LAZY (`Effect.cached` dynamic import) so the vite native config loader never evaluates it.
- Isolation invariants (§2.1) verbatim: `ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null })`; `SettingsManager.inMemory({ compaction: { enabled: false } })`; per-turn `DefaultResourceLoader` with `cwd`+`agentDir` under DATA_ROOT, `systemPromptOverride`, `appendSystemPromptOverride: () => []`, all `no*` flags, **then `await loader.reload()`**; `SessionManager.create(dataRoot, dataRoot + '/chats', { id })` with the full file path remembered (no suffix scans).
- The two blocker rules verbatim: branch switches are durable via `branch(leafId)` + `appendCustomEntry('leaf_switch', { leafId })`; `ChatTurnResponse` carries `userEntryId`/`assistantEntryId` read from `getBranch()` after `prompt()` resolves, and the client RE-KEYS optimistic bubbles.
- Card tools: `executionMode: 'sequential'`; canonical `toolCalls` order from the persisted assistant message's `toolCall` content blocks, not collector push order; execute() never returns empty content.
- All entry-type consumers skip non-message entries (`custom`/`model_change`/`thinking_level_change`/`label`/`session_info`/`branch_summary`/`compaction`).
- Bridge in-flight map gates turn/edit/regenerate/switch; busy → `AgentError('busy')` (409-ish via statusOfError). Per-turn wall-clock timeout (§7.4) → incomplete path.
- Permissions deleted end-to-end. Heartbeat kept. `composeArtPrompt` → `completeSimple`.
- Env: `CARTIS_MODEL=provider/model-id`; keys `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`; startup preflight log; vite loadEnv list updated; `OPENCODE_MODEL` purged.
- §9 sweep gates at the end: `grep -ri opencode src test` → zero; dep gone; non-destructive rollback stated in the merge commit.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `feat/pi-runtime`; ff-merge + push + delete at end; memory updated.

---

### Task 1: Canary — pi under bun + FakeModelRuntime seam (HARD GATE)

**Files:** Modify `package.json` (exact deps). Create `scripts/pi-canary.ts` (kept permanently — re-run on every pi pin bump), `src/server/pi/fakeModelRuntime.ts`.

**Interfaces (produces):**
```ts
// src/server/pi/fakeModelRuntime.ts — the deterministic test seam (§8.2)
export interface ScriptedTurn { text?: string; toolCalls?: Array<{ name: string; args: unknown }> }
export function fakeModelRuntime(script: ScriptedTurn[]): ModelRuntime; // consumed turn-by-turn
// implementation: subclass or structural double whose streamSimple() emits the
// AssistantMessageEvent sequence (text_start/delta/end, toolcall_end, done) and
// resolves to the final AssistantMessage with matching content blocks + stopReason
// ('toolUse' when toolCalls present else 'stop'). Exact event/callback contract of
// StreamFn: READ ai/src/types.ts + streamSimple usage in the PINNED version first.
```

- [ ] **Step 1:** `bun add --exact @earendil-works/pi-coding-agent @earendil-works/pi-ai` (devDependencies, like the opencode SDK was) + `@sinclair/typebox` if not transitive-importable. Record the pinned versions in the canary header comment.
- [ ] **Step 2:** write `fakeModelRuntime` against the pinned source (verify `streamSimple` signature + event contract in `node_modules/@earendil-works/*/dist` or types).
- [ ] **Step 3: canary script** (`bun scripts/pi-canary.ts`, scratch dir under `/tmp` or scratchpad): full §2.1 isolation config; one `defineTool` (`canary_tool`, `Type.Object({ value: Type.String() })`, sequential, records args); `createAgentSession` with fake runtime scripted to call the tool then reply; `session.prompt('hi')`; assert — tool executed with validated args; `getBranch()` tail has user+assistant entries with the toolCall block; `appendCustomEntry('leaf_switch', …)` lands and REOPENING the SessionManager (new instance on same file) yields the same active branch; dispose clean; a second scripted turn with INVALID args produces pi's error-tool-result + model-retry flow. Optional `--live` flag: real `ModelRuntime` + `CARTIS_MODEL` + env key, one empty-params-tool turn (defer to Task 6's live gate if no key configured yet).
- [ ] **Step 4:** run it. **GO** = all asserts pass under bun. NO-GO → investigate; if pi-under-bun is the blocker try `node scripts/pi-canary.ts`; if the fake seam is the blocker, note the §8.2 fallback and re-plan Task 3's tests. STOP and report rather than build on a failed gate.
- [ ] **Step 5:** verify green; commit `feat(pi): canary — pi SDK under bun + FakeModelRuntime seam (GO)`.

### Task 2: Pi runtime core + card tools

**Files:** Create `src/server/pi/runtime.ts`, `src/server/pi/cardTools.ts`, tests `src/server/pi/cardTools.test.ts`, `src/server/pi/runtime.test.ts` (full-loop smoke via fake).

**Interfaces (produces):**
```ts
// runtime.ts (config-reachable; lazy import inside)
export interface PiRuntime {
  readonly modelRuntime: ModelRuntime;           // real or injected fake
  readonly settings: SettingsManager;
  model(): Effect.Effect<Model, AgentError>;     // parses CARTIS_MODEL 'provider/id'
  sessions: {                                    // cached SessionManagers + full paths
    get(id: SessionIdT): Promise<SessionManager>;   // open existing file or create {id}
  };
  inFlight: Map<string, AgentSession>;           // §2.3 gate + abort channel
}
export const PiRuntimeTag: Context.Tag…;         // provided in BridgeRuntime layer;
export const piRuntimeLive: Layer…;              // testable via a layer that injects fakeModelRuntime
// cardTools.ts
export interface IntentCollector { calls: Array<{ name: string; args: unknown }>; errors: Array<{ name: string; message: string }> }
export function cardTools(fields: readonly FieldSummaryT[], doc: DocContextT | undefined, collector: IntentCollector): ToolDefinition[];
export function personaPrompt(req: ChatTurnRequestT): string;  // guide + theme + fields + currentData; NO marker
```

- [ ] **Step 1: failing tests.** cardTools: schemas validate/coerce per field kind (integer min/max reject 999, select literal rejects 'banana', layout literal from docContext rejects unknown id — assert via TypeBox `Value.Check` directly); all tools `executionMode:'sequential'`; execute records into collector and returns non-empty text content. personaPrompt contains lookAndFeel/fields/currentData and NOT `Author request:`. runtime: model() parses `anthropic/claude-x`; malformed → AgentError; sessions.get twice returns the SAME manager; unknown-id get creates file-less session (clean break).
- [ ] **Step 2:** implement. Keep every pi import inside the lazy cached acquire; `piRuntimeLive` mirrors `agentClientLive`'s Layer.scoped shape with a finalizer that disposes cached sessions.
- [ ] **Step 3:** verify green; commit `feat(pi): runtime core (session cache, model resolution) + card tools with per-turn schemas`.

### Task 3: Turn path — runTurn, mapPiEvent, wire contract v2

**Files:** Create `src/server/pi/turn.ts`, `src/server/pi/mapPiEvent.ts` (+ tests for both). Modify `src/contracts/api.ts` (ChatTurnResponse v2 + delete droppedFields), `src/contracts/errors.ts` (AgentError reasons `busy`/`turn-failed`; statusOfError busy→409), `src/server/agentBridge.ts` (routes `/api/chat/turn`+`/api/chat/abort` re-wired to runTurn/inFlight; heartbeat kept around `session.prompt`).

**Interfaces (produces):**
```ts
// turn.ts
export function runTurn(rt: PiRuntime, bus: ThreadBus, req: ChatTurnRequestT):
  Effect.Effect<ChatTurnResponseT, AgentError>;
// - busy check → AgentError('busy'); register in inFlight; finally deregister+dispose
// - per-turn loader (§2.1, reload!) + cardTools(collector) + createAgentSession
// - subscribe → mapPiEvent(state machine) → bus.emit (2s text throttle, cumulative partial)
// - images: [...user image attachments, previewDataUrl?, artContext?]; text files inlined
//   as <file name="…">…</file> blocks appended to the user text
// - await prompt (raced with WALL_CLOCK_TIMEOUT=180s → abort + AgentError('turn-failed'))
// - read getBranch() tail → userEntryId/assistantEntryId; toolCalls from the persisted
//   assistant toolCall blocks (canonical); toolErrors from collector.errors
// - appendCustomEntry('turn_meta', { userEntryId, attachments:[{name,mime}], contextImages })
// mapPiEvent.ts — pure reducer: (event, sessionId, minted assistant MessageId state, now)
//   → ThreadEventT[] per the §4.3 table (both event layers; TurnCompleted emitted by runTurn
//   at prompt-resolution, NOT by the reducer's agent_end)
```
`ChatTurnResponse` (api.ts): `{ sessionId, reply, toolCalls: Array<{name, args: unknown}>, toolErrors?: …, userEntryId: MessageId, assistantEntryId: MessageId }` — `assistantText/patch/artAction/actions/droppedFields` REMOVED (client maps toolCalls in Task 5; tests for old fields die here, reshaped now to keep verify green — Task 3 and 5 land as ONE verify unit if the intermediate state can't compile; prefer: reshape contracts + client consumption minimally in this task (mechanical), full client UX in Task 5).

- [ ] **Step 1: failing tests.** mapPiEvent table (message_start→TurnStarted; text deltas via partial cumulative + throttle; toolcall inner + tool_execution outer → ToolCall transitions; error variants → SessionError). Full-loop via fake: happy turn (ids from branch tail, canonical order with a script that interleaves), validation-failure turn (toolErrors populated, turn still succeeds with reply), busy gate (second concurrent turn → AgentError busy), abort (runTurn aborted mid-stream → 'turn-failed'/incomplete semantics), turn_meta entry present with userEntryId.
- [ ] **Step 2:** implement; minimally adapt ThreadState/ChatThread to the new response shape (compile-level: map toolCalls→existing appliers inline; re-key deferred to Task 5 ONLY if tests permit — otherwise do re-keying here).
- [ ] **Step 3:** verify green; commit `feat(pi): tool-transport turn path + event mapper (wire contract v2)`.

### Task 4: History + tree — mapSessionEntries, tree/switch/edit/regenerate routes

**Files:** Create `src/server/pi/entries.ts` (+ tests). Modify `src/server/agentBridge.ts`: `/api/chat/history` (getBranch→mapSessionEntries), NEW `/api/chat/tree` + `/api/chat/switch` + `/api/chat/edit`, reshape `/api/chat/regenerate`, DELETE `/api/chat/fork`+`/api/chat/revert`+`/api/chat/siblings`+`/api/chat/permission`. `src/contracts/api.ts`: `ChatTreeResponse { anchors: [{messageId, index, count, siblingLeafIds}] }`, `SwitchRequest`, `EditRequest`.

- [ ] **Step 1: failing tests.** entries fixtures: skip-list types skipped; toolResult joined by toolCallId across entries; attachments resolved from turn_meta by userEntryId; aborted→incomplete; leaf_switch branch active after reopen (blocker-1 regression, via fake + real SessionManager on tmp dir). Anchors: fixture tree → counts skip non-message entries. Edit flow full-loop: navigateTree(userEntryId)+prompt creates sibling; regenerate duplicates last user text on a new branch.
- [ ] **Step 2:** implement; switch = `branch(leafId)`+`appendCustomEntry('leaf_switch',{leafId})`; edit/regenerate run through runTurn-style sessions (share the per-turn assembly via a helper in turn.ts).
- [ ] **Step 3:** verify green; commit `feat(pi): tree-native history, durable branch switch, edit/regenerate`.

### Task 5: Client swap — re-keying, structured applier, UI removals, image downscale

**Files:** Modify `src/chat/ChatThread.ts` (turn/edit/switch/tree replace fork/revert/siblings), `src/chat/ThreadState.ts` (applyTurnExit consumes toolCalls incl. RE-KEYING both bubbles to entry ids; edit() → one route call; loadBranches→loadTree/branchPoint from anchors; delete pendingPermission/replyPermission/canceling-permission paths), `src/contracts/materialize.ts` (parser→builder `partsFromTurn(reply, toolCalls)`; delete extractJson/repairJson/looksLikeContract/decodeContract/replyOf/decodeDocActions-lenient path), `src/chat/fold.ts` (drop materialize fallback), `src/chat/MessageView.tsx`+`ThreadPanel.tsx` (PermissionStrip gone), `src/chat/attachments.ts` (image downscale ≤2000px canvas re-encode, effective 3.5MB image cap), DELETE `src/chat/divergence.ts`. Tests reshaped throughout (ThreadState re-key/edit/tree; materialize builder; panel).

- [ ] **Step 1: failing tests** — re-key rule (send → optimistic uuid; response → messages keyed by entry ids; edit targeting the just-sent message works); structured applier (settings sync-first→art→save/export order preserved from toolCalls); tree anchors render ‹n/m› from server anchors; permission strip absent; attachment downscale (oversized canvas image → ≤2000px, note on failure).
- [ ] **Step 2:** implement; delete list for this task executed (divergence.ts, permission UI, parse stack).
- [ ] **Step 3:** verify green; commit `feat(chat): structured tool-call client — entry-id re-keying, tree anchors, permission removal`.

### Task 6: Deletion sweep, env/docs, LIVE e2e gate, merge

- [ ] **Step 1: sweep.** Delete `src/contracts/opencode.ts`, `mapAgentEvent`+`initialWatchState`+watcher, `opencodeClientOf`/surfaces, `siblingSet`/`sessionSummary`, `USER_REQUEST_MARKER`/`userRequestOf`/`chatPromptText` scaffold, `promptText`/`PromptResult` uses, spawn lifecycle, `withActivity`, `decodePatchLenient`, dead tests (contracts opencode decode, BridgeRuntime spawn stub, mapAgentEvent/mapSessionMessages/siblingSet suites — replaced in Tasks 3-4), `bun remove @opencode-ai/sdk`. Gates: `grep -ri opencode src test` → 0; `grep -rn OPENCODE_MODEL . --exclude-dir=node_modules --exclude-dir=docs` → 0.
- [ ] **Step 2: env/docs.** `.env.example` (ANTHROPIC_API_KEY/OPENAI_API_KEY/CARTIS_MODEL/REPLICATE_API_TOKEN), vite.config loadEnv list, `composeArtPrompt`→`completeSimple` (in Task 3 if route needs it earlier — wherever it lands, verify here), README chat section rewrite, startup preflight log.
- [ ] **Step 3: LIVE e2e gate (§8.4, real key + browser)** — full checklist: patch turn; attachment (image+md); edit→‹n/m› at true fork; **switch older branch → dev-server RESTART → selection retained**; regenerate; save/export/setLayout tools; abort mid-turn; old-opencode-id card opens fresh+clean; art generation. Fix real bugs before merge; never weaken.
- [ ] **Step 4:** `bun run verify` + `bun run build`; ff-merge (commit message states the non-destructive rollback story), push, delete branch; memory update (pi runtime live, env vars, canary results, gotchas).

## Self-review

Spec coverage: §2.1 isolation (T1/T2), §2.2 per-turn (T3), §2.3 gate (T3), §3 tools+ids (T2/T3), §3.3 attachments (T3 server, T5 client downscale), §4.1 durability+tree (T4), §4.2 entries (T4), §4.3 mapper (T3), §4.4 removals (T4/T5), §5 deletes (T5/T6), §6 env/docs (T6), §7 gates (T1/T3 timeout/T6), §8 tests distributed per tier, §9 hygiene (T6). Type consistency: PiRuntime/IntentCollector/ScriptedTurn/ChatTurnResponse v2 names used consistently. Deliberate flexibility flags: T3 notes contracts+client may need to land as one verify unit; exact StreamFn contract read from pinned source in T1 (bounded lookup, not placeholder).
