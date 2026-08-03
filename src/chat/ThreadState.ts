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
import type { ArtActionT, CardDataT, ChatTurnRequestT, ChatTurnResponseT } from '@/contracts/api';
import { noteFromCause } from '@/contracts/errors';
import type { FieldSummaryT } from '@/contracts/fields';
import { MessageId, type MessageIdT, type PermissionIdT, type SessionIdT } from '@/contracts/ids';
import { materializeAssistantParts } from '@/contracts/materialize';
import type { ThemeContextT } from '@/contracts/theme';
import type {
  MessageStatusT,
  ThreadEventT,
  ThreadMessageT,
  ThreadPartT,
  ThreadSummaryT,
} from '@/contracts/thread';
import { ChatEvents } from './ChatEvents';
import { ChatThread } from './ChatThread';
import { foldThreadEvent } from './fold';

/** The card context + appliers BuilderView injects so a turn can edit the card. */
export interface ChatContext {
  readonly themeContext: ThemeContextT;
  readonly fields: readonly FieldSummaryT[];
  readonly currentData: CardDataT;
  readonly currentArtFileName?: string;
  /** Apply the agent's field patch to the open document. */
  applyPatch(patch: CardDataT): void;
  /** Delegate an art action to the builder's art run (phases arrive as Art events). */
  runArt(action: ArtActionT): void;
  /** Mark the document dirty (e.g. switching to a branch is a saved-state change). */
  markDirty(): void;
}

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
  /** Branch (fork) siblings of the current session (branch picker). */
  branches: ThreadSummaryT[] = [];
  /** True between cancel() and the turn settling — makes the turn finalize incomplete. */
  canceling = false;
  /** The user message currently being inline-edited, and its working text. */
  editingId?: MessageIdT = undefined;
  editDraft = '';

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
    this.branches = [];
    this.canceling = false;
  }

  /** Submit the composer draft as a turn (Enter / Send button). */
  submitDraft(): void {
    const text = this.draft.trim();
    if (text.length === 0 || this.running) return;
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
      if (res.artAction !== undefined) ctx.runArt(res.artAction);
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
      void this.loadBranches();
    }
    // Trim local history back to before the edited message, then resend.
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) this.messages = this.messages.slice(0, idx);
    await this.send(text);
  }

  /** Switch to a branch (fork) session: rebind, rehydrate, mark the doc dirty. */
  async switchBranch(sessionId: SessionIdT): Promise<void> {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.context?.()?.markDirty();
    await this.rehydrate();
    void this.loadBranches();
  }

  /** Load the current session's branch siblings into `branches`. */
  async loadBranches(): Promise<void> {
    const sid = this.sessionId;
    if (sid === undefined) {
      this.branches = [];
      return;
    }
    const exit = await runAppExit(Effect.flatMap(ChatThread, (c) => c.children(sid)));
    if (this.get(null)) return;
    if (Exit.isSuccess(exit)) this.branches = [...exit.value];
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
    if (ctx === undefined || text.trim().length === 0) return;

    const userId = MessageId.make(crypto.randomUUID());
    this.messages = [
      ...this.messages,
      { id: userId, role: 'user', status: 'complete', parts: [{ _tag: 'Text', text }] },
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
      if (res.artAction !== undefined) ctx.runArt(res.artAction);
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
