/**
 * ThreadState — the reactive chat store, adopted by BuilderView. It folds the
 * SSE event stream into a message list, runs turns through the Effect
 * boundary, and persists nothing itself (pi's session tree under
 * cartis-data/chats owns the transcript; BuilderView persists only the
 * sessionId pointer).
 *
 * Pi tool transport (migration spec §3.2): turn responses are STRUCTURED
 * ({ reply, toolCalls, entry ids }); the client applies intents through the
 * injected ChatContext and RE-KEYS its optimistic bubbles to the returned pi
 * entry ids — so edits and anchors always target real tree entries.
 *
 * Boundary discipline: reads are snapshotted into locals before building
 * effects; results are Exit-matched at the boundary; the stream-consumer fiber
 * is interrupted on destroy; `this.get(null)` guards every post-await write.
 */

import State from '@expressive/react';
import { Effect, Exit, Fiber, Match, Option, Stream } from 'effect';
import { forkApp, runAppExit } from '@/app/runtime';
import type {
  ArtActionT,
  CardDataT,
  ChatAttachmentT,
  ChatTurnRequestT,
  ChatTurnResponseT,
  DocContextT,
  ToolCallIntentT,
} from '@/contracts/api';
import { noteFromCause } from '@/contracts/errors';
import type { FieldSummaryT } from '@/contracts/fields';
import {
  DataUrl,
  FileName,
  MessageId,
  type MessageIdT,
  MimeType,
  type SessionIdT,
} from '@/contracts/ids';
import {
  CARD_EXPORT_TOOL,
  CARD_GENERATE_ART_TOOL,
  CARD_PATCH_TOOL,
  CARD_SAVE_COPY_TOOL,
  CARD_SAVE_TOOL,
  CARD_SET_ASPECT_TOOL,
  CARD_SET_HOLO_TOOL,
  CARD_SET_LAYOUT_TOOL,
  CARD_SET_THEME_TOOL,
  partsFromTurn,
} from '@/contracts/materialize';
import type { ThemeContextT } from '@/contracts/theme';
import type { MessageStatusT, ThreadEventT, ThreadMessageT, ThreadPartT } from '@/contracts/thread';
import { attachmentPolicy, fileToDataUrl, MAX_ATTACHMENTS } from './attachments';
import { ChatEvents } from './ChatEvents';
import { ChatThread } from './ChatThread';
import { foldThreadEvent } from './fold';

/** The card context + appliers BuilderView injects so a turn can edit the card. */
export interface ChatContext {
  readonly themeContext: ThemeContextT;
  readonly fields: readonly FieldSummaryT[];
  readonly currentData: CardDataT;
  readonly currentArtFileName?: string;
  /** Current + available document knobs — the tool schemas derive from these. */
  readonly docContext?: DocContextT;
  /** Apply the agent's field patch to the open document. */
  applyPatch(patch: CardDataT): void;
  /**
   * Delegate an art action to the builder's art run (phases arrive as Art
   * events). Returns the run's promise so doc actions can sequence after it.
   * `sourceDataUrl` = the turn's attached photo, riding into generation as the
   * img2img source (vision alone loses the subject's identity — live-caught).
   */
  runArt(action: ArtActionT, sourceDataUrl?: string): void | Promise<void>;
  /** Mark the document dirty (e.g. switching to a branch is a saved-state change). */
  markDirty(): void;
  /** Persist the document (card_save tool) — false on failure. */
  save(): Promise<boolean>;
  /** Persist as a fresh copy (card_save_copy tool) — false on failure. */
  saveAsCopy(): Promise<boolean>;
  /** Render + download + archive an export of the current preview. */
  exportRender(target: 'png' | 'print' | 'sheet'): Promise<boolean>;
  /** Settings knobs — validated against the registry; false on unknown ids. */
  setLayout(layoutId: string): boolean;
  setTheme(themeId: string): boolean;
  setHolo(value: boolean): boolean;
  setArtAspect(value: string): boolean;
  /** Downscaled snapshot of the rendered preview (agent vision); undefined on failure. */
  snapshotPreview(): Promise<{ mime: string; dataUrl: string } | undefined>;
}

/** One ‹ n/m › anchor from the session tree (server-computed, spec §4.2). */
export interface BranchAnchor {
  readonly messageId: MessageIdT;
  readonly index: number;
  readonly count: number;
  readonly siblingLeafIds: readonly string[];
}

/** The synchronous settings knobs, applied BEFORE art (spec ordering rule). */
const SETTINGS_TOOLS: ReadonlySet<string> = new Set([
  CARD_SET_LAYOUT_TOOL,
  CARD_SET_THEME_TOOL,
  CARD_SET_HOLO_TOOL,
  CARD_SET_ASPECT_TOOL,
]);

/** The event's session, if the variant carries one — pure Option helper. */
const eventSessionId = (event: ThreadEventT): Option.Option<SessionIdT> =>
  Match.value(event).pipe(
    Match.tag('TurnStarted', 'PartDelta', 'TurnCompleted', (e) => Option.some(e.sessionId)),
    Match.tag('Art', 'SessionError', () => Option.none<SessionIdT>()),
    Match.exhaustive,
  );

export class ThreadState extends State {
  messages: ThreadMessageT[] = [];
  running = false;
  sessionId?: SessionIdT = undefined;
  note?: string = undefined;
  /** The composer draft (UI state; cleared on submit). */
  draft = '';
  /** Gated attachments awaiting the next send (thumbnails read dataUrl). */
  pendingAttachments: ChatAttachmentT[] = [];
  /** ‹ n/m › anchors from the session tree (one per fork on the active branch). */
  anchors: BranchAnchor[] = [];
  /** Viewport is at (or near) the bottom — autoscroll follows new content. */
  viewportPinned = true;
  /** A drag-with-files is hovering the panel (drop overlay visible). */
  dropActive = false;
  /** True between cancel() and the turn settling — makes the turn finalize incomplete. */
  canceling = false;
  /** The user message currently being inline-edited, and its working text. */
  editingId?: MessageIdT = undefined;
  editDraft = '';
  /** Message whose Copy button shows the ✓ state (cleared after 1.5s). */
  copiedId?: MessageIdT = undefined;

  /** Injected by BuilderView: the current card's chat context + appliers. */
  context?: () => ChatContext | undefined = undefined;

  protected new() {
    // Consume the shared SSE stream on the app runtime; event-handler-style
    // writes to `this` are the sanctioned exception to the snapshot rule.
    const fiber = forkApp(
      Effect.flatMap(ChatEvents, (client) =>
        Stream.runForEach(client.events, (event) =>
          Effect.sync(() => {
            this.applyEvent(event);
          }),
        ),
      ),
    );
    return () => void forkApp(Fiber.interrupt(fiber));
  }

  /** Fold one streamed event into the message list (session-filtered). */
  applyEvent(event: ThreadEventT): void {
    if (this.get(null)) return; // destroyed
    const sid = Option.getOrUndefined(eventSessionId(event));
    if (sid !== undefined && this.sessionId !== undefined && sid !== this.sessionId) return;
    // Unbound thread: accept unknown-session events ONLY while a turn is in
    // flight (the first turn streams before the response captures its session
    // id). An IDLE unbound thread must drop them — the SSE PubSub replays the
    // last ~50 events to every new subscriber, and a fresh card would build
    // ghost messages from an old session's replay (live-caught after reload).
    if (sid !== undefined && this.sessionId === undefined && !this.running) return;
    // Session-LESS events (Art/SessionError) replayed onto an idle EMPTY
    // thread are ghosts too (live-caught: "art generated" strip on a fresh
    // card). During a turn or an existing conversation they flow as usual.
    if (sid === undefined && !this.running && this.messages.length === 0) return;
    this.messages = foldThreadEvent(this.messages, event);
  }

  /** Bind a saved card's session and rehydrate its conversation + anchors. */
  bind(sessionId: SessionIdT): void {
    this.sessionId = sessionId;
    void this.rehydrate();
    void this.loadTree();
  }

  /** Reset for a new/unbound card, aborting any in-flight turn first. */
  clear(): void {
    const sid = this.sessionId;
    if (this.running && sid !== undefined) {
      void runAppExit(Effect.flatMap(ChatThread, (c) => c.cancel(sid)));
    }
    this.messages = [];
    this.sessionId = undefined;
    this.running = false;
    this.note = undefined;
    this.draft = '';
    this.pendingAttachments = [];
    this.anchors = [];
    this.canceling = false;
  }

  /**
   * Gate + ingest picked/pasted/dropped files (spec §1: one gate, three entry
   * points). Rejections never leave the client: each sets a naming note.
   */
  async addAttachments(files: Iterable<File>): Promise<void> {
    const notes: string[] = [];
    const accepted: ChatAttachmentT[] = [];
    let count = this.pendingAttachments.length;
    for (const file of files) {
      if (count >= MAX_ATTACHMENTS) {
        notes.push(`too many attachments (max ${String(MAX_ATTACHMENTS)})`);
        break;
      }
      const verdict = attachmentPolicy(file.name, file.type, file.size);
      if (!verdict.ok) {
        notes.push(verdict.note);
        continue;
      }
      const dataUrl = await fileToDataUrl(file);
      accepted.push({
        name: FileName.make(file.name),
        mime: MimeType.make(verdict.mime),
        dataUrl: DataUrl.make(dataUrl),
      });
      count += 1;
    }
    if (this.get(null)) return; // destroyed mid-read
    if (accepted.length > 0) {
      this.pendingAttachments = [...this.pendingAttachments, ...accepted];
    }
    if (notes.length > 0) this.note = notes.join('; ');
  }

  removeAttachment(index: number): void {
    this.pendingAttachments = this.pendingAttachments.filter((_, i) => i !== index);
  }

  /** Submit the composer draft as a turn (Enter / Send button). */
  submitDraft(): void {
    const text = this.draft.trim();
    if ((text.length === 0 && this.pendingAttachments.length === 0) || this.running) return;
    this.draft = '';
    void this.send(text);
  }

  /** Begin inline-editing a user message (its text seeds the edit draft). */
  beginEdit(message: ThreadMessageT): void {
    this.editingId = message.id;
    this.editDraft = message.parts
      .map((p) => (p._tag === 'Text' ? p.text : ''))
      .join('')
      .trim();
  }

  cancelEdit(): void {
    this.editingId = undefined;
    this.editDraft = '';
  }

  /** Copy a message's text; the ✓ feedback state clears itself after 1.5s. */
  copyMessage(message: ThreadMessageT): void {
    const text = message.parts.map((p) => (p._tag === 'Text' ? p.text : '')).join('');
    void navigator.clipboard?.writeText(text);
    this.copiedId = message.id;
    setTimeout(() => {
      if (!this.get(null) && this.copiedId === message.id) this.copiedId = undefined;
    }, 1500);
  }

  /** Commit the inline edit → sibling branch in the session tree. */
  async submitEdit(): Promise<void> {
    const id = this.editingId;
    const text = this.editDraft.trim();
    this.editingId = undefined;
    this.editDraft = '';
    if (id !== undefined && text.length > 0) await this.edit(id, text);
  }

  /** Interrupt the running turn: abort the session and finalize it incomplete. */
  async cancel(): Promise<void> {
    const sid = this.sessionId;
    if (!this.running || sid === undefined) return;
    this.canceling = true; // the turn's finalize sees this and marks it incomplete
    await runAppExit(Effect.flatMap(ChatThread, (c) => c.cancel(sid)));
  }

  /** Build this turn's request from the injected context (post-await safe). */
  private async buildRequest(
    text: string,
    attachments: ChatAttachmentT[],
  ): Promise<ChatTurnRequestT | undefined> {
    const ctx = this.context?.();
    if (ctx === undefined) return undefined;
    // The preview snapshot renders AFTER the optimistic bubble (spec: the
    // ~100-300ms rasterize must never delay perceived send); failure → none.
    const snapshot = await ctx.snapshotPreview().catch(() => undefined);
    if (this.get(null)) return undefined;
    return {
      sessionId: this.sessionId,
      themeContext: ctx.themeContext,
      fields: ctx.fields,
      currentData: ctx.currentData,
      currentArtFileName: ctx.currentArtFileName,
      userPrompt: text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(ctx.docContext !== undefined ? { docContext: ctx.docContext } : {}),
      ...(snapshot !== undefined ? { previewDataUrl: DataUrl.make(snapshot.dataUrl) } : {}),
    };
  }

  /** Send one turn: optimistic user bubble → turn → structured apply. */
  async send(text: string): Promise<void> {
    if (this.running) return; // one turn at a time (composer locks)
    const ctx = this.context?.();
    const attachments = this.pendingAttachments;
    if (ctx === undefined || (text.trim().length === 0 && attachments.length === 0)) return;
    this.pendingAttachments = [];

    // Optimistic bubble: image thumbs / file chips above, then the text (only
    // when typed — an attachment-only send shows no empty Text part).
    const bubbleParts: ThreadPartT[] = [
      ...attachments.map(
        (a): ThreadPartT =>
          a.mime.startsWith('image/')
            ? { _tag: 'Image', url: a.dataUrl }
            : { _tag: 'File', name: a.name, mime: a.mime },
      ),
      ...(text.length > 0 ? [{ _tag: 'Text', text } satisfies ThreadPartT] : []),
    ];
    const optimisticId = MessageId.make(crypto.randomUUID());
    this.messages = [
      ...this.messages,
      { id: optimisticId, role: 'user', status: 'complete', parts: bubbleParts },
    ];
    this.running = true;
    this.note = undefined;

    const req = await this.buildRequest(text, attachments);
    if (req === undefined) return;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.turn(req)));
    if (this.get(null)) return; // destroyed mid-turn
    this.applyTurnExit(optimisticId, exit, ctx, attachments);
  }

  /**
   * Edit an earlier user message: ONE route call — the bridge navigates the
   * tree to the target's parent and re-prompts, creating a sibling branch.
   */
  async edit(messageId: MessageIdT, text: string): Promise<void> {
    if (this.running) return;
    const ctx = this.context?.();
    const sid = this.sessionId;
    if (ctx === undefined || sid === undefined) return;
    // Trim local history back to before the edited message, optimistic bubble.
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) this.messages = this.messages.slice(0, idx);
    const optimisticId = MessageId.make(crypto.randomUUID());
    this.messages = [
      ...this.messages,
      { id: optimisticId, role: 'user', status: 'complete', parts: [{ _tag: 'Text', text }] },
    ];
    this.running = true;
    this.note = undefined;
    const req = await this.buildRequest(text, []);
    if (req === undefined) return;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.edit(req, messageId)));
    if (this.get(null)) return;
    this.applyTurnExit(optimisticId, exit, ctx);
    this.context?.()?.markDirty(); // a branch is saved state
    void this.loadTree();
  }

  /**
   * Regenerate the last assistant turn: the bridge replays the stored user
   * text on a new branch; the result lands on a running placeholder.
   */
  async regenerate(): Promise<void> {
    if (this.running) return;
    const ctx = this.context?.();
    const sid = this.sessionId;
    if (ctx === undefined || sid === undefined) return;
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    if (lastAssistant === undefined || lastUser === undefined) return;
    this.messages = this.messages.map((m) =>
      m.id === lastAssistant.id ? { ...m, status: 'running', parts: [] } : m,
    );
    this.running = true;
    this.note = undefined;
    const req = await this.buildRequest('', []);
    if (req === undefined) return;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.regenerate(req)));
    if (this.get(null)) return;
    this.applyTurnExit(lastUser.id, exit, ctx);
    void this.loadTree();
  }

  /** Load the ‹ n/m › anchors from the session tree. */
  async loadTree(): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) {
      this.anchors = [];
      return;
    }
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.tree(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(exit)) {
      this.anchors = exit.value.map((a) => ({
        messageId: a.messageId,
        index: a.index,
        count: a.count,
        siblingLeafIds: a.siblingLeafIds,
      }));
    }
  }

  /** Switch to a sibling branch (durable server-side), then rehydrate. */
  async switchTo(leafId: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined || this.running) return;
    await runAppExit(Effect.flatMap(ChatThread, (c) => c.switch(sid, leafId)));
    if (this.get(null)) return;
    this.context?.()?.markDirty();
    await this.rehydrate();
    void this.loadTree();
  }

  /** Step to the previous/next sibling branch (the ‹ › arrows). */
  async switchSibling(anchor: BranchAnchor, delta: 1 | -1): Promise<void> {
    const target = anchor.siblingLeafIds[anchor.index - 1 + delta];
    if (target !== undefined) await this.switchTo(target);
  }

  /** Reload the ACTIVE branch from the bridge (stale session → fresh/empty). */
  async rehydrate(): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) return;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.history(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(exit)) this.messages = [...exit.value];
    // failure (stale/missing session) → keep whatever we have; no UI note
  }

  /** Apply a settled turn: re-key bubbles to pi entry ids + run the intents. */
  private applyTurnExit(
    optimisticUserId: MessageIdT,
    exit: Exit.Exit<ChatTurnResponseT, unknown>,
    ctx: ChatContext,
    attachments: readonly ChatAttachmentT[] = [],
  ): void {
    if (Exit.isSuccess(exit) && !this.canceling) {
      const res = exit.value;
      this.sessionId = res.sessionId; // lazy-created session captured
      // RE-KEY (spec §3.2): the optimistic user bubble takes the pi entry id;
      // this turn's assistant message (streamed or appended) takes its own.
      this.messages = this.messages.map((m) =>
        m.id === optimisticUserId ? { ...m, id: res.userEntryId } : m,
      );
      this.finalizeAssistant(
        res.userEntryId,
        res.assistantEntryId,
        partsFromTurn(res.reply, res.toolCalls),
        'complete',
      );
      if (res.toolErrors !== undefined && res.toolErrors.length > 0) {
        this.note = `some tool calls failed validation: ${res.toolErrors
          .map((e) => e.name)
          .join(', ')}`;
      }
      this.applyIntents(ctx, res.toolCalls, attachments);
    } else if (this.canceling) {
      this.finalizeAssistant(
        optimisticUserId,
        MessageId.make(crypto.randomUUID()),
        [{ _tag: 'Text', text: 'Canceled.' }],
        'incomplete',
      );
    } else {
      const message = noteFromCause((exit as Exit.Failure<unknown, unknown>).cause);
      this.note = message;
      this.finalizeAssistant(
        optimisticUserId,
        MessageId.make(crypto.randomUUID()),
        [{ _tag: 'Text', text: message }],
        'incomplete',
      );
    }
    this.canceling = false;
    this.running = false;
  }

  /**
   * Apply the turn's validated tool intents. Settings knobs apply
   * SYNCHRONOUSLY, before art starts (spec ordering: "switch to fullart and
   * generate art" must render at the new aspect); card_patch merges into one
   * document patch; art then save/copy/export sequence detached behind the
   * already-rendered reply.
   */
  private applyIntents(
    ctx: ChatContext,
    toolCalls: readonly ToolCallIntentT[],
    attachments: readonly ChatAttachmentT[] = [],
  ): void {
    for (const call of toolCalls) {
      if (!SETTINGS_TOOLS.has(call.name)) continue;
      const ok =
        call.name === CARD_SET_LAYOUT_TOOL
          ? ctx.setLayout(String(call.args.layoutId ?? ''))
          : call.name === CARD_SET_THEME_TOOL
            ? ctx.setTheme(String(call.args.themeId ?? ''))
            : call.name === CARD_SET_ASPECT_TOOL
              ? ctx.setArtAspect(String(call.args.aspectRatio ?? ''))
              : ctx.setHolo(call.args.value === true);
      if (!ok) this.note = `action failed: ${call.name}`;
    }
    const patch: CardDataT = {};
    for (const call of toolCalls) {
      if (call.name === CARD_PATCH_TOOL) Object.assign(patch, call.args);
    }
    if (Object.keys(patch).length > 0) ctx.applyPatch(patch as CardDataT);
    void this.runPostTurn(ctx, toolCalls, attachments);
  }

  /**
   * Post-turn side effects, sequenced: the art run first (so a same-turn save
   * or export captures the NEW art), then each document action in order. A
   * failed action surfaces in the note strip; the reply is already rendered.
   */
  private async runPostTurn(
    ctx: ChatContext,
    toolCalls: readonly ToolCallIntentT[],
    attachments: readonly ChatAttachmentT[] = [],
  ): Promise<void> {
    const art = toolCalls.find((c) => c.name === CARD_GENERATE_ART_TOOL);
    if (art !== undefined) {
      // The turn's attached photo steers generation (img2img identity source).
      const photo = attachments.find((a) => a.mime.startsWith('image/'));
      await ctx.runArt(
        {
          brief: String(art.args.brief ?? ''),
          editCurrentArt: art.args.editCurrentArt === true,
        },
        photo?.dataUrl,
      );
    }
    for (const call of toolCalls) {
      if (this.get(null)) return;
      let ok: boolean;
      if (call.name === CARD_SAVE_TOOL) ok = await ctx.save();
      else if (call.name === CARD_SAVE_COPY_TOOL) ok = await ctx.saveAsCopy();
      else if (call.name === CARD_EXPORT_TOOL) {
        const target = String(call.args.target ?? 'png');
        ok = await ctx.exportRender(target === 'print' || target === 'sheet' ? target : 'png');
      } else continue;
      if (!ok && !this.get(null)) {
        this.note = call.name === CARD_EXPORT_TOOL ? 'export failed' : 'save failed';
      }
    }
  }

  /**
   * Finalize this turn's assistant message: the one streamed in after the
   * user bubble (SSE) gets its parts replaced AND its id re-keyed to the pi
   * entry id; otherwise append fresh.
   */
  private finalizeAssistant(
    afterUserId: MessageIdT,
    assistantId: MessageIdT,
    parts: ThreadPartT[],
    status: MessageStatusT,
  ): void {
    const userIdx = this.messages.findIndex((m) => m.id === afterUserId);
    let target = -1;
    for (let i = this.messages.length - 1; i > userIdx; i--) {
      if (this.messages[i]?.role === 'assistant') {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      const message = this.messages[target];
      if (message === undefined) return;
      const next = [...this.messages];
      next[target] = { ...message, id: assistantId, parts, status };
      this.messages = next;
    } else {
      this.messages = [...this.messages, { id: assistantId, role: 'assistant', status, parts }];
    }
  }
}
