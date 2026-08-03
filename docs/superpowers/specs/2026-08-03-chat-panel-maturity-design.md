# Chat Panel Maturity — Design

**Date:** 2026-08-03
**Status:** Approved (brainstorm 2026-08-03)
**Inspiration:** the xulux ChatGPT demo (`xulux-chatgpt-demo.zip`), a
ChatGPT-clone UI built on `@assistant-ui/react` primitives. Its key file is
**vendored at `docs/reference/xulux-chatgpt/chatgpt.tsx`** so line references
below stay resolvable. We port its **structure and UX**, not its runtime.

### Reference mapping (demo → cartis)

| Demo (`docs/reference/xulux-chatgpt/chatgpt.tsx`) | Cartis target | Notes |
|---|---|---|
| `Composer` (L88–125): pill Root → attachment row → `[+ button, Input, primary action]` | `ThreadPanel` Composer | Same three-slot anatomy on our tokens; `AddAttachment`+`PlusIcon` (L100–110) → hidden file input trigger |
| `ComposerPrimaryAction` (L127–190): running→Stop square, else Send ↑, else mic/voice | Morphing Send/Stop button | Mic/voice branches (L166–187) dropped (YAGNI); disabled-until-content from the `isEmpty` condition (L147–157) |
| `EmptyState` (L75–86): centered heading + composer | Empty state | Heading text becomes card-flavored |
| `ThreadScrollToBottom` (L192–203): floating chevron above sticky footer | Viewport ⌄ chevron | Demo relies on primitive scroll state; we track at-bottom manually |
| `UserMessage` (L205–254): attachments row above right-aligned dark bubble, hover ActionBar + BranchPicker | User MessageView | Bubble at `max-w-[70%]` demo / 85% ours (400px panel) |
| `EditComposer` (L256–271): soft rounded editor, Cancel/Send pills | EditBox restyle | Behavior (fork-on-edit) already ours |
| `AssistantMessage` (L276–381): bubble-less markdown + icon action row | Assistant MessageView | Keep Copy(✓ swap, L298–303)+Regenerate; drop thumbs/speak/share/export (L306–375) |
| `BranchPicker` (L383–405): ‹ `Number`/`Count` › inline, hide-when-single | Per-message ‹ n/m › | Position from our computed `branchPoint`, not a runtime |
| `useFileSrc`/`useAttachmentSrc`/`ChatGPTAttachmentUI` (L407–476): image thumb / file tile + floating × Remove | Attachment thumbs/chips | Our data-URLs ARE the src — no object-URL lifecycle (L416–421) needed |

## Goal

Mature the Builder's chat sidebar (`src/chat/ThreadPanel.tsx` + `ThreadState.ts`)
to ChatGPT-grade UX: a pill composer with a **`+` attachment button** (images +
text files), auto-growing input, morphing Send/Stop, empty state, real
stick-to-bottom scrolling with a scroll-to-bottom chevron, hover icon action
bars, markdown-rendered assistant text, and a per-message ‹ n/m › branch picker
replacing the top branch strip.

## Approach (user-locked decisions)

- **A: hand-rolled port** — keep expressive `ThreadState` + our neobrutalism
  tokens; do NOT adopt `@assistant-ui/react`. Same principle as the chat-panel
  spec: speak assistant-ui's model, mean opencode's operations.
- Scope: full composer + chrome, markdown assistant text, per-message ‹ n/m ›
  branch picker. **Skipped (YAGNI):** dictation/voice, feedback thumbs, share,
  export-markdown, thread-list rail (cartis chat is session-per-card).
- Attachments accept **images + text files**; everything else is rejected with
  a note.
- New deps: `lucide-react` (icons — the set the vendored shadcn ecosystem
  assumes) and `react-markdown` + `remark-gfm` (render-only markdown, no
  dangerouslySetInnerHTML). No other deps.

## 1. Attachments end-to-end (the `+`)

### Contracts

- `src/contracts/api.ts`: new `ChatAttachment` schema
  `{ name: FileName, mime: MimeType, dataUrl: DataUrl }`;
  `ChatTurnRequest` grows `attachments: Schema.optional(Schema.Array(ChatAttachment))`.
- `src/contracts/thread.ts`: new part variant
  `FilePart = Schema.TaggedStruct('File', { name: Schema.String, mime: Schema.String })`
  added to the `ThreadPart` union — renders non-image attachments in bubbles.
  Image attachments reuse the existing `Image` part (a data-URL is a valid
  `img src`). Adding the variant deliberately breaks every `Match.exhaustive`
  over `ThreadPart` (fold, ThreadPanel PartView, threadBus renderPartMessage)
  so tsc walks us to each site.

### Client gate (ThreadState)

- New state: `pendingAttachments: ChatAttachmentT[]`.
- `addAttachments(files: FileList | File[])`: async; per file —
  - accepted mimes: `image/*`, `text/*`, `application/json`, plus `.md` by
    extension (browsers give `.md` an EMPTY mime — the gate must infer one
    before minting the branded `MimeType`: `.md` → `text/markdown`, any other
    extension-accepted file → `text/plain`; an empty string would fail the
    brand at decode);
  - caps: **8 MB per file**, **6 attachments per message**; violations skip the
    file and set `note` naming it (e.g. `attachment too large: ref.png (max 8 MB)`,
    `unsupported attachment type: art.psd`);
  - accepted files are FileReader'd to a data-URL (doubles as the thumbnail
    `src`; no object-URL lifecycle).
- `removeAttachment(index)` — composer × button.
- `submitDraft` sends when **text OR attachments** exist; submit clears both.
  An attachment-only send (empty draft) still sends the full prompt scaffold;
  the `USER_REQUEST_MARKER` is followed by the stand-in text
  `(see attached files)` so the stored request — and its rehydrated user
  bubble — is never empty.
- `clear()` also clears `pendingAttachments`.
- **Edit and regenerate drop attachments (v1):** `beginEdit` seeds from text
  only, and `runRegenerate` replays only the stored user text — a resend by
  either path loses the original attachments. Stated, intentional.

### Wire + opencode (bridge)

- Optimistic user bubble parts: `[...images as Image, ...others as File, Text]`
  (Text omitted when the draft was empty).
- `runChatTurn` / `promptWithHeartbeat` generalize the existing single vision
  part to a list of SDK `FilePartInput`s:
  1. user attachments **with `filename` set** (the discriminator),
  2. the existing auto-attached card-art context part (**no filename**, as today),
  3. the text prompt part.
- `mapSessionMessages` (user branch): opencode history returns `FilePart`s with
  our data-URL in `url`. Map file parts **with a filename**: image mime →
  `Image { url }`, other → `File { name, mime }`; keep skipping unnamed file
  parts (the invisible card-art context never masquerades as a user
  attachment). Attachments therefore survive save → restart → rehydrate.

### Errors

- Oversized/unsupported files never leave the client (note + skip).
- A failed turn with attachments follows today's failure path (incomplete
  bubble + note). Request body grows with data-URLs; the vite middleware body
  reader already handles multi-MB bodies (image generate route precedent).

## 2. Composer, chrome, markdown, branch arrows

### Composer (pill)

One `rounded-2xl border-2 border-border bg-background shadow-shadow` container:

- **Row 1 (only when attachments pending):** thumbnail strip — 64px image
  thumbs / file chips (name + mime), each with a floating × remove button.
- **Row 2:** `+` icon button (opens a hidden
  `<input type="file" multiple accept="image/*,text/*,application/json,.md">`)
  · auto-growing textarea (`field-sizing: content`, 1 row min, max ~6 rows —
  Chrome-only local app, no fallback needed; placeholder "Message the
  assistant…") · **morphing circular primary action**: running → square-in-circle
  **Stop**; otherwise **↑ Send**, disabled until text or attachments exist.
- Enter sends, Shift+Enter newlines (unchanged). `data-testid`s preserved:
  `composer-send`, `composer-cancel`; new `composer-attach`,
  `composer-attachment` (per thumb), `attachment-remove`.

### Empty state

`messages.length === 0` → viewport replaced by a centered heading
("What should this card become?") with the composer mid-panel; once a thread
exists the composer moves to the sticky footer.

### Viewport

Real stick-to-bottom replaces the force-scroll callback ref: track
"at bottom" via scroll position (±16px tolerance); autoscroll on new
content only while at bottom; a floating ⌄ chevron (absolute, above the
composer, hidden when at bottom) jumps back down. Fixes the current
can't-scroll-up-while-streaming defect.

### Messages

- **User:** bubble capped at 85% width, right-aligned; attachment
  thumbs/chips above the bubble (from `Image`/`File` parts).
- **Assistant:** **no bubble** — markdown via `react-markdown` + `remark-gfm`
  inside a scoped `chat-md` wrapper styled on our tokens (headings, lists,
  code, tables). Error text keeps the danger treatment.
- **Action bars:** hover-revealed **icon** buttons (lucide, native `title`
  tooltips): Copy with ✓-for-1.5 s swap (both roles); Edit pencil (user);
  Regenerate ↻ **only on the last assistant message** — today it renders on
  every assistant message but `regenerate()` only targets the last; the
  redesign removes that lie. `data-testid`s preserved: `action-edit`,
  `action-regenerate`; new `action-copy`.
- **Edit-in-place:** restyled to a soft rounded editor
  (`bg-secondary-background`) with Cancel / Send pill buttons; behavior
  (fork-on-edit) unchanged.
- Permission strip unchanged.

### Per-message ‹ n/m › branch picker

The top branch strip is deleted. `ThreadState.loadBranches` upgrades:

1. Fetch the sibling set via a **new `/api/chat/siblings?sessionId=…` route
   that REPLACES `/api/chat/children`** (the client cannot compute siblings
   itself — nothing exposes `Session.parentID` to it). Server-side the bridge
   does `session.get(sid) → parentID`, then `children(parentID ?? sid)`, and
   returns the full sibling set INCLUDING the root: `ThreadSummary` gains no
   new fields, but the response lists the parent first (`parentId` absent
   marks it). When unforked with no children, the set is just the session
   itself → no arrows. The revert marker is NOT used (it does not reliably
   survive a resend).
2. Fetch each sibling's history via the existing history endpoint (sibling
   counts are tiny — one per edit).
3. Compute the **divergence point** with a pure function
   `divergencePoint(current, sibling histories)` comparing (role, text-part
   text) prefixes; result stored as
   `branchPoint?: { messageId, index, count }`. Ordering is COSMETIC:
   parent first, then children sorted by sessionId; if live testing shows
   wrong chronology, the bridge switches the sort to the session's
   `time.created` (server-side data, no contract change).
4. Render ‹ n/m › arrows on the message named by `branchPoint.messageId`
   (fallback when comparison is inconclusive: the last user message; hidden
   when no siblings). Arrows call the existing `switchBranch` with the
   prev/next sibling id.

History-fetch failure for a sibling → that sibling is dropped from the
computation; zero usable siblings → no arrows (today's silent behavior).

## 3. Testing

- **Unit (vitest):** attachment gate (mime/size/count caps + note wording);
  send request shape with attachments; `File` part fold + render;
  `divergencePoint` table-driven (identical, single-fork, multi-fork,
  inconclusive).
- **Bridge:** `runChatTurn` emits filename'd FilePartInputs before the unnamed
  art part and the text part (stub agent asserts part order/shape);
  `mapSessionMessages` maps named file parts → Image/File and skips unnamed;
  `/api/chat/siblings` returns parent-first sibling sets for forked, unforked,
  and parentless sessions (stub client).
- **Mounted (happy-dom):** `+` wires the hidden input; thumbs render/remove;
  Send morphs (disabled-empty → enabled → Stop) ; empty state appears and
  yields to messages; markdown renders (bold → `<strong>`); ✓ copy feedback;
  regenerate only on last assistant message; ‹ n/m › switches branches.
- `bun run verify` green per task; **live e2e** at the end: attach a real
  image, confirm the model references it; save → dev-server restart → reopen →
  attachment thumb survives rehydration.

## Non-goals

Voice/dictation, feedback thumbs, share/export, thread-list rail, attachment
re-send on edit, non-Chrome fallbacks for `field-sizing`.
