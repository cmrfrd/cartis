# Chat Panel Maturity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mature the Builder chat sidebar to ChatGPT grade — attachments (`+`/paste/drop), pill composer, markdown assistant text, per-message ‹ n/m › branch arrows, note strip, resizable panel — per `docs/superpowers/specs/2026-08-03-chat-panel-maturity-design.md`.

**Architecture:** Hand-rolled port of the xulux demo's structure (vendored at `docs/reference/xulux-chatgpt/chatgpt.tsx`) onto the existing expressive `ThreadState` + effect contracts. Attachments ride the bridge's existing opencode `FilePartInput` vision plumbing, generalized from one unnamed image to a list where **`filename` present = user attachment, absent = invisible card-art context**. Branch arrows derive their position by comparing sibling session histories (pure `divergencePoint`), fed by a new server-computed `/api/chat/siblings` route.

**Tech Stack:** effect v3.22 Schema/Match/Option, expressive State, react-markdown + remark-gfm, lucide-react, opencode SDK FilePartInput.

## Global Constraints

- `bun run verify` (biome ci + tsc + vitest) green after every task; check the TRUE exit code (`bun run verify > /dev/null 2>&1; echo $?`) — never through a pipe.
- Option boundary rule: Option in pure/service code, `T | undefined` at expressive fields/JSX; convert once with `Option.getOrUndefined`.
- Brand at minting/decode/UI boundaries (`X.make()`); wire decode brands free.
- `Match.exhaustive` for tagged-union dispatch in client/pure code.
- Attachment caps verbatim: **8 MB per file**, **6 attachments per message**; accepted types `image/*`, `text/*`, `application/json`, `.md` by extension; empty-mime inference `.md` → `text/markdown`, other → `text/plain`.
- Attachment-only send stand-in text verbatim: `(see attached files)`.
- Panel resize clamps verbatim: min 340, max 600, default 400, double-click resets.
- Preserved test ids: `composer-send`, `composer-cancel`, `action-edit`, `action-regenerate`, `permission-strip`, `permission-allow`, `edit-box`, `edit-submit`, `tool-card-patch`, `tool-card-art`. New: `composer-attach`, `composer-attachment`, `attachment-remove`, `note-strip`, `chat-resize`, `branch-prev`, `branch-next`, `action-copy`, `scroll-bottom`, `drop-overlay`.
- New deps ONLY: `lucide-react`, `react-markdown`, `remark-gfm`.
- Expressive boundary rules: snapshot reactive fields before effects; `this.get(null)` guards after awaits; destructure from `.get()` in render (tracked reads).
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `feat/chat-panel-maturity` off main; merge ff + push + delete at the end.

---

### Task 1: Contracts — `File` part, `ChatAttachment`, render sites

**Files:**
- Modify: `src/contracts/thread.ts` (FilePart + union)
- Modify: `src/contracts/api.ts:77-85` (ChatAttachment + ChatTurnRequest.attachments)
- Modify: `src/server/threadBus.ts:60-82` (renderPartMessage File branch)
- Modify: `src/chat/ThreadPanel.tsx:200-237` (PartView File branch — minimal chip now, restyled in Task 6/7)
- Test: `src/contracts/contracts.test.ts`, `src/server/threadBus.test.ts`

**Interfaces:**
- Produces: `FilePart = Schema.TaggedStruct('File', { name: Schema.String, mime: Schema.String })` in `ThreadPart` union; `ChatAttachment = Schema.Struct({ name: FileName, mime: MimeType, dataUrl: DataUrl })`, `ChatAttachmentT`; `ChatTurnRequest.attachments?: readonly ChatAttachmentT[]`.

- [ ] **Step 1: failing tests** — contracts.test: `ChatAttachment` decodes `{name:'a.md', mime:'text/markdown', dataUrl:'data:text/markdown;base64,QQ=='}`; rejects empty mime; `ChatTurnRequest` decodes with and without `attachments`. threadBus.test: `render(delta({_tag:'File', name:'notes.md', mime:'text/markdown'}))` is `undefined` (files are silent in the terminal).
- [ ] **Step 2: run tests — FAIL** (unknown variant / schema).
- [ ] **Step 3: implement.** thread.ts after ImagePart:

```ts
/** A non-image user attachment (name + mime chip; bytes live in opencode). */
export const FilePart = Schema.TaggedStruct('File', {
  name: Schema.String,
  mime: Schema.String,
});
```

Add `FilePart` to the `ThreadPart` union. api.ts:

```ts
export const ChatAttachment = Schema.Struct({
  name: FileName,
  mime: MimeType,
  dataUrl: DataUrl,
});
export type ChatAttachmentT = typeof ChatAttachment.Type;
```

`ChatTurnRequest` gains `attachments: Schema.optional(Schema.Array(ChatAttachment))`. Then chase tsc: threadBus `renderPartMessage` adds `Match.tag('File', () => undefined)`; ThreadPanel `PartView` adds `Match.tag('File', (p) => <span className="rounded-base border border-edge bg-secondary-background px-2 py-1 font-mono text-[11px] text-ink-dim">{p.name}</span>)`.
- [ ] **Step 4: `bun run verify` green.**
- [ ] **Step 5: Commit** `feat(contracts): File thread part + ChatAttachment on the turn request`.

---

### Task 2: Attachment gate + ThreadState wiring

**Files:**
- Create: `src/chat/attachments.ts` (pure policy)
- Modify: `src/chat/ThreadState.ts` (pendingAttachments/addAttachments/removeAttachment/submitDraft/send/clear)
- Test: `src/chat/attachments.test.ts`, `src/chat/ThreadState.test.ts`

**Interfaces:**
- Consumes: `ChatAttachmentT` (Task 1).
- Produces: `attachmentPolicy(name: string, mime: string, size: number): { ok: true; mime: string } | { ok: false; note: string }`; `MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024`; `MAX_ATTACHMENTS = 6`; ThreadState fields `pendingAttachments: ChatAttachmentT[]`, methods `addAttachments(files: Iterable<File>): Promise<void>`, `removeAttachment(index: number): void`.

- [ ] **Step 1: failing tests** — attachments.test (pure, table-driven):

```ts
import { describe, expect, it } from 'vitest';
import { attachmentPolicy, MAX_ATTACHMENT_BYTES } from '@/chat/attachments';

describe('attachmentPolicy', () => {
  it.each([
    ['photo.png', 'image/png', 1024, true, 'image/png'],
    ['notes.md', '', 1024, true, 'text/markdown'],       // empty-mime inference
    ['lore.txt', 'text/plain', 1024, true, 'text/plain'],
    ['stats.json', 'application/json', 1024, true, 'application/json'],
  ])('accepts %s', (name, mime, size, _ok, expectedMime) => {
    const r = attachmentPolicy(name, mime, size);
    expect(r).toEqual({ ok: true, mime: expectedMime });
  });
  it('rejects unsupported types with a naming note', () => {
    expect(attachmentPolicy('art.psd', 'image/vnd.adobe.photoshop', 10)).toEqual({
      ok: false, note: 'unsupported attachment type: art.psd',
    });
    expect(attachmentPolicy('a.zip', '', 10).ok).toBe(false);
  });
  it('rejects oversized files', () => {
    expect(attachmentPolicy('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)).toEqual({
      ok: false, note: 'attachment too large: big.png (max 8 MB)',
    });
  });
});
```

Note the psd case: `image/vnd.adobe.photoshop` matches `image/*` — the policy must ALSO deny by extension for known-binary image formats? No — keep it simple and honest: `image/*` accepts it (the model may cope; spec's accept list is mime-based). Change the psd test to a mime the browser reports for .psd: often EMPTY → extension fallback rejects (`.psd` not in the extension allowlist). Use `attachmentPolicy('art.psd', '', 10)` → rejected.

ThreadState.test additions: `addAttachments` with a fake `File` (happy-dom `new File(['x'], 'notes.md')`) lands one pendingAttachment with inferred mime and data-URL; a 7th file sets `note` and is skipped; `removeAttachment(0)` empties; `submitDraft` with attachments but empty draft calls `send` (assert via captured turn request through a stub ChatThread layer) with `attachments` present and optimistic user bubble containing an `Image`/`File` part and NO empty Text part; `clear()` empties pendingAttachments.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** attachments.ts:

```ts
/** Pure attachment gate (spec §1): mime/extension allowlist, size cap, mime inference. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;

const EXTENSION_MIMES: Record<string, string> = { md: 'text/markdown', txt: 'text/plain' };

export function attachmentPolicy(
  name: string,
  mime: string,
  size: number,
): { ok: true; mime: string } | { ok: false; note: string } {
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, note: `attachment too large: ${name} (max 8 MB)` };
  const inferred =
    mime.length > 0 ? mime : (EXTENSION_MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? '');
  const accepted =
    inferred.startsWith('image/') || inferred.startsWith('text/') || inferred === 'application/json';
  return accepted ? { ok: true, mime: inferred } : { ok: false, note: `unsupported attachment type: ${name}` };
}
```

ThreadState: `pendingAttachments: ChatAttachmentT[] = []`; `addAttachments` loops files, applies policy + `MAX_ATTACHMENTS` cap (cap violation note: `` `too many attachments (max 6)` ``), FileReader-to-data-URL (`readAsDataURL` wrapped in a Promise), then single reassignment `this.pendingAttachments = [...this.pendingAttachments, ...accepted]` with a `this.get(null)` guard after the await; notes accumulate into ONE `this.note` (join '; '). `removeAttachment(i)` filters by index. `submitDraft`: send when `text.length > 0 || this.pendingAttachments.length > 0`; clears both. `send(text)`: snapshot `attachments = this.pendingAttachments; this.pendingAttachments = []`; guard becomes `(text.trim().length === 0 && attachments.length === 0)`; optimistic bubble parts = images as `{_tag:'Image', url: a.dataUrl}`, non-images as `{_tag:'File', name: a.name, mime: a.mime}`, then Text ONLY if text non-empty; request gains `...(attachments.length > 0 ? { attachments } : {})`. `clear()` adds `this.pendingAttachments = []`.
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(chat): attachment gate + pending attachments in ThreadState`.

---

### Task 3: Bridge — attachments to opencode + history round-trip

**Files:**
- Modify: `src/server/agentBridge.ts` — `AgentClient.prompt` signature (:442-447, :543-556, :650-651), `promptWithHeartbeat` (:787-812), `runChatTurn` (:840-864), `chatPromptText` (:770-778), `mapSessionMessages` user branch (:936-940)
- Modify: `src/contracts/opencode.ts` — SessionMessagePart gains `mime`/`filename`/`url` optionals (file parts)
- Test: `src/server/agentBridge.test.ts`

**Interfaces:**
- Consumes: `ChatAttachmentT` (Task 1).
- Produces: `type PromptFile = { mime: string; url: string; filename?: string }`; `AgentClient.prompt(sessionId, text, files?: readonly PromptFile[])`; wire order = [user attachments (filename'd), art context (unnamed), text last].

- [ ] **Step 1: failing tests.** Stub AgentClient capturing `prompt(sessionId, text, files)`:
  - `runChatTurn` with 2 attachments + currentArtFileName → files = `[{...,filename:'ref.png'},{...,filename:'notes.md'},{mime:'image/png', url:'data:image/png;base64,...'}]` (art last, unnamed), text ends with the user prompt.
  - empty `userPrompt` + 1 attachment → prompt text ends `Author request: (see attached files)`.
  - `mapSessionMessages`: a user message whose parts are `[{type:'file', mime:'image/png', filename:'ref.png', url:'data:image/png;base64,AA=='}, {type:'file', mime:'image/png', url:'data:...'} /* unnamed art */, {type:'text', text:'…Author request: hi'}]` maps to parts `[{_tag:'Image', url:'data:image/png;base64,AA=='}, {_tag:'Text', text:'hi'}]` — named file mapped, unnamed skipped; a named `text/markdown` file maps to `{_tag:'File', name, mime}`.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.**
  - opencode.ts SessionMessagePart: add `mime: Schema.optional(Schema.String)`, `filename: Schema.optional(Schema.String)`, `url: Schema.optional(Schema.String)`.
  - `prompt: (sessionId, text, files) => client.session.prompt({ path, body: { parts: [ ...(files ?? []).map((f) => ({ type: 'file' as const, mime: f.mime, url: f.url, ...(f.filename !== undefined ? { filename: f.filename } : {}) })), { type: 'text', text } ] } })`. Update the Tag interface + live-layer delegation (`prompt(sessionId, text, files)`), `promptWithHeartbeat(agent, bus, sessionId, text, files?)`.
  - `chatPromptText` request line: `` `${USER_REQUEST_MARKER}${req.userPrompt.trim().length > 0 ? req.userPrompt : '(see attached files)'}` ``.
  - `runChatTurn`: build `files: PromptFile[] = [...(req.attachments ?? []).map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.name })), ...(art ? [{ mime: art.mime, url: art.dataUrl }] : [])]`; pass to promptWithHeartbeat (empty list → undefined).
  - `mapSessionMessages` user branch: before the text push, loop parts: `part.type === 'file' && part.filename !== undefined` → `part.mime?.startsWith('image/')` ? `{_tag:'Image', url: part.url ?? ''}` : `{_tag:'File', name: part.filename, mime: part.mime ?? ''}`; push these before the Text part; omit the Text part when the stripped text is empty AND file parts exist? NO — keep Text always for `(see attached files)` fidelity: the stand-in IS the stored request, show it.
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(bridge): user attachments ride opencode file parts (filename = user, unnamed = art context)`.

---

### Task 4: `/api/chat/siblings` (replaces children)

**Files:**
- Modify: `src/server/agentBridge.ts:1408-1423` (route), `src/chat/ChatThread.ts` (`children` → `siblings`), `src/chat/ThreadState.ts:253-262` (loadBranches call), `src/chat/ChatThread.test.ts`
- Test: `src/server/agentBridge.test.ts`

**Interfaces:**
- Produces: GET `/api/chat/siblings?sessionId=…` → `ChatBranchesResponse` (unchanged shape), parent FIRST (its summary has no `parentId`); `ChatThreadShape.siblings(sessionId)`; exported `siblingSet(agent, sessionId): Effect<readonly ThreadSummaryT[]>` for tests.

- [ ] **Step 1: failing tests.** `siblingSet` with stub agent: (a) forked session (info.parentID set) → `[parentSummary, ...childrenOfParent]`; (b) unforked with children → `[selfSummary, ...ownChildren]`; (c) `info` fails → `[]` (orElseSucceed).
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** In agentBridge.ts near sessionSummary:

```ts
/** Parent-first sibling set (spec §2): the root session + all its forks. */
export function siblingSet(
  sessionId: SessionIdT,
): Effect.Effect<readonly ThreadSummaryT[], never, AgentClient> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const info = yield* agent.info(sessionId).pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined) return [];
    const rootId = info.parentID !== undefined ? SessionId.make(info.parentID) : sessionId;
    const root = rootId === sessionId ? info
      : yield* agent.info(rootId).pipe(Effect.orElseSucceed(() => info));
    const children = yield* agent.children(rootId).pipe(Effect.orElseSucceed(() => [] as readonly SessionInfoT[]));
    return [sessionSummary(root), ...children.map(sessionSummary)];
  });
}
```

Route: rename middleware path to `/api/chat/siblings`, body `return { branches: yield* siblingSet(SessionId.make(sessionId)) }` (drop the direct children call). ChatThread: rename `children` → `siblings`, URL `/api/chat/siblings`; update `chatThreadEmpty` and ThreadState.loadBranches (`c.siblings(sid)`).
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(bridge): parent-first /api/chat/siblings replaces /api/chat/children`.

---

### Task 5: divergencePoint + branchPoint state

**Files:**
- Create: `src/chat/divergence.ts`
- Modify: `src/chat/ThreadState.ts` (branchPoint, loadBranches upgrade, orderedSiblings)
- Test: `src/chat/divergence.test.ts`, `src/chat/ThreadState.test.ts`

**Interfaces:**
- Consumes: `siblings` (Task 4).
- Produces: `divergencePoint(current: readonly ThreadMessageT[], siblings: ReadonlyArray<readonly ThreadMessageT[]>): Option.Option<MessageIdT>` — id of the FIRST message in `current` where any sibling differs by (role, joined-Text-text) or ends; `Option.none()` when no sibling diverges (identical histories) or current is empty. ThreadState: `branchPoint?: { messageId: MessageIdT; index: number; count: number }`, `siblingIds: SessionIdT[]` (ordered, parent first), `switchSibling(delta: 1 | -1): Promise<void>`.

- [ ] **Step 1: failing tests** (table-driven): identical histories → none; sibling shorter at k → id of current[k]; text differs at k → id of current[k]; role differs at k → id of current[k]; multiple siblings → earliest k; empty current → none. ThreadState: `loadBranches` with a stub whose `siblings` returns 2 summaries and `history` returns per-session lists → `branchPoint` = divergent message with `index` = 1-based position of `sessionId` in siblingIds, `count` = 2; single-member set → branchPoint undefined.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** divergence.ts:

```ts
import { Option } from 'effect';
import type { MessageIdT } from '@/contracts/ids';
import type { ThreadMessageT } from '@/contracts/thread';

const keyOf = (m: ThreadMessageT): string =>
  `${m.role}:${m.parts.map((p) => (p._tag === 'Text' ? p.text : '')).join('')}`;

/** First message in `current` where some sibling's history diverges (spec §2 step 3). */
export function divergencePoint(
  current: readonly ThreadMessageT[],
  siblings: ReadonlyArray<readonly ThreadMessageT[]>,
): Option.Option<MessageIdT> {
  let earliest = -1;
  for (const sibling of siblings) {
    for (let k = 0; k < current.length; k++) {
      const a = current[k];
      const b = sibling[k];
      if (a === undefined) break;
      if (b === undefined || keyOf(a) !== keyOf(b)) {
        if (earliest < 0 || k < earliest) earliest = k;
        break;
      }
    }
  }
  const hit = earliest >= 0 ? current[earliest] : undefined;
  return hit !== undefined ? Option.some(hit.id) : Option.none();
}
```

ThreadState.loadBranches: fetch `siblings(sid)`; if `<2` → `branchPoint = undefined; siblingIds = [...]; return`. Else fetch each OTHER sibling's history (`Effect.all` with `orElseSucceed(() => [])`, dropped-on-failure per spec), compute `divergencePoint(this.messages, otherHistories)`, fallback to last user message id when `Option.none` but siblings exist; set `branchPoint = { messageId, index: siblingIds.indexOf(sid) + 1, count: siblingIds.length }`. `switchSibling(delta)`: from siblingIds + current index → `switchBranch(target)`. `branches` field stays (compat) but ThreadPanel stops using it in Task 7.
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(chat): divergence-derived branchPoint + ordered sibling navigation`.

---

### Task 6: Deps + Composer/viewport/chrome rebuild

**Files:**
- Modify: `package.json` (bun add lucide-react react-markdown remark-gfm)
- Create: `src/chat/Composer.tsx`
- Modify: `src/chat/ThreadPanel.tsx` (shell: empty state, sticky footer, stick-to-bottom viewport + chevron, note strip, drop overlay)
- Modify: `src/chat/ThreadState.ts` (only if a helper is missing — expected none)
- Test: `src/chat/ThreadPanel.test.tsx`

**Interfaces:**
- Consumes: `pendingAttachments`/`addAttachments`/`removeAttachment` (Task 2).
- Produces: `<Composer />` (reads `BuilderView.get().thread`); ThreadPanel keeps `<ThreadPanel />` export.

- [ ] **Step 1: failing mounted tests:** `+` button (`composer-attach`) exists and its hidden `input[type=file]` has `accept="image/*,text/*,application/json,.md"`; picking files via change event → `composer-attachment` thumbs render; `attachment-remove` removes; Send (`composer-send`) `disabled` when draft empty & no attachments, enabled after typing; running → `composer-cancel` present, `composer-send` absent; paste event with `clipboardData.files` reaches the gate (thumb appears); drop event on the aside → thumb appears; `note-strip` shows when `thread.note` set and its × clears; empty thread → empty-state heading "What should this card become?" and NO sticky footer duplicate; with messages → `scroll-bottom` chevron exists.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** `bun add lucide-react react-markdown remark-gfm`. Composer.tsx (structure from reference chatgpt.tsx L88–190, our tokens):

```tsx
import { Plus, ArrowUp, Square, X, FileText } from 'lucide-react';
import { BuilderView } from '@/builder/BuilderView';

export function Composer() {
  const { thread } = BuilderView.get();
  const { draft, running, pendingAttachments } = thread;
  const canSend = !running && (draft.trim().length > 0 || pendingAttachments.length > 0);
  return (
    <div className="flex w-full flex-col rounded-2xl border-2 border-border bg-background p-2 shadow-shadow">
      {pendingAttachments.length > 0 && (
        <div className="flex flex-row flex-wrap gap-2 px-1 pt-1 pb-2">
          {pendingAttachments.map((a, i) => (
            <div key={`${a.name}-${i}`} data-testid="composer-attachment" className="group/att relative">
              {a.mime.startsWith('image/') ? (
                <img src={a.dataUrl} alt={a.name} className="size-16 rounded-base border border-edge object-cover" />
              ) : (
                <span className="flex h-16 items-center gap-1.5 rounded-base border border-edge bg-secondary-background px-2 text-[11px]">
                  <FileText className="size-4 shrink-0 text-ink-dim" />
                  <span className="max-w-24 truncate">{a.name}</span>
                </span>
              )}
              <button type="button" data-testid="attachment-remove" onClick={() => thread.removeAttachment(i)}
                className="-top-1.5 -right-1.5 absolute flex size-5 items-center justify-center rounded-full border border-edge bg-background text-ink-dim hover:text-ink">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <AttachButton />
        <textarea value={draft} rows={1} placeholder="Message the assistant…" style={{ fieldSizing: 'content' } as never}
          onChange={...draft} onKeyDown={...enter-sends} onPaste={(e) => { if (e.clipboardData.files.length > 0) { e.preventDefault(); void thread.addAttachments(e.clipboardData.files); } }}
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none" />
        {running ? (
          <button type="button" data-testid="composer-cancel" onClick={() => void thread.cancel()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-border bg-background shadow-shadow"><Square className="size-3.5 fill-current" /></button>
        ) : (
          <button type="button" data-testid="composer-send" disabled={!canSend} onClick={() => thread.submitDraft()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-border bg-main text-main-foreground shadow-shadow disabled:opacity-30"><ArrowUp className="size-5" /></button>
        )}
      </div>
    </div>
  );
}
```

`AttachButton`: hidden input via `ref` object prop pattern; `onChange` calls `void thread.addAttachments(e.currentTarget.files ?? [])` then `e.currentTarget.value = ''`. ThreadPanel shell: `dragging` UI state lives on ThreadState (`draggingFiles = false` transient field) or local module state — use a ThreadState field `dropActive` toggled by dragenter/dragleave/drop; aside gets `onDragOver={e => e.preventDefault()}` `onDrop` → `addAttachments(e.dataTransfer.files)`; overlay `data-testid="drop-overlay"` when active. Viewport: `atBottom` tracked on ThreadState (`viewportPinned = true`); onScroll sets it (`scrollHeight - scrollTop - clientHeight < 16`); callback ref autoscrolls only when pinned; chevron `data-testid="scroll-bottom"` when not pinned scrolls to bottom. Empty state per spec; sticky footer wraps NoteStrip? Note strip sits above Composer in both placements. NoteStrip: `note !== undefined` → `data-testid="note-strip"` danger-tinted strip, × sets `thread.note = undefined`.
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(chat): pill composer with +/paste/drop attachments, empty state, stick-to-bottom viewport, note strip`.

---

### Task 7: Messages — markdown, icon action bars, ‹ n/m ›, edit restyle, resizable panel

**Files:**
- Create: `src/chat/MessageView.tsx` (MessageView/PartView/ToolUI/ActionBar/EditBox/BranchArrows move here)
- Modify: `src/chat/ThreadPanel.tsx` (delete top BranchPicker strip, delete moved components, resize handle)
- Modify: `src/chat/ThreadState.ts` (`copiedId?: MessageIdT` + `copyMessage(m)` with 1.5s reset)
- Modify: `src/builder/BuilderView.tsx:352` (`chatWidth = 400` field; pass width; handle)
- Modify: `src/app/theme.css` (chat-md styles)
- Test: `src/chat/ThreadPanel.test.tsx`

**Interfaces:**
- Consumes: `branchPoint`/`switchSibling` (Task 5), `FilePart` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: failing mounted tests:** assistant `**bold**` text renders a `<strong>`; user text does NOT (stays plain in bubble); `action-copy` click → `copiedId` set (check ✓ icon presence via test id state) and clipboard called; `action-regenerate` present ONLY on last assistant message when two exist; `branch-prev`/`branch-next` render on the branchPoint message when `count > 1` with text `1/2`, click calls switchSibling (stub captures); old `branch-picker` testid GONE; `edit-box` restyled still functional (`edit-submit` resends); `chat-resize` handle present; pointer drag sequence updates `BuilderView.chatWidth` clamped to [340, 600]; double-click resets 400.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.** MessageView: user keeps bubble (attachment Image/File parts render ABOVE the bubble as thumbs/chips, then Text bubble); assistant Text renders `<ReactMarkdown remarkPlugins={[remarkGfm]}>` inside `<div className="chat-md max-w-full text-sm">` (error case keeps danger classes, plain); running indicator unchanged. ActionBar → icon buttons (lucide `Copy`/`Check`/`Pencil`/`RefreshCw`, `size-3.5`, native `title`); `isLastAssistant` computed by caller. copyMessage on ThreadState:

```ts
copiedId?: MessageIdT = undefined;
copyMessage(message: ThreadMessageT): void {
  const text = message.parts.map((p) => (p._tag === 'Text' ? p.text : '')).join('');
  void navigator.clipboard?.writeText(text);
  this.copiedId = message.id;
  setTimeout(() => { if (!this.get(null) && this.copiedId === message.id) this.copiedId = undefined; }, 1500);
}
```

BranchArrows (on the message whose id === branchPoint.messageId): `‹ index/count ›` with `branch-prev`/`branch-next` buttons → `void thread.switchSibling(-1|1)`. theme.css `chat-md` block: margins for `p, ul, ol, pre, h1-h4`, `code` mono + bg-secondary-background, `pre` overflow-x-auto rounded, `table` borders — on existing tokens. BuilderView: `chatWidth = 400`; render `<ThreadPanel />` with the aside width from `BuilderView.get()` (read INSIDE ThreadPanel via `const { thread, chatWidth } = BuilderView.get()` — tracked); resize handle inside ThreadPanel's left edge: pointerdown captures, pointermove `view.chatWidth = clamp(600, 340, startWidth + (startX - e.clientX))`, dblclick 400.
- [ ] **Step 4: verify green.**
- [ ] **Step 5: Commit** `feat(chat): markdown messages, icon action bars, per-message branch arrows, resizable panel`.

---

### Task 8: Sweep + docs + live e2e

**Files:**
- Modify: `README.md` (chat section: attachments, markdown, resize)
- Verify: full suite, build, live run

- [ ] **Step 1:** grep sweep — no `branch-picker` remnants, no leftover `children(` on ChatThread, no unused imports; `bun run build` passes (chunk limit may need +100k for react-markdown — raise `chunkSizeWarningLimit` in vite.config.ts only if the build warns).
- [ ] **Step 2:** README: update the chat-panel paragraph (attachments, markdown, ‹ n/m ›, resize).
- [ ] **Step 3:** `bun run verify` + live e2e: `bun run dev`, attach a real image + a .md file, confirm thumbs, send, model references the image, save card, restart dev server, reopen → attachment thumb survives rehydration; drag panel edge; branch arrows after an edit.
- [ ] **Step 4: Commit** `docs: chat panel maturity — README + sweep`, then merge ff to main, push, delete branch, update memory file.

## Self-review notes

- Spec coverage: attachments (T1-T3), siblings/‹n/m› (T4-T5), composer/chrome/note strip (T6), markdown/actions/resize (T7), e2e+docs (T8). Vision-only: satisfied by T3 sending attachments as file parts with NO artAction change. Edit/regenerate dropping attachments: already true (both replay text only) — T3 test asserts regenerate path unchanged? Covered implicitly; no code change needed.
- Type consistency: `PromptFile` defined T3 and used only there; `ChatAttachmentT` from T1 used T2/T3; `branchPoint` shape identical T5/T7; `siblings` rename T4 consumed T5.
- Known judgment calls for the executor: exact tailwind classes may be tuned at implementation; test ids and behaviors are the contract.
