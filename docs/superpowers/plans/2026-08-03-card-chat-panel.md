# Card Chat Panel Implementation Plan (rev 2 — full thread model)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full assistant-ui thread model natively over opencode (spec rev 2): a ChatGPT-style chat sidebar that edits the open card, streams every agent action as typed thread parts, supports cancel/edit/regenerate/branching on native session ops, persists per card, and absorbs the activity log.

**Architecture:** `contracts/thread.ts` (ThreadPart/ThreadMessage/ThreadEvent tagged unions) is the canon. Bridge = typed passthrough over opencode sessions (prompt/abort/revert/fork/messages) + ThreadEvent SSE (retyped activity pipeline). Client = `ChatThread`/`ChatEvents` Effect services + `ThreadState` expressive store + hand-rolled UI primitives with a tool-UI registry. Card actions ride the proven JSON contract materialized as ToolCall parts (MCP inversion is P4).

**Tech Stack:** effect 3.22, opencode SDK (sessions: prompt/abort/revert/fork/children/messages; lazy event stream — DRAIN `result.stream`), expressive, vitest 4 + test/effect.ts + testAppLayerWith.

## Global Constraints

- Spec rev 2 Engineering-requirements are binding. Gate per task: `bun run verify` green. Push allowed; commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Console `[cartis:*]` terminal lines preserved via `renderThreadEvent` helper.
- Reshape, don't duplicate: watcher reducer, session machinery, vision attach, `schemaFromFields`, SSE/EventSource patterns, boundary pattern all exist.
- Known SDK gotchas: event stream is a LAZY generator (drain it); stale opencode on :4096 breaks spawn (kill it); vite plugin changes need dev-server restart; Radix-style tabs need mousedown in automation.

---

### Task 1 (P1): Thread contracts + retyped event pipeline

**Files:** Create `src/contracts/thread.ts`; delete `src/contracts/activity.ts`; rename `src/server/activity.ts` → `src/server/threadBus.ts` (`ThreadBus`, typed `ThreadEventT`, per-variant console render via `renderThreadEvent`); modify `src/server/agentBridge.ts` (`mapAgentEvent` → emits `PartDelta`/`Step`-bearing ThreadEvents with a per-message part-index tracker in `WatchState`; replicate emits `Art`; SSE route → `/api/chat/events`; permission events pass through as `PermissionRequested`); modify BridgeRuntime names; retype the three server test files + contracts tests.

**Produces:** `ThreadPart`/`ThreadMessage`/`ThreadEvent`/`ThreadSummary` schemas + `ThreadEventJson`; `ThreadBus` tag (`emit/history/changes`); `mapAgentEvent(raw, sessionId, state, now): { event?: ThreadEventT; state: WatchState }` where WatchState gains `partIndexByKey: Map<string, number>` (text/reasoning/tool call → stable part index per message) and keeps dedupe/2s text throttle (deltas carry cumulative text; part completion and turn idle emit an UNTHROTTLED final delta so the tail of a reply is never lost). Unknown raw event/part kinds map to NO event — dropped, never a decode crash (SDK-drift tolerance; `mapAgentEvent` returning nothing is the normal path).

Steps: codec matrix tests (decode/encode every variant, reject unknown tags) → contracts → bus retype tests → bus → watcher retype tests (tool lifecycle → ToolCall part transitions at a stable index; text deltas cumulative; session filter; throttle) → watcher + replicate + SSE route → `renderThreadEvent` unit tests preserving the old console strings → verify → commit `feat(bridge): canonical thread contracts; ThreadEvent pipeline replaces activity`.

### Task 2 (P1): Session passthrough routes + turn + history

**Files:** modify `src/contracts/api.ts` (`ChatTurnRequest/Response` — request as before + `reply` on response; `ChatHistoryResponse { messages: ThreadMessage[] }`; `SessionRef { sessionId }` responses for fork); `src/contracts/opencode.ts` (+ lenient `SessionMessages` read schema: role + parts incl. tool state); create `src/contracts/materialize.ts` (`materializeAssistantParts(text): ThreadPart[]` — pure; parses the v1 JSON contract out of assistant text into a reply Text part + `card_patch`/`card_generate_art` ToolCall parts; falls back to plain text when no contract parses; imports thread+api contracts ONLY); `src/server/agentBridge.ts`: `OpencodeClient.session` grows `messages/abort/revert/fork/children` (all `(input: unknown) => Promise<unknown>` slices), `runChatTurn` (CHAT_GUIDE asks `{reply, patch, artAction?}`; emits TurnStarted/TurnCompleted; Thinking keepalive), routes `POST /api/chat/turn`, `GET /api/chat/history`, `POST /api/chat/abort|revert|regenerate|fork|permission` (regenerate = revert last assistant + re-prompt with stored last user text — the bridge derives it from history; permission = passthrough permission reply for Task 5's prompts), old `/api/agent/fill` deleted; history mapping EXCLUDES reverted messages (no ghosts after edit/regenerate); `records.ts` + `CardArchive` gain `chatSessionId`.

Steps: TDD per route (turn reply+patch, history maps opencode parts→ThreadMessage — assistant text runs through `materializeAssistantParts` so raw JSON never reaches the UI, REAL tool parts map directly (both transports handled indefinitely), missing session → empty, fork returns new sessionId, revert passthrough) → implement → verify → commit `feat(bridge): session passthrough (turn/history/abort/revert/fork), card-linked sessions`.

### Task 3 (P2): Client runtime + ThreadState

**Files:** Create `src/chat/ChatThread.ts` (service: turn/cancel/edit/regenerate/fork/history), `src/chat/ThreadState.ts`; rename `ActivityClient` → `src/chat/ChatEvents.ts` (Stream<ThreadEventT>; undecodable SSE events are SKIPPED — one bad event never kills the stream); delete `ActivityFeed` + `AgentFill` + AppShell footer/`activity` child (fold in to stay green); rewire `runtime.ts` (AppServices: ChatThread | ChatEvents; test keys `thread`/`threadEvents`).

**ThreadState core:** `messages: ThreadMessage[]`, `running`, `sessionId?`, `pendingPermission?`; event fold — extracted as a pure `foldThreadEvent(messages, event): ThreadMessage[]` in `src/chat/fold.ts` (gallery-helpers precedent; ThreadState merely applies it): TurnStarted appends a running assistant message (IDEMPOTENT — only when its messageId is unseen; SSE replay-safe); PartDelta upserts `parts[partIndex]` (immutably — new arrays for expressive reactivity); TurnCompleted finalizes status; Art → upsert onto the LAST assistant message's `card_generate_art` tool part (art runs post-turn, client-initiated) else system strip; session filter. `send(text)`: append user message locally → boundary-pattern `ChatThread.turn` (card context from an injected BuilderView getter) → materialize the response via shared `materializeAssistantParts` — `reply` (final text part), `patch` (ToolCall part `card_patch` completed + apply via builder), `artAction` (delegates to builder's art run, phases arrive as Art events); turn FAILURE finalizes the assistant message as `incomplete` with an error strip part carrying `noteFromCause` text (no toasts; no preflight probe). Sessions are created lazily on the first turn (unsaved cards chat fine; id persisted only on save). `bind(sessionId)`/`clear()` lifecycle + `rehydrate()`; `clear()` aborts an in-flight turn (no orphaned stream may mutate the next card); SSE reconnect → rehydrate from history rather than trusting PubSub replay.

Steps: ThreadState fold tests (ordered upserts, streaming accumulation, finalize, art routing, filter) → send/rehydrate/lifecycle tests with fake layers → services → deletions + rewire → verify → commit `feat(chat): ChatThread/ChatEvents services + ThreadState; activity feed removed`.

### Task 4 (P2): UI primitives + Builder integration (working chat)

**Files:** Create `src/chat/ThreadPanel.tsx` (Thread root, Viewport w/ stick-to-bottom, ThreadMessageView rendering parts in order — Step parts NOT rendered in v1, error strips on incomplete messages, text parts of a RUNNING assistant message render as a dimmed writing indicator (v1 JSON transport streams raw JSON; reasoning/tool parts still stream visibly; materialization replaces at turn end), ToolUI registry (`card_patch` → keys chip, `card_generate_art`/art → progress strip, default chip), Composer (auto-grow, Enter/Shift+Enter, Send⇄Cancel swap on `running` — composer locked while a turn runs)); modify `BuilderView` (adopt `thread = new ThreadState()`; document lifecycle binds/clears + `saveCard` persists `chatSessionId`; `saveAsCopy` and gallery Duplicate OMIT `chatSessionId` — copies start fresh; AI ASSISTANT panel + `aiPrompt/aiBusy/aiNote/fillSessionId` removed — `fillWithAI`/artAction migrate into ThreadState.send; layout: form | preview | `<ThreadPanel />` (w-[400px] border-l)); update builder/AppShell tests.

Steps: mounted panel tests (send → user bubble + running composer; fake turn → reply text part + card_patch tool chip + preview patched; streamed events → ordered parts; cancel button visible while running) → components → BuilderView restructure → verify → commit `feat(chat): ChatGPT-style thread sidebar replaces AI box + activity bar`.

### Task 5 (P3): Capabilities — cancel, edit, regenerate, branches, permissions

**Files:** `src/chat/ThreadPanel.tsx` (+ ActionBar on messages: copy/edit (user)/regenerate (assistant); BranchPicker ‹ n/m › reading `ThreadSummary` children; permission prompt strip with allow/deny → `/api/chat/permission` (route lands in Task 2)); `ThreadState` (+ `cancel()`, `edit(messageId, text)` = revert-to + resend, `regenerate()`, `switchBranch(sessionId)` = rebind+rehydrate + update `chatSessionId` + mark document dirty (branch choice rides the normal save path), fork-on-edit semantics: editing an already-answered message forks first (native branching), `branches: ThreadSummary[]` loaded via children route).

Steps: TDD state ops with fake services (edit forks + resends; regenerate reverts; cancel aborts + marks incomplete; branch switch rebinds) → UI affordances + mounted tests → live smoke (real edit/regenerate/branch) → verify → commit `feat(chat): edit, regenerate, cancel, branching, permission prompts`.

### Task 6 (P2/P3 close): Sweep + docs + live e2e

- Greps zero: `ActivityFeed|ActivityClient|ActivityBar|activityBus|/api/activity|AgentFill|aiPrompt|aiNote|contracts/activity`.
- Dependency-direction grep: `contracts/opencode` imported ONLY by `src/server/**` (+ server tests); `contracts/thread.ts` and `contracts/materialize.ts` import no opencode shapes.
- README: chat sidebar section (full thread model, capabilities, persistence, tool chips; footer bar gone). Memory notes post-merge.
- `bun run verify` + `bun run build`; live e2e: full conversation with streamed tool parts → patch applies → art via chat → save/close/reopen rehydrates → dev-server restart rehydrates → edit a message → branch picker appears → regenerate. Screenshot vs ChatGPT-style target.
- Commit `docs: chat panel sweep + e2e`.

### Task 7 (P4, separate follow-up): MCP tool inversion

Bridge hosts an MCP endpoint exposing `card_patch`/`card_generate_art`/`card_read`; opencode configured via `OPENCODE_CONFIG_CONTENT.mcp`; CHAT_GUIDE drops the JSON contract (reply becomes plain text; patches arrive as REAL tool calls streaming through the existing ToolCall parts + registry). Fallback documented: JSON transport retained if remote-MCP wiring resists. History mapping and `materializeAssistantParts` already handle both transports; the flip also unlocks true incremental text rendering (drop the running-text writing indicator). Planned in detail when P1-P3 land.
