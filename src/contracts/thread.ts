/**
 * Canonical thread contracts — the load-bearing artifact of the chat panel
 * (spec: 2026-08-03-card-chat-panel-design §Decision 1).
 *
 * assistant-ui's presentation vocabulary (messages of ordered parts, tool
 * calls with status, streaming deltas) expressed as effect Schema tagged
 * unions. The server bridge maps opencode wire shapes INTO these; the client
 * consumes ONLY these. This module must never import contracts/opencode.ts
 * (dependency direction is law — spec §Future-proofing 4).
 */

import { Schema } from 'effect';
import { MessageId, PermissionId, SessionId } from './ids.ts';

// ---------------------------------------------------------------------------
// ThreadPart — the ordered content units of a message
// ---------------------------------------------------------------------------

export const TextPart = Schema.TaggedStruct('Text', {
  text: Schema.String,
});

export const ReasoningPart = Schema.TaggedStruct('Reasoning', {
  text: Schema.String,
});

export const ToolCallStatus = Schema.Literal('pending', 'running', 'completed', 'error');
export type ToolCallStatusT = typeof ToolCallStatus.Type;

export const ToolCallPart = Schema.TaggedStruct('ToolCall', {
  callId: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.String),
  status: ToolCallStatus,
  argsText: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  secs: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
});

export const ImagePart = Schema.TaggedStruct('Image', {
  url: Schema.String,
});

/** Turn segment boundary. Kept in the schema; not rendered in v1. */
export const StepPart = Schema.TaggedStruct('Step', {});

export const ThreadPart = Schema.Union(TextPart, ReasoningPart, ToolCallPart, ImagePart, StepPart);
export type ThreadPartT = typeof ThreadPart.Type;

// ---------------------------------------------------------------------------
// ThreadMessage
// ---------------------------------------------------------------------------

export const MessageRole = Schema.Literal('user', 'assistant');
export type MessageRoleT = typeof MessageRole.Type;

export const MessageStatus = Schema.Literal('running', 'complete', 'incomplete');
export type MessageStatusT = typeof MessageStatus.Type;

export const ThreadMessage = Schema.Struct({
  id: MessageId,
  role: MessageRole,
  status: MessageStatus,
  parts: Schema.Array(ThreadPart),
});
export type ThreadMessageT = typeof ThreadMessage.Type;

// ---------------------------------------------------------------------------
// ThreadEvent — the server→client stream union (SSE)
// ---------------------------------------------------------------------------

export const TurnStarted = Schema.TaggedStruct('TurnStarted', {
  sessionId: SessionId,
  messageId: MessageId,
});

/**
 * Upsert-by-index: text/reasoning parts carry CUMULATIVE text (throttled,
 * with an unthrottled final flush at completion); tool parts carry state
 * transitions. The fold replaces `parts[partIndex]` wholesale.
 */
export const PartDelta = Schema.TaggedStruct('PartDelta', {
  sessionId: SessionId,
  messageId: MessageId,
  partIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  part: ThreadPart,
});

export const TurnCompleted = Schema.TaggedStruct('TurnCompleted', {
  sessionId: SessionId,
  messageId: MessageId,
  status: Schema.Literal('complete', 'incomplete'),
});

export const ArtPhase = Schema.Literal(
  'composing',
  'generating',
  'progress',
  'downloaded',
  'error',
);
export type ArtPhaseT = typeof ArtPhase.Type;

export const ArtEvent = Schema.TaggedStruct('Art', {
  phase: ArtPhase,
  detail: Schema.optional(Schema.String),
});

export const SessionErrorEvent = Schema.TaggedStruct('SessionError', {
  message: Schema.String,
});

export const PermissionRequested = Schema.TaggedStruct('PermissionRequested', {
  sessionId: SessionId,
  permissionId: PermissionId,
  title: Schema.String,
});

export const ThreadEvent = Schema.Union(
  TurnStarted,
  PartDelta,
  TurnCompleted,
  ArtEvent,
  SessionErrorEvent,
  PermissionRequested,
);
export type ThreadEventT = typeof ThreadEvent.Type;

/** One codec both directions: SSE frame string ⇄ ThreadEvent. */
export const ThreadEventJson = Schema.parseJson(ThreadEvent);

// ---------------------------------------------------------------------------
// ThreadSummary — thread list / branch tree entry
// ---------------------------------------------------------------------------

export const ThreadSummary = Schema.Struct({
  sessionId: SessionId,
  title: Schema.optional(Schema.String),
  parentId: Schema.optional(SessionId),
});
export type ThreadSummaryT = typeof ThreadSummary.Type;
