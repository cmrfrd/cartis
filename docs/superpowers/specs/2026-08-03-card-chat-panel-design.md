# Card Chat Panel — the full assistant-ui thread model, natively over opencode

**Date:** 2026-08-03 (rev 2 — supersedes rev 1's minimal chips model) · **Status:** approved

## Context

The AI Assistant box and the footer activity bar are replaced by ONE surface: a
ChatGPT-style chat sidebar on the right of the Builder whose purpose is a conversation
that edits the open card. Rev 2 widens the target: not a minimal chat, but **the full
assistant-ui conceptual model — types, runtime interface, and UI anatomy — expressed
natively in effect Schema + Effect services + expressive**, with **opencode as the
runtime**. The insight driving the design: opencode's session model is already an
isomorph of assistant-ui's thread model (parts ≅ ContentParts; fork ≅ branching;
revert+prompt ≅ edit/regenerate; abort ≅ cancel; permission events ≅ requires-action;
the delta event stream ≅ assistant-stream). Nothing is emulated; every capability maps
to a native session operation. `@assistant-ui/react` itself is NOT vendored (rev-1
research stands: zod/zustand/radix dep tree, happy-dom risk, 0.x churn); its *model*
is ported, its runtime plumbing is replaced by our stack, and our `ThreadState` store
stays near-isomorphic to `ThreadMessageLike` so their UI remains a bolt-on option.

## Guiding principle: assistant-ui is the vocabulary, opencode is the semantics

Three roles, strictly separated — this is the design's spine:

- **assistant-ui → the presentation & interaction MODEL.** What a chat *is* to the
  user: threads of messages made of ordered parts, tool calls with visible status,
  branching, edit/regenerate, a composer. We adopt its shapes because they are the
  most battle-tested public vocabulary for chat UX, and staying isomorphic to
  `ThreadMessageLike` keeps its ecosystem available as a bolt-on.
- **opencode → the runtime SEMANTICS.** Sessions that persist, an agent that actually
  runs, fork/revert/abort as real state operations, a delta event stream of what is
  truly happening. Nothing in the UI layer simulates conversation state — every
  affordance is backed by a native session operation.
- **effect + expressive → the BINDING.** Schema validates every boundary between the
  two; Effect services are the runtime interface; expressive is the reactive store.

Each layer is independently replaceable: another agent backend could stand in for
opencode behind the same thread contracts; assistant-ui's actual components could
render the same store; the visual style can change without touching semantics. The
weak version of this design would be "make our chat look like ChatGPT"; the version
specified here is **"speak assistant-ui's model, mean opencode's operations."**

## Decisions

1. **Canonical thread contracts** (`src/contracts/thread.ts`) — the load-bearing
   artifact. effect `Schema.TaggedStruct` unions, derived from opencode's wire shapes,
   presented with assistant-ui semantics:
   - `ThreadPart` = `Text { text }` | `Reasoning { text }` |
     `ToolCall { callId, name, title?, status: 'pending'|'running'|'completed'|'error', argsText?, result?, isError?, secs? }`
     | `Image { url }` | `Step {}`.
   - `ThreadMessage` = `{ id, role: 'user'|'assistant', status: 'running'|'complete'|'incomplete', parts: ThreadPart[] }`.
   - `ThreadEvent` (server→client stream union, one `parseJson` codec):
     `TurnStarted { sessionId, messageId }` · `PartDelta { sessionId, messageId, partIndex, part }`
     (upsert-by-index: text parts carry cumulative text, throttled; tool parts carry
     state transitions) · `TurnCompleted { sessionId, messageId, status }` ·
     `Art { phase: 'composing'|'generating'|'progress'|'downloaded'|'error', detail? }` ·
     `SessionError { message }` · `PermissionRequested { sessionId, permissionId, title }`.
   - `ThreadSummary` = `{ sessionId, title?, parentId? }` (thread list / branch tree).
2. **opencode is the runtime.** The bridge becomes a typed passthrough over the
   session surface: prompt (turn), `abort` (cancel), `revert`+prompt (edit &
   regenerate), `fork`+`children` (branching), `messages` (history), `list`
   (threads), permission reply. `OpencodeClient` (the SDK slice) grows accordingly;
   every response is leniently Schema-decoded (`contracts/opencode.ts` grows the
   message/part read schemas).
3. **Client runtime = Effect services; store = expressive.**
   - `ChatThread` service: `turn(req)`, `cancel(sessionId)`, `edit(sessionId, messageId, text)`,
     `regenerate(sessionId)`, `fork(sessionId)`, `history(sessionId)` — all over
     HttpClient through the established boundary.
   - `ChatEvents` service: `events: Stream<ThreadEventT>` (SSE, EventSource→Stream
     pattern).
   - `ThreadState` (expressive State, adopted by BuilderView): assembles
     `messages: ThreadMessage[]` from events (ordered part upserts, status
     transitions), tracks `running`, current branch, pending permission; `send()` via
     the boundary pattern; rehydrates from `history`.
4. **Card-domain actions are tools, presented as ToolCalls.** V1 transports them over
   the existing JSON contract (`reply` + `patch` + `artAction` — proven), but the
   RESPONSE is materialized into the thread as `ToolCall` parts
   (`card_patch { keys }`, `card_generate_art { phase… }`) rendered by a **tool-UI
   registry** (tool name → expressive component; unknown → generic chip). A later
   phase inverts the transport to a real MCP tool server (opencode config supports
   MCP; SDK manages it) with ZERO UI/model change — the parts are already real.
5. **UI anatomy = assistant-ui's, hand-rolled on our tokens** (ChatGPT look):
   `Thread` (sidebar root) / `ThreadViewport` (stick-to-bottom-unless-scrolled) /
   `ThreadMessageView` (renders parts in order: text bubbles, reasoning as dimmed
   collapsible text, tool calls via the registry, art strips) / `ToolUI` registry /
   `Composer` (auto-growing textarea, Enter/Shift+Enter, send/cancel button swap) /
   `ActionBar` (copy · edit · regenerate on assistant/user messages) /
   `BranchPicker` (‹ 1/2 › when siblings exist). Plain text first; markdown later.
6. **Persistence per card through opencode state** (unchanged from rev 1):
   `CardRecord.chatSessionId` (in gitignored `cartis-data/`) points at opencode's
   project-scoped session (survives restarts); reopening rehydrates via history;
   stale session → fresh chat. XDG relocation rejected (auth.json coupling).
7. **All AI activity moves into the chat** (unchanged): agent parts stream inline;
   replicate progress renders as art tool-parts/strips; footer ActivityBar,
   `ActivityFeed`, `ActivityClient`, `/api/activity`, `contracts/activity.ts` are
   deleted; server console `[cartis:*]` lines preserved via a render helper.
8. **Phased delivery on the full model** — later phases are additive features, never
   reshapes:
   - **P1** contracts + bridge passthrough + ThreadEvent SSE (activity pipeline retyped).
   - **P2** client runtime + ThreadState + full-part UI + Builder integration +
     persistence + deletions (working chat).
   - **P3** capabilities: cancel, edit, regenerate, branch picker, permission prompts.
   - **P4** MCP tool inversion (fallback: JSON transport stays; presentation already
     identical).

## Edge semantics (locked at spec review)

Gap-analysis resolutions — binding, same weight as Decisions:

- **Chat on an unsaved card.** The session is created lazily on the first turn and
  held in ThreadState; it is persisted to `CardRecord.chatSessionId` only when the
  card is saved. A never-saved card leaves a dangling opencode session — harmless,
  consistent with never deleting sessions.
- **Copies start fresh.** Save-as-copy and gallery Duplicate omit `chatSessionId`;
  the conversation belongs to the original document.
- **Branch switch is an edit.** `chatSessionId` always points at the ACTIVE branch;
  switching branches updates it in ThreadState and marks the document dirty so the
  choice rides the normal save path.
- **One turn at a time.** The composer locks while `running`. Unbinding a card with
  a turn in flight (New/Open) aborts it — no orphaned stream may mutate the next
  card.
- **Failure rendering.** A failed turn finalizes its assistant message as
  `incomplete` with an inline error strip carrying the `noteFromCause` text — no
  toasts. No preflight status probe: opencode down or unauthenticated surfaces the
  same way on the first turn.
- **Final flush.** Text deltas are cumulative and throttled (2s), but part
  completion and `TurnCompleted` always emit an unthrottled final delta — the tail
  of a reply is never lost.
- **Idempotent fold.** `TurnStarted` appends only when its `messageId` is unseen;
  `PartDelta` upserts are naturally replay-safe. On SSE reconnect the client
  rehydrates from history rather than trusting PubSub replay.
- **Post-turn art attribution.** `artAction` runs after `TurnCompleted`
  (client-initiated), so `Art` events upsert onto the LAST assistant message's
  `card_generate_art` tool part; the system strip is the fallback only when no
  assistant message exists.
- **Step parts.** Kept in the schema (opencode emits them) but not rendered in v1.
- **Reverted messages.** History mapping excludes reverted messages —
  edit/regenerate leaves no ghosts after rehydrate.

## Future-proofing invariants (robustness pass)

Rules that keep the design stable as opencode, the transport, and the UI evolve:

1. **One materializer, both transports, forever.** Under the v1 JSON transport the
   assistant's opencode-side message TEXT is the raw JSON blob — so history would
   rehydrate as JSON unless the same materialization runs there too. One shared
   pure function (`materializeAssistantParts(text): ThreadPart[]` in
   `src/contracts/materialize.ts` — reply text + `card_patch`/`card_generate_art`
   ToolCall parts) is used by BOTH the live turn path and server history mapping.
   After the P4 MCP inversion it stays on as the fallback parser: old sessions
   carry JSON-contract turns, new ones carry real tool calls; history mapping
   handles both indefinitely.
2. **No raw JSON on screen, even mid-stream.** Streaming text deltas of a v1 turn
   are the JSON blob accumulating — so text parts of a RUNNING assistant message
   render as a dimmed writing indicator (reasoning and tool parts still stream
   visibly); materialization replaces them at turn end. P4's plain-text replies
   flip this rule to true incremental text with no model change.
3. **Tolerant boundaries, surviving streams.** The bridge maps the opencode
   part/event types it knows and DROPS the rest (SDK drift never crashes the
   pipeline — `mapAgentEvent` returning no event is the normal path, not an
   error); the client skips SSE events that fail decode (one bad event never kills
   the stream). Same lenient philosophy as store rows.
4. **Dependency direction is law.** `contracts/thread.ts` imports nothing from
   `contracts/opencode.ts`; only the server bridge maps opencode shapes → thread
   shapes; UI and ThreadState import thread contracts only. The guiding
   principle's replaceability claim becomes a grep, enforced in the sweep.
5. **cartis persists pointers, never transcripts.** `chatSessionId` is the only
   chat state we store; opencode owns the transcript and rehydration re-derives
   the rest. Thread schema changes therefore never require a data migration.
6. **Pure fold, portable store.** The event fold is a standalone pure function
   (`foldThreadEvent(messages, event): ThreadMessage[]` — gallery-helpers
   precedent); `ThreadState` merely applies it. Exhaustively testable without
   mounting; survives any future store change.

## Engineering requirements (binding)

Repo standards: no `any`/`!`/`as`-on-external-data; every wire shape Schema-decoded;
`ThreadPart`/`ThreadEvent` consumed via exhaustive tagged matching; Effect for all
lifecycle (scoped SSE subscriptions via acquireRelease, forked stream fibers
interrupted on destroy, boundary-pattern sends); expressive rules (snapshot before
effects, tracked reads, adopted-child ThreadState). Tests per phase: contracts codec
matrix (every part/event variant); bridge passthrough decode + revert/fork/abort
routes + history part-mapping; ThreadState assembly (ordered upserts, streaming text,
status transitions, branch switch, rehydration, lifecycle bind/clear); mounted UI
(send flow, part rendering incl. tool registry, composer/cancel swap, action bar,
branch picker); removal greps + the dependency-direction grep
(`contracts/opencode` imports confined to the server bridge). `bun run verify` green per task; live e2e per phase
(real conversation with streamed tool parts; edit/regenerate/branch live; persistence
across reopen + server restart).

## Out of scope

Markdown/code-highlight rendering (plain text first); attachments in the composer
(photo attach stays in art tools; the model supports adding it later); speech;
feedback buttons; multi-thread list UI beyond the card's own branch tree; thread
titles/summarize; cost controls; deleting opencode sessions with cards;
server-side turn exclusivity (one-turn-at-a-time is client-enforced —
single-window assumption); canceling an in-flight replicate art run (turn cancel
aborts the session only); history virtualization/caps for very long
conversations.
