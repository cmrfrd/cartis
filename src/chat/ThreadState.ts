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
import { Effect, Exit, Fiber, Stream } from 'effect';
import { forkApp, runAppExit } from '../app/runtime';
import type { ArtActionT, CardDataT, ChatTurnRequestT } from '../contracts/api';
import { noteFromCause } from '../contracts/errors';
import { materializeAssistantParts } from '../contracts/materialize';
import type { ThemeContextT } from '../contracts/theme';
import type {
  MessageStatusT,
  ThreadEventT,
  ThreadMessageT,
  ThreadPartT,
} from '../contracts/thread';
import { ChatEvents } from './ChatEvents';
import { ChatThread } from './ChatThread';
import { foldThreadEvent } from './fold';

/** Field summary the agent sees (kind + key + label) — a slice of FieldSpec. */
export interface ChatFieldSummary {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
}

/** The card context + appliers BuilderView injects so a turn can edit the card. */
export interface ChatContext {
  readonly themeContext: ThemeContextT;
  readonly fields: readonly ChatFieldSummary[];
  readonly currentData: CardDataT;
  readonly currentArtFileName?: string;
  /** Apply the agent's field patch to the open document. */
  applyPatch(patch: CardDataT): void;
  /** Delegate an art action to the builder's art run (phases arrive as Art events). */
  runArt(action: ArtActionT): void;
}

export interface PendingPermission {
  readonly sessionId: string;
  readonly permissionId: string;
  readonly title: string;
}

const eventSessionId = (event: ThreadEventT): string | undefined => {
  switch (event._tag) {
    case 'TurnStarted':
    case 'PartDelta':
    case 'TurnCompleted':
    case 'PermissionRequested':
      return event.sessionId;
    default:
      return undefined;
  }
};

export class ThreadState extends State {
  messages: ThreadMessageT[] = [];
  running = false;
  sessionId?: string = undefined;
  pendingPermission?: PendingPermission = undefined;
  note?: string = undefined;

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
    const sid = eventSessionId(event);
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

  /** Bind a saved card's session and rehydrate its conversation. */
  bind(sessionId: string): void {
    this.sessionId = sessionId;
    void this.rehydrate();
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

    const userId = crypto.randomUUID();
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

    if (Exit.isSuccess(exit)) {
      const res = exit.value;
      this.sessionId = res.sessionId; // lazy-created session captured
      this.finalizeAssistant(userId, materializeAssistantParts(res.assistantText), 'complete');
      if (Object.keys(res.patch).length > 0) ctx.applyPatch(res.patch);
      if (res.artAction !== undefined) ctx.runArt(res.artAction);
    } else {
      const message = noteFromCause(exit.cause);
      this.note = message;
      this.finalizeAssistant(userId, [{ _tag: 'Text', text: message }], 'incomplete');
    }
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
        { id: crypto.randomUUID(), role: 'assistant', status, parts },
      ];
    }
  }
}
