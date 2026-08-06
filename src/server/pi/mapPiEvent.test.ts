/**
 * The pi-event reducer, unit-level: injectable `now`/`mintId` make the text
 * throttle and round merging deterministically testable (the multi-round
 * ghost bug of 2026-08-04 lived exactly here).
 */

import { describe, expect, it } from 'vitest';
import { SessionId } from '@/contracts/ids';
import { initialPiWatchState, mapPiEvent, type PiWatchState } from './mapPiEvent';

const SID = SessionId.make('s1');
let minted = 0;
const mintId = () => `m${String(++minted)}`;

const start = { type: 'message_start', message: { role: 'assistant' } };
const textEvent = (type: string, text: string, contentIndex = 0) => ({
  type: 'message_update',
  assistantMessageEvent: {
    type,
    contentIndex,
    partial: { content: [...Array(contentIndex).fill({ type: 'pad' }), { type: 'text', text }] },
  },
});
const toolEnd = (name: string, id: string, contentIndex = 0) => ({
  type: 'message_update',
  assistantMessageEvent: {
    type: 'toolcall_end',
    contentIndex,
    partial: {
      content: [
        ...Array(contentIndex).fill({ type: 'pad' }),
        { type: 'toolCall', id, name, arguments: { x: 1 } },
      ],
    },
  },
});

function run(
  events: unknown[],
  startNow = 0,
  step = 0,
): { out: ReturnType<typeof mapPiEvent>['events'][]; state: PiWatchState } {
  let state = initialPiWatchState;
  let now = startNow;
  const out: ReturnType<typeof mapPiEvent>['events'][] = [];
  for (const event of events) {
    const r = mapPiEvent(event, SID, state, now, mintId);
    state = r.state;
    out.push(r.events);
    now += step;
  }
  return { out, state };
}

describe('mapPiEvent', () => {
  it('mints ONE TurnStarted for the whole turn; later rounds continue it', () => {
    const { out } = run([start, toolEnd('card_patch', 'c1'), start, textEvent('text_end', 'done')]);
    const started = out.flat().filter((e) => e._tag === 'TurnStarted');
    expect(started).toHaveLength(1);
    // second round's message_start emits nothing
    expect(out[2]).toEqual([]);
    // all deltas ride the SAME minted message id
    const deltas = out.flat().filter((e) => e._tag === 'PartDelta');
    expect(new Set(deltas.map((e) => e.messageId)).size).toBe(1);
  });

  it('offsets later rounds past the previous rounds parts', () => {
    const { out } = run([
      start,
      toolEnd('card_patch', 'c1', 0),
      toolEnd('card_save', 'c2', 1),
      start, // round 2 begins after global indexes 0,1
      textEvent('text_end', 'done', 0),
    ]);
    const deltas = out.flat().filter((e) => e._tag === 'PartDelta');
    expect(deltas.map((e) => e.partIndex)).toEqual([0, 1, 2]); // text lands AFTER the tools
  });

  it('throttles cumulative text but text_end always flushes', () => {
    // step=0: every event at t=0, inside the 2s window
    const { out } = run(
      [
        start,
        textEvent('text_start', ''),
        textEvent('text_delta', 'He'), // within throttle → dropped
        textEvent('text_delta', 'Hel'), // within throttle → dropped
        textEvent('text_end', 'Hello'), // final flush ALWAYS emits
      ],
      0,
      0,
    );
    const texts = out
      .flat()
      .filter((e) => e._tag === 'PartDelta')
      .map((e) => (e.part._tag === 'Text' ? e.part.text : '?'));
    expect(texts).toEqual(['', 'Hello']); // first emit + the final flush only
  });

  it('emits again once the throttle window passes', () => {
    const { out } = run(
      [start, textEvent('text_start', ''), textEvent('text_delta', 'Partial')],
      0,
      3000, // each event 3s apart — outside the 2s window
    );
    const texts = out
      .flat()
      .filter((e) => e._tag === 'PartDelta')
      .map((e) => (e.part._tag === 'Text' ? e.part.text : '?'));
    expect(texts).toEqual(['', 'Partial']);
  });

  it('tool_execution_end resolves the call to completed/error at its GLOBAL index', () => {
    const { out } = run([
      start,
      toolEnd('card_patch', 'call-1', 0),
      start, // next round — the execution event arrives after the round rolls
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'card_patch',
        isError: false,
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    ]);
    const deltas = out.flat().filter((e) => e._tag === 'PartDelta');
    const done = deltas.at(-1);
    expect(done?.partIndex).toBe(0); // still the ORIGINAL global index
    expect(done?.part._tag === 'ToolCall' ? done.part.status : '?').toBe('completed');
    expect(done?.part._tag === 'ToolCall' ? done.part.result : '?').toBe('ok');
  });

  it('inner error events become SessionError', () => {
    const { out } = run([
      start,
      { type: 'message_update', assistantMessageEvent: { type: 'error' } },
    ]);
    expect(out.flat().some((e) => e._tag === 'SessionError')).toBe(true);
  });

  it('non-assistant message_start and unknown events are ignored', () => {
    const { out } = run([
      { type: 'message_start', message: { role: 'user' } },
      { type: 'something_else' },
    ]);
    expect(out.flat()).toEqual([]);
  });
});
