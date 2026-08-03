# Card Chat Panel — conversational card editing as the right-hand sidebar

**Date:** 2026-08-03 · **Status:** approved (brainstorm 2026-08-02/03)

## Context

The AI Assistant box is a single prompt field; the AI activity bar is a separate footer
log. Both are replaced by ONE surface: a ChatGPT-style chat sidebar on the right of the
Builder whose sole purpose is a conversation that edits the open card. All agent
conversation AND all AI activity (tool calls, steps, art-generation progress) live in
this panel. The footer activity bar is deleted.

## Decisions (locked during brainstorm)

1. **Hand-rolled, assistant-ui-styled.** The panel is expressive-native, built on our
   tailwind/neobrutalism tokens, with component anatomy modeled on assistant-ui's
   Thread (viewport / message bubbles / tool chips / pinned composer, ChatGPT look).
   `@assistant-ui/react` is NOT vendored (researched: hooks/context architecture is
   bridgeable via ExternalStoreRuntime, but its dep tree — zod 4, zustand 5, full
   radix-ui bundle — duplicates our stack, risks the happy-dom harness (Radix
   precedent), and fights the theme). Plain-text messages first; markdown later if
   wanted. The clean message store keeps the ExternalStore bridge open as a future
   option.
2. **Persistence per card, through opencode state.** `CardRecord` gains optional
   `chatSessionId`. Conversation content persists in opencode's own project-scoped
   storage (survives app restarts; sessions key to this repo's directory);
   the card's pointer lives in `cartis-data/cards/*.json` (in-repo, gitignored).
   Reopening a card rehydrates its conversation via the bridge from
   `session.messages`. A stale/deleted session degrades to a fresh chat on the next
   turn. Relocating opencode's storage dir into the repo (XDG_DATA_HOME) was
   researched and REJECTED: `auth.json` lives in the same dir — relocation breaks
   login.
3. **All AI activity moves into the chat.** Agent tool calls/steps/thinking/writing
   render as inline chips on the assistant turn (ChatGPT-style). Image-generation
   progress (compose, replicate polling, download) renders as chips too — attached to
   the triggering turn, or as a small system strip when triggered manually from the
   art tools. The footer ActivityBar, `ActivityFeed`, `ActivityClient`, the
   `/api/activity` SSE route, and `contracts/activity.ts` are deleted (server console
   `[cartis:*]` lines remain for terminal parity).
4. **The chat turn gains a human reply.** Today's fill protocol returns JSON only.
   The chat protocol asks the model for
   `{ "reply": string, "patch": { … }, "artAction"?: { … } }` — `reply` is the
   conversational bubble text; `patch` stays the targeted, Schema-validated edit
   (auto-applied, summarized as a chip listing changed keys); `artAction` unchanged.
5. **Chat is Builder-scoped.** The sidebar lives in the Builder view (form left,
   preview center, chat right ~400px). The Gallery is unaffected. The AI ASSISTANT
   panel in the form is removed; its state (`aiPrompt`/`aiBusy`/`aiNote`,
   `fillSessionId`) migrates into the chat session model.

## Architecture

### Contracts (`src/contracts/chat.ts`, replaces `activity.ts`)

`ChatEvent` — a Schema tagged union streamed server→client (one codec both ends,
`Schema.parseJson`):
`turnStarted { sessionId }` · `textDelta { sessionId, text }` (cumulative chars, throttled)
· `tool { sessionId, name, status: running|done|error, title?, secs? }`
· `step { sessionId }` · `thinking { sessionId }`
· `art { phase: composing|generating|progress|downloaded|error, detail? }`
· `turnComplete { sessionId }` · `agentError { message }`.
`src/contracts/api.ts`: `AgentFillRequest/Response` evolve into `ChatTurnRequest/Response`
(same fields + `reply: string` on the response); `ChatHistoryResponse`
(`{ messages: { role: 'user'|'assistant', text }[] }`).

### Server (bridge)

- `ActivityBus` → **`ChatBus`** (same PubSub/replay/Ref architecture, typed
  `ChatEvent` payloads; per-event console rendering preserved).
- The session activity watcher's `mapAgentEvent` reducer emits structured `ChatEvent`s
  (same dedupe per callID, thinking per message, 2s text throttle — text deltas now
  ALSO carry the running char count for the streaming bubble).
- `runFillAgent` → **`runChatTurn`**: same session/vision/patch machinery; the guide
  prompt requests `reply` + `patch` (+ `artAction`); emits `turnStarted`/`turnComplete`;
  heartbeat becomes a `thinking`-style keepalive event.
- Routes: `POST /api/chat/turn` (replaces `/api/agent/fill`),
  `GET /api/chat/events` SSE (replaces `/api/activity`),
  `GET /api/chat/history?sessionId=` (bridge → `session.messages` → simplified
  role/text list; assistant JSON replies map to their `reply` field, non-JSON text
  passes through; a missing session returns an empty list, not an error).
- `ReplicateClient` progress emits `art`-phase `ChatEvent`s.

### Client

- `ActivityClient` → **`ChatClient`** service: `events: Stream<ChatEvent>` over the
  SSE route (same EventSource/asyncPush/acquireRelease pattern);
  `AgentFill` → **`ChatApi`** service: `turn(req)`, `history(sessionId)`.
- **`ChatSession`** (new expressive State, adopted by `BuilderView`): the message
  store — `messages: ChatMessage[]` where
  `ChatMessage = { id, role: 'user'|'assistant'|'system', text, chips: Chip[], streaming: boolean }`;
  consumes `ChatClient.events` via `forkApp` (fiber interrupted on destroy); `send()`
  runs the boundary pattern (snapshot card context → `ChatApi.turn` → merge patch via
  BuilderView → chips + reply bubble); rehydrates from `ChatApi.history` when bound to
  a card with a `chatSessionId`. Lifecycle mirrors the document: bound session id
  travels with `loadCard`/`saveCard` (persisted on the record), clears on
  `newCard`/theme switch.

### UI (`src/chat/` — assistant-ui Thread anatomy, our tokens)

- `ChatPanel` — the right sidebar root (header: "Card chat" + busy indicator).
- `ChatViewport` — scroll container with stick-to-bottom-unless-user-scrolled-up.
- `ChatMessageBubble` — user right-aligned accent bubble; assistant left, plain;
  system/art strips small + centered; streaming cursor on in-flight assistant text.
- `ChatChip` — compact inline chips: `tool read ✓ 2.1s`, `step`, `thinking…`,
  `patched: name, cost`, `art: generating…`.
- `ChatComposer` — pinned bottom: auto-growing textarea (Enter sends,
  Shift+Enter newline), send button, disabled while a turn runs.

## Engineering requirements (binding)

Repo standards: no `any`/`!`/`as`-on-external-data; every wire shape Schema-decoded;
`ChatEvent` consumed via exhaustive tagged matching; Effect for all lifecycle (stream
fork/interrupt, boundary-pattern sends, scoped watcher unchanged); expressive rules
(snapshot before effects, tracked reads via `.get()` destructuring, adopted-child
ChatSession). Tests: contracts codec matrix; bridge turn protocol (reply+patch parse,
malformed → typed error), history mapping (JSON replies → reply field, missing session
→ empty), watcher → structured events; ChatSession stream consumption (bubbles
assemble from deltas, chips attach, rehydration, lifecycle discard/bind); mounted
panel (composer send flow, busy state, bubbles render, patch chip); removal greps
(ActivityBar/ActivityFeed/activity routes gone). `bun run verify` green per task; live
e2e with a real conversation (streamed chips + reply, patch applied, persistence
across card close/reopen AND dev-server restart).

## Out of scope

Markdown rendering (plain text + whitespace-pre-wrap first); message editing,
branching, regeneration; attachments in the composer (photo attach stays in art
tools); chat in the Gallery view; deleting opencode sessions when cards are deleted;
multi-model selection UI; cost controls.
