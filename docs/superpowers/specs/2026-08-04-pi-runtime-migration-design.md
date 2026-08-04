# Pi Runtime Migration — Design

**Date:** 2026-08-04
**Status:** Draft for user review. Replaces opencode with the pi SDK
(`@earendil-works/pi-coding-agent`, pinned exact; researched at v0.83.0 /
`earendil-works/pi@05bf9df`) as the app's chat-agent runtime — IN-PROCESS in
the dev-server bridge — and simultaneously replaces the v1 JSON transport
with REAL TOOL CALLING. Grounded in three subagent reports: a pi SDK
embedding reference, a complete opencode-touchpoint inventory, and an
adversarial review whose 16 findings (2 blockers on leaf durability and id
reconciliation) are incorporated below. Exact pi API names were verified
against source at the researched commit and MUST be re-verified against the
pinned version during the canary.

**User-locked decisions:** straight to tools (no JSON-transport interim);
CLEAN BREAK on existing conversations; auth via API keys —
`ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` (pi resolves both from env, at
REQUEST time — the bridge preflights key presence at startup and logs a
warning); sessions live INSIDE `cartis-data`.

## 1. Why (and why now)

- **In-process:** deletes the spawned `opencode serve` child, its port/spawn
  lifecycle, the generated HTTP client + `opencodeClientOf` adapter, and the
  entire lenient wire-decode layer (`src/contracts/opencode.ts`) — the seam
  where four historical bugs lived.
- **Real tools (the bigger prize):** `card_patch` etc. become pi
  `defineTool`s with TypeBox schemas. Pi validates arguments BEFORE execute;
  failures return to the MODEL as error tool results and it self-corrects
  within the same `prompt()` call. The JSON-transport defense stack —
  `extractJson`, `repairJson`, `looksLikeContract`, contract decode,
  `decodePatchLenient`, `bad-reply` — becomes unnecessary and is deleted.
- **Data locality:** conversations move into `cartis-data/chats/` — one
  backup dir; `CARTIS_DATA_ROOT` isolation covers chats (fixes the wart
  where e2e chats pollute the real opencode session store).

## 2. Runtime architecture (bridge)

### 2.1 Isolation configuration (every pi surface pointed away from $HOME)

Pi defaults everything to `~/.pi/agent` and some setters write global
settings — the embedded runtime overrides ALL of it:

- `ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null })`
  — created once, cached behind a lazy dynamic
  `import('@earendil-works/pi-coding-agent')` + `Effect.cached` (same
  pattern as today: vite's native config loader stays fast, the heavy dep
  stays out of eager config-graph evaluation). The builtin model catalog is
  compiled in, so `getModel` works offline with `modelsPath: null`. Env keys
  are read per-request by pi, not at create — hence the startup preflight
  log.
- `SettingsManager.inMemory({ compaction: { enabled: false } })` —
  auto-compaction OFF (short turns; entry-based rehydration must never see a
  compaction collapse; and the runtime SETTER variant writes `~/.pi`
  settings — never call it). Auto-retry stays at pi defaults (enabled, 3) —
  `await session.prompt()` resolves only after retries settle.
- **Per-turn `DefaultResourceLoader`** (review finding 4): constructed each
  turn with `cwd` AND `agentDir` BOTH under `CARTIS_DATA_ROOT` (so
  `~/.pi` prompt files can never be discovered),
  `systemPromptOverride: () => <persona + THIS turn's card context>`,
  `appendSystemPromptOverride: () => []`, and ALL of
  `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` —
  **followed by `await loader.reload()`** (a caller-provided loader is never
  reloaded by the SDK; without reload the system prompt is silently
  undefined). Reload is cheap with all `no*` flags.
- **Long-lived `SessionManager` per session, cached** (review finding 1):
  `SessionManager.create(cwd, chatsDir, { id })` with
  `chatsDir = <DATA_ROOT>/chats`, `cwd = <DATA_ROOT>`, `id` = OUR SessionId
  (pi accepts custom ids matching `[A-Za-z0-9._-]`; uuids and old
  `ses_…` ids both qualify). The bridge keeps a Map<SessionId,
  SessionManager> for the runtime's lifetime (disposed by the runtime
  finalizer) and remembers the FULL file path returned at create/open —
  never suffix-scan for `_<id>.jsonl` (suffix collisions). A session FILE
  does not exist until the first assistant message (pi buffers); rehydration
  tolerates a missing file — which is also the entire CLEAN-BREAK mechanism:
  an old opencode `chatSessionId` finds no file, the bridge mints a fresh pi
  session UNDER THE SAME ID (no record rewrite, no migration code), and the
  card gets a fresh chat.

### 2.2 Per-TURN AgentSession over the cached SessionManager

The bridge does NOT keep long-lived `AgentSession` objects. Each turn:

1. Get the cached `SessionManager` (create on first use).
2. Build THIS turn's resource loader (persona + card snapshot) and tool set
   (schemas from THIS turn's fields/docContext), then
   `createAgentSession({ sessionManager, settingsManager, modelRuntime,
   resourceLoader, model, noTools: 'all', customTools, tools: [names] })`.
3. `session.subscribe(...)` → ThreadBus events; `session.prompt(text, { images })`.
4. On resolve: read the branch tail for authoritative ids (§3.2), assemble
   the response from the persisted assistant message + collector.
5. `session.dispose()` (after `await session.abort()` first when canceling —
   pi persists the aborted partial with `stopReason:'aborted'`).

Why per-turn: tool schemas must reflect the CURRENT layout and the system
prompt carries the current card snapshot; pi fixes `customTools` at session
creation. Repeated create/dispose is what pi's own runtime does. Known side
effect (review finding 12): pi appends `model_change`/`thinking_level_change`
entries on new sessions/branches — ALL entry-type consumers (history mapper,
tree anchors) must skip non-message entry types generally.

Model selection: `CARTIS_MODEL=provider/model-id` (e.g.
`anthropic/claude-sonnet-4-6`, `openai/gpt-…`) replaces `OPENCODE_MODEL`;
resolved via `modelRuntime.getModel(provider, id)`. vite.config's loadEnv
copy list becomes `ANTHROPIC_API_KEY, OPENAI_API_KEY, CARTIS_MODEL,
REPLICATE_API_TOKEN`.

### 2.3 Concurrency (gates ALL mutating routes)

Pi's `isStreaming` guard is per-AgentSession-instance and cannot see a turn
running on another instance over the same SessionManager (review finding 3).
The bridge therefore keeps its own per-session in-flight map, and it gates
`/api/chat/turn`, `/api/chat/edit`, `/api/chat/regenerate`, AND branch
switches — a busy session returns a typed conflict error. `/api/chat/abort`
reaches the live turn's session via the same map and calls
`session.abort()`.

## 3. The tool transport

### 3.1 Card tools (declarative intents, validated by the provider)

All tools follow one pattern: `execute()` records the VALIDATED params and
returns a short text result ("ok"; never empty content); the actual effect
happens client-side exactly as today. Every card tool is marked
`executionMode: 'sequential'` (review finding 5) — they are instant intent
recorders, and sequential execution makes observable order deterministic.
Tool names keep the existing `CARD_*_TOOL` constants (chips/UI unchanged).

| Tool | Parameters (TypeBox, built per turn) |
|---|---|
| `card_patch` | `Type.Object` derived from `req.fields`: per-field `Type.Optional` of `Type.String()` / `Type.Integer({minimum,maximum})` / `Type.Boolean()` / `Type.Union(options.map(Type.Literal))` — the provider+pi now enforce what `decodePatchLenient` used to salvage |
| `card_generate_art` | `{ brief: Type.String(), editCurrentArt: Type.Boolean() }` |
| `card_save` / `card_save_copy` | `Type.Object({})` — empty-parameter tools; canary confirms both providers accept them (fallback: a dummy optional field) |
| `card_export` | `{ target: Type.Union(['png','print','sheet'].map(Type.Literal)) }` |
| `card_set_layout` | `{ layoutId: Type.Union(docContext.layoutOptions.map(Type.Literal)) }` — invalid ids UNREPRESENTABLE |
| `card_set_theme` / `card_set_holo` | literal-union theme ids / `{ value: Type.Boolean() }` |

`promptSnippet`/`promptGuidelines` on each tool replace the CHAT_GUIDE's
JSON-shape paragraphs; the persona shrinks to role + editing principles.

### 3.2 Turn response (wire contract v2) + id reconciliation

`ChatTurnResponse` becomes structured — no raw model text to parse:

```
{ sessionId,
  reply: string,                          // assistant prose
  toolCalls: Array<{ name, args }>,       // CANONICAL order: read from the
                                          // persisted assistant message's
                                          // toolCall content blocks, NOT
                                          // collector push order
  toolErrors?: Array<{ name, message }>,  // validation failures (note strip)
  userEntryId, assistantEntryId }         // authoritative pi entry ids
```

**The id rule (review finding 2, the second blocker):** pi events never
carry entry ids (ids are minted at persist, AFTER events fire). So live SSE
events use bridge-minted MessageIds, and after `prompt()` resolves the
bridge reads the branch tail and returns `userEntryId`/`assistantEntryId`;
the CLIENT RE-KEYS its optimistic user bubble and the assistant message to
those entry ids on receipt. From then on every ThreadMessage id in client
state IS a pi entry id — which is what `edit`, tree anchors, and branch
switching target. (History rehydration naturally produces entry ids.)

The client maps `toolCalls` straight to the existing applier switch —
ordering rule unchanged: settings sync-first, then art, then save/export —
and builds ToolCall chip parts directly. `materializeAssistantParts` shrinks
to a pure builder over structured data; the parse stack is DELETED. A turn
whose tools all failed validation still returns the prose reply plus
`toolErrors`. Note (review finding 14): a stubborn model can loop
validate-fail→retry inside one `prompt()`; the per-turn wall-clock timeout
(§7.4) bounds it.

### 3.3 Attachments & vision

- User images: pi `ImageContent = { type:'image', data: base64, mimeType }`
  via `PromptOptions.images`. Pi does NOT resize in the prompt path and
  provider payload limits apply (Anthropic ≈5MB base64 — external claim,
  re-verify), so the CLIENT gate downscales images at attach time (browser
  canvas, ≤2000px, JPEG re-encode) with an effective ~3.5MB image cap.
- User text files: inlined into user content as `<file name="…">…</file>`
  blocks (pi's own CLI convention); bubbles render from attachment metadata,
  not the inlined text.
- Card-art context + preview snapshot: additional `images` AFTER user
  attachments.
- **Attachment metadata entry (replaces the filename'd/unnamed convention):**
  after each turn the bridge appends a pi `custom` entry (verified: excluded
  from LLM context, present in getEntries/getBranch/getTree) with
  `{ userEntryId, attachments: [{name,mime}], contextImages: n }` — keyed to
  the turn's user entry EXPLICITLY (review finding 10; the entry lands after
  the assistant reply, so position is not the association). Custom entries
  become the tree leaf — harmless (next turn parents onto them; context
  builder ignores them) — and are skipped by mapping/anchors like all
  non-message entries.

## 4. Branching, history, events

### 4.1 Tree-native branching — with DURABLE selection

Everything happens INSIDE one session file — `chatSessionId` never changes.

**Roles (review finding 3):** tree READS and branch SWITCHES use
`SessionManager` APIs directly (`getTree`/`getChildren`/`branch`) — no
AgentSession needed. `navigateTree` is used ONLY inside an edit/regenerate
turn's own AgentSession.

**Durable selection (review finding 1, the first blocker):** pi's leaf
pointer is in-memory only, and (re)opening a file sets the leaf to the LAST
entry in file order. Therefore every branch switch is made durable by
construction: `sessionManager.branch(targetLeafId)` followed by
`appendCustomEntry('leaf_switch', { leafId: targetLeafId })`. Because
reopen-leaf = last file entry, and the `leaf_switch` entry's own root-path
IS the selected branch, the selection survives SessionManager reopen and
dev-server restarts with zero extra state. (Ordinary turns need nothing:
their own appends make their branch last-written.)

- **Edit an earlier message:** route `/api/chat/edit { sessionId,
  messageId, text }` — the edit turn's AgentSession calls
  `navigateTree(userEntryId)` (leaf → its parent) then `prompt(editedText)`;
  a new sibling branch; the old branch stays. Replaces the client-side
  fork+revert+resend dance.
- **Regenerate:** `navigateTree(lastUserEntryId)` + `prompt(sameText)` (pi
  has no rerun-without-duplicate primitive; the duplicated user entry is a
  new branch, old one retained).
- **‹ n/m › siblings:** `/api/chat/tree` (replaces `/api/chat/siblings`)
  returns `{ anchors: [{ messageId, index, count, siblingLeafIds }] }`
  computed from `getTree()`/`getChildren()`, counting only user-message
  entries as siblings (all non-message entry types skipped). The client's
  history-diff `divergencePoint` module is DELETED. Switching =
  `/api/chat/switch { sessionId, leafId }` → durable branch + re-fetch
  history.

### 4.2 History mapping (`mapSessionEntries`)

Replaces `mapSessionMessages`: read `sessionManager.getBranch()` (active
root→leaf path) and map entries, SKIPPING `custom`/`model_change`/
`thinking_level_change`/`label`/`session_info` types except where consumed:
user `message` entries → Text part (+ Image/File parts resolved from the
turn's attachment-metadata entry by `userEntryId`); assistant entries →
Text part from text content + ToolCall chip parts from `toolCall` content
blocks — joined by `toolCallId` with their tool RESULTS, which pi persists
as SEPARATE `toolResult`-role message entries (review finding 16), status
completed/error from `isError`. Aborted turns (`stopReason:'aborted'`) →
incomplete. Revert-marker logic is gone (the active branch IS the truth).

### 4.3 Live events (`mapPiEvent`)

A new pure reducer replaces `mapAgentEvent`, consuming `session.subscribe()`
events. Precision note (review finding 7): `toolcall_start/delta/end` are
INNER `AssistantMessageEvent` variants carried inside `message_update`;
`tool_execution_start/update/end` are TOP-LEVEL events — the mapper handles
both layers:

| pi event | ThreadEvent |
|---|---|
| `message_start` (assistant role) | `TurnStarted` (bridge-minted MessageId; re-keyed client-side per §3.2) |
| `message_update` w/ inner `text_start/delta/end` | `PartDelta` Text — use the CUMULATIVE `partial` message (fold is upsert-by-index), throttled 2s |
| `message_update` w/ inner `toolcall_*`, and top-level `tool_execution_start/end` | `PartDelta` ToolCall (running → completed/error; args as argsText) |
| inner `{type:'error'}` / message `stopReason:'error'` + `errorMessage` | `SessionError` |
| `prompt()` resolution (== settled; `agent_settled` drives the SSE emit) | `TurnCompleted` — never key off `agent_end`, which may auto-retry (`willRetry`) |

SSE contract and the fold's part-upsert semantics are unchanged; the fold's
materialize-contract fallback is deleted (no raw JSON can exist), and
ThreadState's orchestration changes substantially per §3.2/§4.1 (review
finding 13 — do not read this row as "client unchanged").

### 4.4 Removed from the product / simplified

- **Permission prompts deleted end-to-end**: pi has no permission events;
  our tools are auto-executed intents. `PermissionRequested` variant,
  `replyPermission`, `/api/chat/permission`, `PermissionStrip`,
  `pendingPermission` all go (exhaustive Matches walk us to every site).
- `/api/chat/fork` + `/api/chat/revert` routes die (tree ops subsume);
  `/api/chat/regenerate` SURVIVES reshaped (navigateTree + reprompt);
  `/api/chat/edit` and `/api/chat/switch` are new; `/api/chat/siblings` →
  `/api/chat/tree`.
- `composeArtPrompt`: `modelRuntime.completeSimple(model, { systemPrompt,
  messages }, …)` — returns an `AssistantMessage`; the bridge extracts text
  content and checks `stopReason === 'error'`/`errorMessage` itself (review
  finding 9). No session, no watcher; Art 'composing' bus event kept.
- `promptWithHeartbeat` KEPT: it is runtime-agnostic Effect code; it now
  wraps `session.prompt()` (review finding 6).

## 5. Full delete/reshape list

**Deleted:** `@opencode-ai/sdk` dependency; `src/contracts/opencode.ts` (all
5 schemas) + its decode tests in `contracts.test.ts` (PromptResult /
SessionCreated); `opencodeClientOf`/`OpencodeSdkSurface`/`OpencodeClient`;
the spawn lifecycle (port 0 + finalizer) + the BridgeRuntime "spawn ENOENT"
stub test; `mapAgentEvent` (+ ~20 tests → replaced by `mapPiEvent` tests);
`mapSessionMessages` (+ tests → `mapSessionEntries` tests); `siblingSet` +
`sessionSummary`; `USER_REQUEST_MARKER`/`userRequestOf` + the
`chatPromptText` scaffold; `PromptResult`/`promptText`; `extractJson`/
`repairJson`/`looksLikeContract`/contract-decode/`replyOf`;
`decodePatchLenient`; `src/chat/divergence.ts` (+ tests); permission
machinery end-to-end; `OPENCODE_MODEL`.

**Reshaped:** `ChatTurnRequest/Response` (§3.2); `ThreadState`
send/applyTurnExit/regenerate/edit/loadBranches (entry-id re-keying, tree
anchors, no fork/revert); `ChatThread` (edit/switch/tree replace
fork/revert/siblings); fold (drop materialize fallback);
`materializeAssistantParts` (parser → builder); `/api/chat/*` routes per
§4.4; `AgentClient` tag surface (reshaped to the pi operations; the ~40
seam-level stub tests survive with reshaped payloads).

## 6. Env, docs, sequencing

- `.env.example`: `ANTHROPIC_API_KEY=` / `OPENAI_API_KEY=` (either),
  `CARTIS_MODEL=anthropic/claude-sonnet-4-6`, `REPLICATE_API_TOKEN=`.
- README chat section rewrite (pi runtime, real tools, in-file branching,
  no permissions, key setup). Memory file updated post-merge.
- **Sequencing (user-directed):** this migration implements FIRST; the
  test-hardening spec is then REFACTORED (Track A corpus retires with the
  parse stack; Track B fake agent becomes a fake behind the reshaped seam;
  Track C notes update; pi dep shared app+driver) and implemented after.

## 7. Risks & gates

1. **Canary first (hard gate):** pi SDK under bun inside the vite-plugin
   bridge — one scripted turn end-to-end: session create in a scratch chats
   dir, custom tool called with validated args, entries on disk including
   the metadata custom entry, branch read-back, dispose clean, and an
   empty-params tool accepted by the target provider(s). All API names
   re-verified against the pinned version (pi's own `docs/sdk.md` has at
   least one wrong example — trust `ai/src/types.ts`). STOP on failure.
2. **v0.x churn:** pin EXACT; upgrades are deliberate events gated by the
   (post-refactor) e2e suites.
3. **Per-turn cost:** loader reload + session open per turn — cheap in the
   fully-injected configuration (verified: no `~/.pi` IO, no extension
   loading, compiled-in catalog); `getBranch()` is linear in file size
   (accept at chat scale).
4. **Turn budget:** validation-retry loops and auto-retry live inside one
   `prompt()` — a per-turn wall-clock timeout in the bridge bounds the
   worst case (surfaced as the existing incomplete-turn path).
5. **Model under-calling tools** (says "done", calls nothing): prompt
   guidelines + live e2e gate; a reply-only turn remains a valid
   conversational turn.

## Non-goals

Streaming-granularity changes (SSE contract unchanged), parallel turns per
session, pi OAuth flows, pi extensions/skills, any opencode compatibility
path, migrating old conversations.
