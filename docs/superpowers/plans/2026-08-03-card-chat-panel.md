# Card Chat Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI Assistant box and the footer activity bar with a ChatGPT-style chat sidebar (spec: `2026-08-03-card-chat-panel-design.md`) — a per-card conversation that edits the card, carries all AI activity as inline chips, and persists through opencode sessions linked from the card record.

**Architecture:** Structured `ChatEvent`s flow ChatBus (server PubSub, retyped ActivityBus) → `/api/chat/events` SSE → `ChatClient` Stream → `ChatSession` expressive State → hand-rolled `src/chat/` components (assistant-ui Thread anatomy, our tokens). Turns run `POST /api/chat/turn` (`reply` + targeted `patch` + `artAction`); history rehydrates from opencode `session.messages` via `/api/chat/history`; `CardRecord.chatSessionId` binds conversation to card.

**Tech Stack:** effect 3.22 (Schema tagged unions, Stream, PubSub), opencode SDK sessions + lazy event stream (drain `result.stream`!), expressive State/Component, vitest 4 + test/effect.ts + testAppLayerWith.

## Global Constraints

- Spec's Engineering-requirements section is binding (exhaustive ChatEvent matching, Schema everywhere, boundary pattern, tracked reads, adopted-child ChatSession).
- Gate after EVERY task: `bun run verify` green. Push allowed; commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Server console `[cartis:*]` lines are preserved (terminal parity) even as the browser surface moves to chat.
- Reuse, don't re-invent: the watcher (`mapAgentEvent` dedupe/throttle), session machinery, vision attach, patch decoding (`schemaFromFields`), SSE route pattern, EventSource→Stream pattern all exist — this plan RESHAPES them.

---

### Task 1: Chat contracts + ChatBus + structured event flow (server)

**Files:**
- Create: `src/contracts/chat.ts` (ChatEvent tagged union + `ChatEventJson`)
- Delete: `src/contracts/activity.ts` (its describes in `contracts.test.ts` → chat codec matrix)
- Modify: `src/server/activity.ts` → rename file to `src/server/chatBus.ts` (`ChatBus` tag, `emit(event: ChatEventT)`, typed history/changes; per-variant console rendering)
- Modify: `src/server/agentBridge.ts` (`mapAgentEvent` returns `ChatEventT | undefined` instead of message strings; replicate progress → `art` events; SSE route `/api/chat/events`; `/api/activity` deleted)
- Modify: `src/server/BridgeRuntime.ts` (layer names), `test/setup` untouched
- Test: `src/contracts/contracts.test.ts`, `src/server/chatBus.test.ts` (rename of activity.test), `src/server/agentBridge.test.ts`

**Interfaces (Produces):**
- `ChatEvent` = tagged union (`_tag`): `TurnStarted {sessionId}` | `TextDelta {sessionId, chars: number}` | `Tool {sessionId, name, status: 'running'|'done'|'error', title?, secs?}` | `Step {sessionId}` | `Thinking {sessionId}` | `Art {phase: 'composing'|'generating'|'progress'|'downloaded'|'error', detail?}` | `TurnComplete {sessionId}` | `AgentError {message}` — via `Schema.TaggedStruct` members in a `Schema.Union`; `ChatEventJson = Schema.parseJson(ChatEvent)`; `ChatEventT`.
- `ChatBus` tag (`cartis/ChatBus`): `emit(event: ChatEventT): Effect<void>`; `history: Effect<ReadonlyArray<ChatEventT>>`; `changes: Stream<ChatEventT>`; `chatBusLive`/`chatBusTestLayer`.
- `mapAgentEvent(raw, sessionId, state, now): { event?: ChatEventT; state: WatchState }`.

Steps (TDD): retype the codec tests (decode/encode every variant + reject unknown tag) → implement contracts → retype bus tests (emit/history/changes/replay with a Tool event) → rename+retype bus → retype watcher tests (assert structured events instead of strings; keep dedupe/throttle/session-filter matrix) → rework `mapAgentEvent` + watcher emit + replicate `art` emissions + console renderer (`[cartis:agent] tool read: done — …` strings preserved via a `renderChatEvent(event): string` helper, unit-tested for the old formats) → swap the SSE route → verify → commit `feat(bridge): structured ChatEvents over ChatBus; /api/chat/events`.

---

### Task 2: Chat turn protocol + history + card linkage (server + contracts + storage)

**Files:**
- Modify: `src/contracts/api.ts` (`AgentFillRequest/Response` → `ChatTurnRequest/Response` with `reply: string`; add `ChatHistoryResponse`)
- Modify: `src/server/agentBridge.ts` (`runFillAgent` → `runChatTurn`: CHAT_GUIDE asks for `{reply, patch, artAction?}`; emits TurnStarted/TurnComplete; keepalive Thinking event replaces the prose heartbeat; `/api/chat/turn` route; `/api/chat/history` route via `client.session.messages({ path: { id } })` — extend `OpencodeClient.session` with `messages(input): Promise<unknown>` + lenient `SessionMessages` schema in `contracts/opencode.ts` mapping to role/text pairs, assistant JSON replies → their `reply` field, missing session → `{ messages: [] }`)
- Modify: `src/contracts/records.ts` + `src/storage/CardArchive.ts` (`CardRecord.chatSessionId` optional; `SaveCardInput.chatSessionId?`)
- Test: contracts, agentBridge (turn: reply+patch parse, malformed → 'no-fill' error path renamed 'no-turn'? keep `'no-fill'` reason — decide: KEEP existing `AgentError 'no-fill'` string for continuity), history mapping matrix, storage cardId-style persistence test for `chatSessionId`.

Steps: failing contract tests → api.ts evolve → failing bridge tests (turn returns reply; history maps roles; missing session empty) → implement `runChatTurn` + routes → records/CardArchive plumb `chatSessionId` → verify → commit `feat(bridge): chat turn protocol (reply+patch), history endpoint, card-linked sessions`.

---

### Task 3: Client services + ChatSession state (browser)

**Files:**
- Create: `src/chat/ChatSession.ts` (expressive State: messages array, streaming assembly, send, rehydrate, bind/clear lifecycle)
- Create: `src/chat/ChatApi.ts` (service: `turn(req)`, `history(sessionId)` over HttpClient — mirrors old AgentFill shape)
- Modify: `src/app/ActivityClient.ts` → `src/chat/ChatClient.ts` (Stream<ChatEventT> over `/api/chat/events`; same asyncPush/acquireRelease; test layer + PubSub-backed test helper)
- Delete: `src/app/ActivityFeed.ts` + test; `src/builder/AgentFill.ts` (absorbed by ChatApi)
- Modify: `src/app/runtime.ts` (AppServices: ChatApi | ChatClient replace AgentFill | ActivityClient; `testAppLayerWith` keys `chat`/`chatEvents`)
- Test: `src/chat/chat-session.test.ts` (deltas assemble a streaming bubble then finalize on TurnComplete; chips attach to the in-flight assistant message; Art events → system strip message when no turn in flight; send() posts context + merges patch through an injected BuilderView; rehydrate maps history; bind/clear on lifecycle), ChatClient stream test (PubSub-backed).

`ChatMessage = { id: string; role: 'user'|'assistant'|'system'; text: string; chips: readonly ChatChipT[]; streaming: boolean }` — chips typed from ChatEvent variants (`{kind:'tool',...}|{kind:'step'}|{kind:'thinking'}|{kind:'patch',keys}|{kind:'art',phase,detail?}`). Patch chips are client-made (from the turn response), event chips stream in. Session filter: ChatSession ignores events whose `sessionId` ≠ its bound/in-flight session (Art events pass when a turn is in flight or render as system strip otherwise).

Steps: failing ChatSession tests → implement state machine → ChatClient rename/retype + test → ChatApi → runtime rewire → delete ActivityFeed/AgentFill (+ their tests; AppShell still compiles — footer removal is Task 4, so ActivityBar temporarily reads… NO: AppShell's ActivityBar depends on ActivityFeed — fold the AppShell footer/feed removal INTO this task to stay green: delete ActivityBar + `activity` adopted child + footer markup + its AppShell.test assertions) → verify → commit `feat(chat): ChatSession state, ChatClient stream, ChatApi; activity feed removed`.

---

### Task 4: Chat panel UI + Builder integration

**Files:**
- Create: `src/chat/ChatPanel.tsx` (Panel root + Viewport + Bubble + Chip + Composer as freestanding function components reading `ChatSession.get()` / `BuilderView.get()`)
- Modify: `src/builder/BuilderView.tsx` (adopt `chat = new ChatSession()`; remove AI ASSISTANT panel + `aiPrompt`/`aiBusy`/`aiNote`/`fillSessionId` (state moves to ChatSession; document lifecycle calls `chat.bindCard(card.chatSessionId)` / `chat.clear()` in loadCard/newCard/pickTheme; `saveCard` passes `chatSessionId: this.chat.sessionId`); `fillWithAI`/artAction auto-run migrate into ChatSession.send's patch/artAction handling (art pipeline call stays a BuilderView method invoked by the chat with results reported as Art chips); layout: `render()` → form aside | preview section | `<ChatPanel />` aside (w-[400px], border-l))
- Test: `src/chat/chat-panel.test.tsx` (mounted: composer send → user bubble + busy composer; fake ChatApi reply renders assistant bubble + patch chip + preview updates (name patched); streamed events via PubSub-backed ChatClient → chips/streaming text; system art strip), builder tests updated (AI panel gone; artAction path asserted through chat), AppShell test (no footer).

ChatGPT-style visuals (our tokens): viewport `flex-1 overflow-y-auto`, stick-to-bottom via a `nearBottom` check on scroll + `scrollTop = scrollHeight` on message changes; user bubble `ml-auto max-w-[85%] rounded-2xl bg-main text-main-foreground px-3 py-2`; assistant plain `mr-auto max-w-[95%] whitespace-pre-wrap`; chips as tiny bordered pills row under the in-flight/complete assistant text; composer textarea rows=1 auto-grow (scrollHeight), Enter/Shift+Enter, Send button disabled while running.

Steps: failing mounted tests → components → BuilderView restructure → verify → commit `feat(chat): ChatGPT-style chat sidebar replaces AI box + activity bar`.

---

### Task 5: Sweep + docs + live e2e

- Grep zero: `ActivityFeed|ActivityClient|ActivityBar|activityBus|/api/activity|AgentFill|aiPrompt|aiNote|fill: “` (contracts/activity.ts gone; renderChatEvent covers console).
- README: chat sidebar section (conversation edits the card; chips = live agent actions; per-card persistence via opencode sessions + `chatSessionId`; footer bar gone).
- Memory-worthy gotchas recorded post-merge.
- `bun run verify` + `bun run build`.
- Live e2e (real opencode + replicate): open card → converse ("make him an ice mage and give him matching art") → watch user bubble, streaming chips (step/tool/writing), assistant reply bubble, patch chip, art chips through generation, preview updates → save → close/reopen card → conversation rehydrates → restart dev server → reopen → still rehydrates. Screenshot for look-approval against the ChatGPT-style target.
- Commit `docs: chat panel sweep + e2e`.
