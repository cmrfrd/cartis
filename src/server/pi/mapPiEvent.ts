/**
 * Pure reducer: pi AgentSessionEvents → ThreadEvents (migration spec §4.3).
 * The pi AgentEvent → ThreadEvent reducer. Two event layers are
 * handled: INNER AssistantMessageEvents carried by `message_update`
 * (text and toolcall variants — we render from the CUMULATIVE `partial` message), and
 * TOP-LEVEL `tool_execution_*` events. `TurnCompleted` is NOT emitted here —
 * the turn orchestrator emits it when `prompt()` resolves (agent_end may
 * auto-retry).
 *
 * Live message ids are BRIDGE-MINTED (pi mints entry ids only at persist,
 * after events fire); the client re-keys to entry ids from the turn response.
 */

import { MessageId, type MessageIdT, type SessionIdT } from '../../contracts/ids.ts';
import type { ThreadEventT, ThreadPartT } from '../../contracts/thread.ts';

const TEXT_THROTTLE_MS = 2000;

export interface PiWatchState {
  /** Bridge-minted id for THIS TURN's assistant message. Pi fires one
   * `message_start` per agent-loop round (toolcall round, text round, …);
   * all rounds merge into ONE streamed message — exactly how entries.ts
   * merges them on rehydration and how finalizeAssistant replaces them. */
  readonly messageId?: MessageIdT;
  /** Global part-index offset for the CURRENT round (rounds restart at 0). */
  readonly partBase: number;
  /** Highest global part index emitted so far (next round's base − 1). */
  readonly maxPartIndex: number;
  /** GLOBAL part index → last text emit time (throttle). */
  readonly lastTextEmit: Readonly<Record<number, number>>;
  /** toolCallId → GLOBAL part index (execution events don't carry one). */
  readonly toolIndex: Readonly<Record<string, number>>;
}

export const initialPiWatchState: PiWatchState = {
  partBase: 0,
  maxPartIndex: -1,
  lastTextEmit: {},
  toolIndex: {},
};

/** Loose structural view of the pi events we consume (type-only safety net). */
interface PiEventView {
  type: string;
  message?: { role?: string };
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    partial?: {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
      }>;
    };
  };
  toolCallId?: string;
  toolName?: string;
  result?: { content?: Array<{ type: string; text?: string }> };
  isError?: boolean;
}

export function mapPiEvent(
  raw: unknown,
  sessionId: SessionIdT,
  state: PiWatchState,
  now: number,
  mintId: () => string,
): { events: ThreadEventT[]; state: PiWatchState } {
  const event = raw as PiEventView;
  switch (event.type) {
    case 'message_start': {
      if (event.message?.role !== 'assistant') return { events: [], state };
      // Later rounds CONTINUE the same streamed message at offset indexes.
      if (state.messageId !== undefined) {
        return {
          events: [],
          state: { ...state, partBase: state.maxPartIndex + 1 },
        };
      }
      const messageId = MessageId.make(mintId());
      return {
        events: [{ _tag: 'TurnStarted', sessionId, messageId }],
        state: { messageId, partBase: 0, maxPartIndex: -1, lastTextEmit: {}, toolIndex: {} },
      };
    }
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      const messageId = state.messageId;
      if (inner === undefined || messageId === undefined) return { events: [], state };
      const roundIndex = inner.contentIndex ?? 0;
      const block = inner.partial?.content?.[roundIndex];
      const index = state.partBase + roundIndex; // global part index
      const bumped = Math.max(state.maxPartIndex, index);
      if (inner.type === 'text_delta' || inner.type === 'text_end' || inner.type === 'text_start') {
        const text = block?.type === 'text' ? (block.text ?? '') : '';
        const last = state.lastTextEmit[index];
        // Cumulative text from `partial`; throttled, but the FIRST emit per
        // part and the final flush (text_end) always go through. (`last
        // undefined` must emit explicitly — `?? 0` only worked because real
        // clock values dwarf the window.)
        if (inner.type !== 'text_end' && last !== undefined && now - last < TEXT_THROTTLE_MS) {
          return { events: [], state: { ...state, maxPartIndex: bumped } };
        }
        return {
          events: [
            {
              _tag: 'PartDelta',
              sessionId,
              messageId,
              partIndex: index,
              part: { _tag: 'Text', text },
            },
          ],
          state: {
            ...state,
            maxPartIndex: bumped,
            lastTextEmit: { ...state.lastTextEmit, [index]: now },
          },
        };
      }
      if (inner.type === 'toolcall_end') {
        if (block?.type !== 'toolCall') return { events: [], state };
        const callId = block.id ?? `call-${String(index)}`;
        const part: ThreadPartT = {
          _tag: 'ToolCall',
          callId,
          name: block.name ?? 'tool',
          status: 'running',
          argsText: JSON.stringify(block.arguments ?? {}),
        };
        return {
          events: [{ _tag: 'PartDelta', sessionId, messageId, partIndex: index, part }],
          state: {
            ...state,
            maxPartIndex: bumped,
            toolIndex: { ...state.toolIndex, [callId]: index },
          },
        };
      }
      if (inner.type === 'error') {
        return { events: [{ _tag: 'SessionError', message: 'model stream error' }], state };
      }
      return { events: [], state };
    }
    case 'tool_execution_end': {
      const messageId = state.messageId;
      const callId = event.toolCallId;
      if (messageId === undefined || callId === undefined) return { events: [], state };
      const index = state.toolIndex[callId];
      if (index === undefined) return { events: [], state };
      const resultText = event.result?.content?.find((c) => c.type === 'text')?.text;
      const part: ThreadPartT = {
        _tag: 'ToolCall',
        callId,
        name: event.toolName ?? 'tool',
        status: event.isError === true ? 'error' : 'completed',
        ...(resultText !== undefined ? { result: resultText } : {}),
        ...(event.isError === true ? { isError: true } : {}),
      };
      return {
        events: [{ _tag: 'PartDelta', sessionId, messageId, partIndex: index, part }],
        state,
      };
    }
    default:
      return { events: [], state };
  }
}
