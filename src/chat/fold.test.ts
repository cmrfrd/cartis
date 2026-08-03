/**
 * The pure thread-event fold (spec §Future-proofing 6): assembles the message
 * list from the SSE event stream. Standalone and exhaustively testable without
 * mounting — ThreadState merely applies it.
 */

import { describe, expect, it } from 'vitest';
import { CARD_GENERATE_ART_TOOL } from '../contracts/materialize';
import type { ThreadEventT, ThreadMessageT } from '../contracts/thread';
import { foldThreadEvent } from './fold';

const started = (messageId: string): ThreadEventT => ({
  _tag: 'TurnStarted',
  sessionId: 's1',
  messageId,
});
const textDelta = (messageId: string, partIndex: number, text: string): ThreadEventT => ({
  _tag: 'PartDelta',
  sessionId: 's1',
  messageId,
  partIndex,
  part: { _tag: 'Text', text },
});
const fold = (events: readonly ThreadEventT[], init: ThreadMessageT[] = []): ThreadMessageT[] =>
  events.reduce<ThreadMessageT[]>((msgs, e) => foldThreadEvent(msgs, e), init);

describe('foldThreadEvent', () => {
  it('TurnStarted appends a running assistant message, idempotently', () => {
    const once = fold([started('m1')]);
    expect(once).toEqual([{ id: 'm1', role: 'assistant', status: 'running', parts: [] }]);
    // a replayed TurnStarted (SSE reconnect) must NOT append a duplicate
    const twice = fold([started('m1'), started('m1')]);
    expect(twice).toHaveLength(1);
  });

  it('PartDelta upserts parts[partIndex] immutably (cumulative text)', () => {
    const out = fold([
      started('m1'),
      textDelta('m1', 0, 'The'),
      textDelta('m1', 0, 'The card'), // same index → cumulative replace
      { _tag: 'PartDelta', sessionId: 's1', messageId: 'm1', partIndex: 1, part: { _tag: 'Step' } },
    ]);
    expect(out[0]?.parts).toEqual([{ _tag: 'Text', text: 'The card' }, { _tag: 'Step' }]);
  });

  it('PartDelta returns a NEW array and NEW message (expressive reactivity)', () => {
    const before = fold([started('m1')]);
    const after = foldThreadEvent(before, textDelta('m1', 0, 'hi'));
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
  });

  it('PartDelta for an unknown message is ignored (no ghost)', () => {
    const out = fold([started('m1'), textDelta('never', 0, 'x')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.parts).toEqual([]);
  });

  it('pads gaps when a delta index outruns the current parts (dropped event)', () => {
    const out = fold([started('m1'), textDelta('m1', 2, 'late')]);
    expect(out[0]?.parts).toEqual([
      { _tag: 'Text', text: '' },
      { _tag: 'Text', text: '' },
      { _tag: 'Text', text: 'late' },
    ]);
  });

  it('TurnCompleted finalizes the message status', () => {
    const out = fold([
      started('m1'),
      textDelta('m1', 0, 'done'),
      { _tag: 'TurnCompleted', sessionId: 's1', messageId: 'm1', status: 'complete' },
    ]);
    expect(out[0]?.status).toBe('complete');
  });

  it('Art upserts a card_generate_art tool part on the LAST assistant message', () => {
    const out = fold([
      started('m1'),
      textDelta('m1', 0, 'Making art'),
      { _tag: 'Art', phase: 'generating', detail: 'prediction p1 created' },
      { _tag: 'Art', phase: 'downloaded', detail: 'output downloaded' },
    ]);
    const parts = out[0]?.parts ?? [];
    const art = parts.find((p) => p._tag === 'ToolCall' && p.callId === CARD_GENERATE_ART_TOOL);
    expect(art?._tag === 'ToolCall' ? art.status : undefined).toBe('completed'); // downloaded
    // only ONE art part despite multiple Art events
    expect(parts.filter((p) => p._tag === 'ToolCall').length).toBe(1);
  });

  it('Art updates the materialized art part in place (no duplicate)', () => {
    const seeded: ThreadMessageT[] = [
      {
        id: 'm1',
        role: 'assistant',
        status: 'complete',
        parts: [
          { _tag: 'Text', text: 'Making it fiercer.' },
          {
            _tag: 'ToolCall',
            callId: CARD_GENERATE_ART_TOOL,
            name: CARD_GENERATE_ART_TOOL,
            title: 'Generate art',
            status: 'completed',
          },
        ],
      },
    ];
    const out = foldThreadEvent(seeded, { _tag: 'Art', phase: 'generating', detail: 'starting' });
    const toolParts = (out[0]?.parts ?? []).filter((p) => p._tag === 'ToolCall');
    expect(toolParts).toHaveLength(1); // updated in place
    expect(toolParts[0]?._tag === 'ToolCall' ? toolParts[0].status : undefined).toBe('running');
  });

  it('Art with no assistant message falls back to a system strip', () => {
    const out = fold([{ _tag: 'Art', phase: 'generating', detail: 'x' }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('assistant');
    expect(out[0]?.parts[0]?._tag).toBe('ToolCall');
  });

  it('SessionError marks the last running assistant message incomplete with an error strip', () => {
    const out = fold([started('m1'), { _tag: 'SessionError', message: 'boom' }]);
    expect(out[0]?.status).toBe('incomplete');
    expect(out[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'boom' });
  });

  it('PermissionRequested does not change the message list (ThreadState tracks it)', () => {
    const before = fold([started('m1')]);
    const after = foldThreadEvent(before, {
      _tag: 'PermissionRequested',
      sessionId: 's1',
      permissionId: 'p1',
      title: 'Run bash?',
    });
    expect(after).toBe(before);
  });
});
