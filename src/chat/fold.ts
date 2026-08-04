/**
 * The pure thread-event fold (spec §Future-proofing 6).
 *
 * `foldThreadEvent(messages, event)` is the single reducer that assembles the
 * conversation from the server→client event stream. It is deterministic and
 * standalone — no `this`, no effects — so it is exhaustively testable and
 * portable to any store. `ThreadState` merely applies it and returns the new
 * array (new references throughout, for expressive reactivity).
 *
 * Session filtering and the pendingPermission field live in ThreadState; this
 * fold is total over ThreadEvent and leaves PermissionRequested untouched.
 */

import { Match } from 'effect';
import { MessageId, type MessageIdT } from '@/contracts/ids';
import {
  CARD_GENERATE_ART_TOOL,
  looksLikeContract,
  materializeAssistantParts,
} from '@/contracts/materialize';
import type { ArtPhaseT, ThreadEventT, ThreadMessageT, ThreadPartT } from '@/contracts/thread';

const runningAssistant = (id: MessageIdT, parts: ThreadPartT[] = []): ThreadMessageT => ({
  id,
  role: 'assistant',
  status: 'running',
  parts,
});

/** Replace one message in the list by index, preserving identity elsewhere. */
const replaceAt = (
  messages: readonly ThreadMessageT[],
  index: number,
  message: ThreadMessageT,
): ThreadMessageT[] => {
  const next = [...messages];
  next[index] = message;
  return next;
};

const lastAssistantIndex = (messages: readonly ThreadMessageT[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
};

const artStatus = (phase: ArtPhaseT): 'running' | 'completed' | 'error' =>
  phase === 'downloaded' ? 'completed' : phase === 'error' ? 'error' : 'running';

const artPart = (phase: ArtPhaseT, detail?: string): ThreadPartT => ({
  _tag: 'ToolCall',
  callId: CARD_GENERATE_ART_TOOL,
  name: CARD_GENERATE_ART_TOOL,
  title: 'Generate art',
  status: artStatus(phase),
  ...(detail !== undefined ? { result: detail } : {}),
});

/** Compile-time exhaustive dispatch (spec §Match): a new ThreadEvent variant fails tsc here. */
export function foldThreadEvent(messages: ThreadMessageT[], event: ThreadEventT): ThreadMessageT[] {
  return Match.value(event).pipe(
    Match.tag('TurnStarted', (e) => {
      // Idempotent: a replayed TurnStarted (SSE reconnect) never duplicates.
      if (messages.some((m) => m.id === e.messageId)) return [...messages];
      return [...messages, runningAssistant(e.messageId)];
    }),

    Match.tag('PartDelta', (e) => {
      const index = messages.findIndex((m) => m.id === e.messageId);
      if (index < 0) return [...messages]; // unknown message — no ghost
      const message = messages[index];
      if (message === undefined) return [...messages];
      const parts = [...message.parts];
      while (parts.length <= e.partIndex) parts.push({ _tag: 'Text', text: '' });
      parts[e.partIndex] = e.part;
      return replaceAt(messages, index, { ...message, parts });
    }),

    Match.tag('TurnCompleted', (e) => {
      const index = messages.findIndex((m) => m.id === e.messageId);
      if (index < 0) return [...messages];
      const message = messages[index];
      if (message === undefined) return [...messages];
      // A stream-only viewer (second tab, replay) never receives the turn
      // response that normally swaps in materialized parts — materialize any
      // contract-looking raw text here so the v1 JSON never renders.
      const parts = message.parts.flatMap((part) =>
        part._tag === 'Text' && looksLikeContract(part.text)
          ? materializeAssistantParts(part.text)
          : [part],
      );
      return replaceAt(messages, index, { ...message, status: e.status, parts });
    }),

    Match.tag('Art', (e) => {
      const index = lastAssistantIndex(messages);
      if (index < 0) {
        // Fallback system strip — only when there is no assistant message at all.
        return [
          ...messages,
          {
            id: MessageId.make('system-art'),
            role: 'assistant' as const,
            status: 'complete' as const,
            parts: [artPart(e.phase, e.detail)],
          },
        ];
      }
      const message = messages[index];
      if (message === undefined) return [...messages];
      const parts = [...message.parts];
      const pIdx = parts.findIndex(
        (p) => p._tag === 'ToolCall' && p.callId === CARD_GENERATE_ART_TOOL,
      );
      const existing = pIdx >= 0 ? parts[pIdx] : undefined;
      const updated: ThreadPartT =
        existing !== undefined && existing._tag === 'ToolCall'
          ? {
              ...existing,
              status: artStatus(e.phase),
              ...(e.detail !== undefined ? { result: e.detail } : {}),
            }
          : artPart(e.phase, e.detail);
      if (pIdx >= 0) parts[pIdx] = updated;
      else parts.push(updated);
      return replaceAt(messages, index, { ...message, parts });
    }),

    Match.tag('SessionError', (e) => {
      // Mark the last running assistant message incomplete + append an error strip.
      let index = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant' && messages[i]?.status === 'running') {
          index = i;
          break;
        }
      }
      if (index < 0) return [...messages];
      const message = messages[index];
      if (message === undefined) return [...messages];
      return replaceAt(messages, index, {
        ...message,
        status: 'incomplete',
        parts: [...message.parts, { _tag: 'Text', text: e.message }],
      });
    }),

    // Not a message mutation — same reference back (ThreadState records it
    // as pendingPermission; identity lets expressive skip the re-render).
    Match.tag('PermissionRequested', () => messages),

    Match.exhaustive,
  );
}
