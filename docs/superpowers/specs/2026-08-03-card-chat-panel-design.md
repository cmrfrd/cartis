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
branch picker); removal greps. `bun run verify` green per task; live e2e per phase
(real conversation with streamed tool parts; edit/regenerate/branch live; persistence
across reopen + server restart).

## Out of scope

Markdown/code-highlight rendering (plain text first); attachments in the composer
(photo attach stays in art tools; the model supports adding it later); speech;
feedback buttons; multi-thread list UI beyond the card's own branch tree; thread
titles/summarize; cost controls; deleting opencode sessions with cards.
