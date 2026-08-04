/**
 * ThreadState — the reactive chat store (spec §Decision 3), adopted by
 * BuilderView. It folds the SSE event stream into a message list, runs turns
 * through the Effect boundary, and persists nothing itself (opencode owns the
 * transcript; BuilderView persists only the sessionId pointer).
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
  DocActionT,
  DocContextT,
} from '@/contracts/api';
import { noteFromCause } from '@/contracts/errors';
import type { FieldSummaryT } from '@/contracts/fields';
import {
  DataUrl,
  FileName,
  MessageId,
  type MessageIdT,
  MimeType,
  type PermissionIdT,
  type SessionIdT,
} from '@/contracts/ids';
import { materializeAssistantParts } from '@/contracts/materialize';
import type { ThemeContextT } from '@/contracts/theme';
import type {
  MessageStatusT,
  ThreadEventT,
  ThreadMessageT,
  ThreadPartT,
  ThreadSummaryT,
} from '@/contracts/thread';
import { attachmentPolicy, fileToDataUrl, MAX_ATTACHMENTS } from './attachments';
import { ChatEvents } from './ChatEvents';
import { ChatThread } from './ChatThread';
import { divergencePoint } from './divergence';
import { foldThreadEvent } from './fold';

/** The card context + appliers BuilderView injects so a turn can edit the card. */
export interface ChatContext {
  readonly themeContext: ThemeContextT;
  readonly fields: readonly FieldSummaryT[];
  readonly currentData: CardDataT;
  readonly currentArtFileName?: string;
  /** Current + available document knobs — rendered into the turn prompt. */
  readonly docContext?: DocContextT;
  /** Apply the agent's field patch to the open document. */
  applyPatch(patch: CardDataT): void;
  /**
   * Delegate an art action to the builder's art run (phases arrive as Art
   * events). Returns the run's promise so doc actions can sequence after it.
   */
  runArt(action: ArtActionT): void | Promise<void>;
  /** Mark the document dirty (e.g. switching to a branch is a saved-state change). */
  markDirty(): void;
  /** Persist the document (agent 'save' action) — false on failure. */
  save(): Promise<boolean>;
  /** Persist as a fresh copy (agent 'saveAsCopy' action) — false on failure. */
  saveAsCopy(): Promise<boolean>;
  /** Render + download + archive an export of the current preview. */
  exportRender(target: 'png' | 'print' | 'sheet'): Promise<boolean>;
  /** Settings knobs — validated against the registry; false on unknown ids. */
  setLayout(layoutId: string): boolean;
  setTheme(themeId: string): boolean;
  setHolo(value: boolean): boolean;
}

/** The synchronous settings knobs, applied BEFORE art (spec ordering rule). */
const isSettingsAction = (
  action: DocActionT,
): action is Extract<DocActionT, { kind: 'setLayout' | 'setTheme' | 'setHolo' }> =>
  action.kind === 'setLayout' || action.kind === 'setTheme' || action.kind === 'setHolo';

export interface PendingPermission {
  readonly sessionId: SessionIdT;
  readonly permissionId: PermissionIdT;
  readonly title: string;
}

/** The event's session, if the variant carries one — pure Option helper (spec §3, §Match). */
const eventSessionId = (event: ThreadEventT): Option.Option<SessionIdT> =>
  Match.value(event).pipe(
    Match.tag('TurnStarted', 'PartDelta', 'TurnCompleted', 'PermissionRequested', (e) =>
      Option.some(e.sessionId),
    ),
    Match.tag('Art', 'SessionError', () => Option.none<SessionIdT>()),
    Match.exhaustive,
  );

export class ThreadState extends State {
  messages: ThreadMessageT[] = [];
  running = false;
  sessionId?: SessionIdT = undefined;
  pendingPermission?: PendingPermission = undefined;
  note?: string = undefined;
  /** The composer draft (UI state; cleared on submit). */
  draft = '';
  /** Gated attachments awaiting the next send (thumbnails read dataUrl). */
  pendingAttachments: ChatAttachmentT[] = [];
  /** Branch (fork) siblings of the current session (branch picker). */
  branches: ThreadSummaryT[] = [];
  /** Ordered sibling session ids (parent first) for ‹ n/m › navigation. */
  siblingIds: SessionIdT[] = [];
  /** Where the ‹ n/m › arrows anchor: the divergence message + our position. */
  branchPoint?: { messageId: MessageIdT; index: number; count: number } = undefined;
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
    if (event._tag === 'PermissionRequested') {
      this.pendingPermission = {
        sessionId: event.sessionId,
        permissionId: event.permissionId,
        title: event.title,
      };
      return;
    }
    this.messages = foldThreadEvent(this.messages, event);
  }

  /** Bind a saved card's session and rehydrate its conversation + branches. */
  bind(sessionId: SessionIdT): void {
    this.sessionId = sessionId;
    void this.rehydrate();
    void this.loadBranches();
  }

  /** Reset for a new/unbound card, aborting any in-flight turn first. */
  clear(): void {
    const sid = this.sessionId;
    if (this.running && sid !== undefined) {
      void runAppExit(Effect.flatMap(ChatThread, (c) => c.cancel(sid)));
    }
    this.messages = [];
    this.sessionId = undefined;
    this.pendingPermission = undefined;
    this.running = false;
    this.note = undefined;
    this.draft = '';
    this.pendingAttachments = [];
    this.branches = [];
    this.siblingIds = [];
    this.branchPoint = undefined;
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

  /** Commit the inline edit → fork-on-edit + resend. */
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
    this.canceling = true; // send()'s finalize sees this and marks the turn incomplete
    await runAppExit(Effect.flatMap(ChatThread, (c) => c.cancel(sid)));
  }

  /**
   * Regenerate the last assistant turn (revert + replay). The bridge derives the
   * stored user text; the result re-materializes onto a running placeholder that
   * replaces the previous reply in place.
   */
  async regenerate(): Promise<void> {
    const sid = this.sessionId;
    const ctx = this.context?.();
    if (sid === undefined || ctx === undefined || this.running) return;
    // Replace the last assistant message with a running placeholder.
    const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
    const placeholderId = lastAssistant?.id ?? MessageId.make(crypto.randomUUID());
    this.messages =
      lastAssistant !== undefined
        ? this.messages.map((m) =>
            m.id === placeholderId ? { ...m, status: 'running', parts: [] } : m,
          )
        : [
            ...this.messages,
            { id: placeholderId, role: 'assistant', status: 'running', parts: [] },
          ];
    this.running = true;
    this.note = undefined;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.regenerate(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(exit) && !this.canceling) {
      const res = exit.value;
      this.sessionId = res.sessionId;
      this.replaceMessage(placeholderId, materializeAssistantParts(res.assistantText), 'complete');
      if (Object.keys(res.patch).length > 0) ctx.applyPatch(res.patch);
      this.applySettings(ctx, res.actions ?? []);
      void this.runPostTurn(
        ctx,
        res.artAction,
        (res.actions ?? []).filter((a) => !isSettingsAction(a)),
      );
    } else {
      const message = this.canceling
        ? 'Canceled.'
        : noteFromCause((exit as Exit.Failure<unknown, unknown>).cause);
      if (!this.canceling) this.note = message;
      this.replaceMessage(placeholderId, [{ _tag: 'Text', text: message }], 'incomplete');
    }
    this.canceling = false;
    this.running = false;
  }

  /** Replace one message's parts + status by id (immutably). */
  private replaceMessage(id: string, parts: ThreadPartT[], status: MessageStatusT): void {
    this.messages = this.messages.map((m) => (m.id === id ? { ...m, parts, status } : m));
  }

  /**
   * Edit an earlier user message: fork the session first (native branching, so
   * the original survives), revert to the message, then resend the new text.
   */
  async edit(messageId: MessageIdT, text: string): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined || this.running) return;
    const forkExit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.fork(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(forkExit)) {
      this.sessionId = forkExit.value;
      this.context?.()?.markDirty(); // a branch is saved state
      await runAppExit(Effect.flatMap(ChatThread, (c) => c.revert(forkExit.value, messageId)));
      if (this.get(null)) return;
    }
    // Trim local history back to before the edited message, then resend.
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) this.messages = this.messages.slice(0, idx);
    await this.send(text);
    // AFTER the resend: the branchPoint anchors on the post-edit history.
    if (this.get(null)) return;
    void this.loadBranches();
  }

  /** Switch to a branch (fork) session: rebind, rehydrate, mark the doc dirty. */
  async switchBranch(sessionId: SessionIdT): Promise<void> {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.context?.()?.markDirty();
    await this.rehydrate();
    void this.loadBranches();
  }

  /**
   * Load the parent-first sibling set and compute the ‹ n/m › branch point:
   * fetch the OTHER siblings' histories (failures drop that sibling), find
   * where the current history diverges, fall back to the last user message.
   */
  async loadBranches(): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) {
      this.branches = [];
      this.siblingIds = [];
      this.branchPoint = undefined;
      return;
    }
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.siblings(sid)));
    if (this.get(null)) return;
    if (!Exit.isSuccess(exit)) return;
    const siblings = [...exit.value];
    this.branches = siblings;
    this.siblingIds = siblings.map((s) => s.sessionId);
    if (siblings.length < 2) {
      this.branchPoint = undefined;
      return;
    }
    const others = siblings.filter((s) => s.sessionId !== sid);
    const historiesExit = await runAppExit(
      Effect.flatMap(ChatThread, (c) =>
        Effect.all(
          others.map((s) =>
            c
              .history(s.sessionId)
              .pipe(Effect.orElseSucceed(() => [] as readonly ThreadMessageT[])),
          ),
        ),
      ),
    );
    if (this.get(null)) return;
    const histories = Exit.isSuccess(historiesExit)
      ? historiesExit.value.filter((h) => h.length > 0)
      : [];
    const messages = this.messages;
    const anchor = divergencePoint(messages, histories).pipe(
      Option.orElse(() =>
        // Inconclusive (e.g. identical prefixes) → the last user message.
        Option.fromNullable([...messages].reverse().find((m) => m.role === 'user')?.id),
      ),
      Option.getOrUndefined,
    );
    const index = this.siblingIds.indexOf(sid);
    this.branchPoint =
      anchor !== undefined && index >= 0
        ? { messageId: anchor, index: index + 1, count: this.siblingIds.length }
        : undefined;
  }

  /** Step to the previous/next sibling branch (the ‹ › arrows). */
  async switchSibling(delta: 1 | -1): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) return;
    const at = this.siblingIds.indexOf(sid);
    const target = at >= 0 ? this.siblingIds[at + delta] : undefined;
    if (target === undefined) return;
    await this.switchBranch(target);
  }

  /** Reply to the pending permission request (allow/deny), then clear it. */
  async replyPermission(granted: boolean): Promise<void> {
    const pending = this.pendingPermission;
    if (pending === undefined) return;
    this.pendingPermission = undefined;
    await runAppExit(
      Effect.flatMap(ChatThread, (c) =>
        c.replyPermission(pending.sessionId, pending.permissionId, granted),
      ),
    );
  }

  /** Reload the conversation from opencode (stale session → fresh/empty). */
  async rehydrate(): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) return;
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.history(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(exit)) this.messages = [...exit.value];
    // failure (stale/missing session) → keep whatever we have; no UI note
  }

  /** Send one turn: optimistic user bubble → turn → materialize + apply. */
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
    const userId = MessageId.make(crypto.randomUUID());
    this.messages = [
      ...this.messages,
      { id: userId, role: 'user', status: 'complete', parts: bubbleParts },
    ];
    this.running = true;
    this.note = undefined;

    // Snapshot the request before crossing into the effect.
    const req: ChatTurnRequestT = {
      sessionId: this.sessionId,
      themeContext: ctx.themeContext,
      fields: ctx.fields,
      currentData: ctx.currentData,
      currentArtFileName: ctx.currentArtFileName,
      userPrompt: text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(ctx.docContext !== undefined ? { docContext: ctx.docContext } : {}),
    };
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.turn(req)));
    if (this.get(null)) return; // destroyed mid-turn
    this.applyTurnExit(userId, exit, ctx);
  }

  /** Materialize a settled turn onto this turn's assistant message (shared by send/regenerate). */
  private applyTurnExit(
    userId: string,
    exit: Exit.Exit<ChatTurnResponseT, unknown>,
    ctx: ChatContext,
  ): void {
    if (Exit.isSuccess(exit) && !this.canceling) {
      const res = exit.value;
      this.sessionId = res.sessionId; // lazy-created session captured
      this.finalizeAssistant(userId, materializeAssistantParts(res.assistantText), 'complete');
      if (Object.keys(res.patch).length > 0) ctx.applyPatch(res.patch);
      // Settings knobs apply SYNCHRONOUSLY, before art starts (spec ordering:
      // "switch to fullart and generate art" must render at the new aspect).
      this.applySettings(ctx, res.actions ?? []);
      // Detached: the reply renders now; art then doc actions sequence behind it.
      void this.runPostTurn(
        ctx,
        res.artAction,
        (res.actions ?? []).filter((a) => !isSettingsAction(a)),
      );
    } else if (this.canceling) {
      this.finalizeAssistant(userId, [{ _tag: 'Text', text: 'Canceled.' }], 'incomplete');
    } else {
      const message = noteFromCause((exit as Exit.Failure<unknown, unknown>).cause);
      this.note = message;
      this.finalizeAssistant(userId, [{ _tag: 'Text', text: message }], 'incomplete');
    }
    this.canceling = false;
    this.running = false;
  }

  /** Apply the settings knobs in order; a failed knob names itself in the note. */
  private applySettings(ctx: ChatContext, actions: readonly DocActionT[]): void {
    for (const action of actions) {
      if (!isSettingsAction(action)) continue;
      const ok =
        action.kind === 'setLayout'
          ? ctx.setLayout(action.layoutId)
          : action.kind === 'setTheme'
            ? ctx.setTheme(action.themeId)
            : ctx.setHolo(action.value);
      if (!ok) this.note = `action failed: ${action.kind}`;
    }
  }

  /**
   * Post-turn side effects, sequenced: the art run first (so a same-turn save
   * or export captures the NEW art), then each document action in order. A
   * failed action surfaces in the note strip; the reply is already rendered.
   */
  private async runPostTurn(
    ctx: ChatContext,
    artAction: ArtActionT | undefined,
    actions: readonly DocActionT[],
  ): Promise<void> {
    if (artAction !== undefined) await ctx.runArt(artAction);
    for (const action of actions) {
      if (this.get(null)) return;
      if (isSettingsAction(action)) continue; // applied synchronously pre-art
      const ok = await (action.kind === 'save'
        ? ctx.save()
        : action.kind === 'saveAsCopy'
          ? ctx.saveAsCopy()
          : ctx.exportRender(action.target));
      if (!ok && !this.get(null)) {
        this.note = action.kind === 'export' ? 'export failed' : 'save failed';
      }
    }
  }

  /**
   * Finalize this turn's assistant message: the one streamed in after `userId`
   * (SSE) gets its parts replaced by the materialized ones; otherwise append.
   */
  private finalizeAssistant(userId: string, parts: ThreadPartT[], status: MessageStatusT): void {
    const userIdx = this.messages.findIndex((m) => m.id === userId);
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
      next[target] = { ...message, parts, status };
      this.messages = next;
    } else {
      this.messages = [
        ...this.messages,
        { id: MessageId.make(crypto.randomUUID()), role: 'assistant', status, parts },
      ];
    }
  }
}
