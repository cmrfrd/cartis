/**
 * Codec matrix for the canonical thread contracts
 * (spec: 2026-08-03-card-chat-panel-design §Decision 1).
 *
 * Every ThreadPart and ThreadEvent variant decodes and encodes through the
 * tagged unions; unknown tags are rejected. Plain it() — synchronous
 * Schema.decodeUnknownSync tests, matching contracts.test.ts style.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  ThreadEvent,
  ThreadEventJson,
  type ThreadEventT,
  ThreadMessage,
  ThreadPart,
  type ThreadPartT,
  ThreadSummary,
} from './thread';

const decodePart = Schema.decodeUnknownSync(ThreadPart);
const decodeEvent = Schema.decodeUnknownSync(ThreadEvent);

// ---------------------------------------------------------------------------
// ThreadPart variants
// ---------------------------------------------------------------------------

describe('ThreadPart', () => {
  it('decodes every variant', () => {
    const parts: ThreadPartT[] = [
      { _tag: 'Text', text: 'hello' },
      { _tag: 'Reasoning', text: 'thinking about it' },
      {
        _tag: 'ToolCall',
        callId: 'c1',
        name: 'read',
        title: 'src/main.tsx',
        status: 'completed',
        argsText: '{"path":"src/main.tsx"}',
        result: 'ok',
        isError: false,
        secs: 2.1,
      },
      { _tag: 'Image', url: 'blob:abc' },
      { _tag: 'Step' },
    ];
    for (const part of parts) {
      expect(decodePart(part)).toEqual(part);
    }
  });

  it('decodes a minimal ToolCall (optionals absent)', () => {
    const minimal = { _tag: 'ToolCall', callId: 'c2', name: 'bash', status: 'running' };
    expect(decodePart(minimal)).toEqual(minimal);
  });

  it('rejects unknown tags and bad statuses', () => {
    expect(() => decodePart({ _tag: 'Video', url: 'x' })).toThrow();
    expect(() =>
      decodePart({ _tag: 'ToolCall', callId: 'c', name: 'n', status: 'exploded' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ThreadMessage
// ---------------------------------------------------------------------------

describe('ThreadMessage', () => {
  it('decodes a message with ordered mixed parts', () => {
    const message = {
      id: 'm1',
      role: 'assistant',
      status: 'running',
      parts: [
        { _tag: 'Step' },
        { _tag: 'Reasoning', text: 'hmm' },
        { _tag: 'ToolCall', callId: 'c1', name: 'read', status: 'running' },
        { _tag: 'Text', text: 'The card' },
      ],
    };
    expect(Schema.decodeUnknownSync(ThreadMessage)(message)).toEqual(message);
  });

  it('rejects unknown roles and statuses', () => {
    const base = { id: 'm1', parts: [] };
    expect(() =>
      Schema.decodeUnknownSync(ThreadMessage)({ ...base, role: 'system', status: 'complete' }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ThreadMessage)({ ...base, role: 'user', status: 'paused' }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ThreadEvent variants
// ---------------------------------------------------------------------------

describe('ThreadEvent', () => {
  const events: ThreadEventT[] = [
    { _tag: 'TurnStarted', sessionId: 's1', messageId: 'm1' },
    {
      _tag: 'PartDelta',
      sessionId: 's1',
      messageId: 'm1',
      partIndex: 0,
      part: { _tag: 'Text', text: 'cumulative so far' },
    },
    { _tag: 'TurnCompleted', sessionId: 's1', messageId: 'm1', status: 'complete' },
    { _tag: 'TurnCompleted', sessionId: 's1', messageId: 'm1', status: 'incomplete' },
    { _tag: 'Art', phase: 'generating', detail: 'prediction p1 created' },
    { _tag: 'Art', phase: 'composing' },
    { _tag: 'SessionError', message: 'boom' },
    { _tag: 'PermissionRequested', sessionId: 's1', permissionId: 'p1', title: 'Run bash?' },
  ];

  it('decodes every variant', () => {
    for (const event of events) {
      expect(decodeEvent(event)).toEqual(event);
    }
  });

  it('rejects unknown event tags, art phases, and completion statuses', () => {
    expect(() => decodeEvent({ _tag: 'Telemetry', data: 1 })).toThrow();
    expect(() => decodeEvent({ _tag: 'Art', phase: 'uploading' })).toThrow();
    expect(() =>
      decodeEvent({ _tag: 'TurnCompleted', sessionId: 's', messageId: 'm', status: 'running' }),
    ).toThrow();
  });

  it('round-trips every variant through the JSON codec (SSE frame shape)', () => {
    for (const event of events) {
      const json = Schema.encodeSync(ThreadEventJson)(event);
      expect(typeof json).toBe('string');
      expect(Schema.decodeUnknownSync(ThreadEventJson)(json)).toEqual(event);
    }
  });

  it('rejects malformed JSON frames', () => {
    expect(() => Schema.decodeUnknownSync(ThreadEventJson)('not json')).toThrow();
    expect(() => Schema.decodeUnknownSync(ThreadEventJson)('{"_tag":"Nope"}')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ThreadSummary
// ---------------------------------------------------------------------------

describe('ThreadSummary', () => {
  it('decodes with and without optional fields', () => {
    expect(Schema.decodeUnknownSync(ThreadSummary)({ sessionId: 's1' })).toEqual({
      sessionId: 's1',
    });
    const full = { sessionId: 's2', title: 'branch of s1', parentId: 's1' };
    expect(Schema.decodeUnknownSync(ThreadSummary)(full)).toEqual(full);
  });
});
