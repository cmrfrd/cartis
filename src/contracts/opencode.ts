/**
 * Schema contracts for the opencode SDK responses consumed by the agent bridge.
 *
 * These are lenient fully-optional structs replacing the `rec()` guards and casts
 * in src/server/agentBridge.ts:45-65 and the session-create path (~lines 68-110).
 *
 * Designed so `Schema.decodeUnknownOption` on these + the existing tsx-fence
 * decoding of agent prompt results (fill-patch extraction reuses these shapes).
 *
 * Verified against agentBridge.ts:
 *   SessionCreated — lines 76-78:
 *     rec(rec(created)?.data) ?? rec(created)  then  createdData.id
 *   PromptResult   — prompt-result payload walk:
 *     data.structured_output.code
 *     data.info.structured_output.code
 *     data.parts[].{ type: 'text', text }
 */

import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// SessionCreated
//
// The agent bridge reads the session id via:
//   const createdData = rec(rec(created)?.data) ?? rec(created);
//   const id = typeof createdData?.id === 'string' ? createdData.id : undefined;
//
// Two possible shapes:
//   { data: { id: string } }   (wrapped)
//   { id: string }             (flat)
//
// We model a superset struct so both paths decode without field loss.
// A Schema.Union of two fully-optional structs would be ambiguous at runtime
// (any object matches the first member); the superset avoids that problem.
// ---------------------------------------------------------------------------

export const SessionCreated = Schema.Struct({
  id: Schema.optional(Schema.String),
  data: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
    }),
  ),
});
export type SessionCreatedT = typeof SessionCreated.Type;

// ---------------------------------------------------------------------------
// PromptResult
//
// Prompt-result consumers walk two nested paths:
//
// Path A — structured_output:
//   rec(result).data.structured_output.code          (direct)
//   rec(result).data.info.structured_output.code     (nested via info)
//   (the code also tries rec(result).structured_output.code when data is absent)
//
// Path B — parts with text:
//   rec(result).data.parts[].{ type: 'text', text }
//   (then regex-extracts tsx fences from the concatenated text)
//
// We model the superset so both paths are reachable from one type.
// ---------------------------------------------------------------------------

const StructuredOutput = Schema.Struct({
  code: Schema.optional(Schema.String),
});

const TextPart = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

const PromptData = Schema.Struct({
  structured_output: Schema.optional(StructuredOutput),
  info: Schema.optional(
    Schema.Struct({
      structured_output: Schema.optional(StructuredOutput),
    }),
  ),
  parts: Schema.optional(Schema.Array(TextPart)),
});

export const PromptResult = Schema.Struct({
  data: Schema.optional(PromptData),
  // flat fallback — consumers resolve `const data = value.data ?? value`, then
  // walks: `data.info?.structured_output ?? data.structured_output ?? value.structured_output`
  // so result itself may be the data object when there is no wrapper.
  structured_output: Schema.optional(StructuredOutput),
  info: Schema.optional(
    Schema.Struct({
      structured_output: Schema.optional(StructuredOutput),
    }),
  ),
  parts: Schema.optional(Schema.Array(TextPart)),
});
export type PromptResultT = typeof PromptResult.Type;

// ---------------------------------------------------------------------------
// AgentEvent
//
// Lenient slice of the opencode global event stream (client.event.subscribe →
// SSE of the SDK's Event union). Only the fields the bridge's activity watcher
// reads (spec 2026-08-02-agent-activity-observability): event type, the part's
// type/session/message/call identity, tool name, and the tool state's
// status/title/error/timing. Unknown events simply fail decode and are skipped.
// ---------------------------------------------------------------------------

const AgentToolState = Schema.Struct({
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.String),
  time: Schema.optional(
    Schema.Struct({
      start: Schema.optional(Schema.Number),
      end: Schema.optional(Schema.Number),
    }),
  ),
});

const AgentEventPart = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  state: Schema.optional(AgentToolState),
});

/**
 * `message.updated` payload: the message envelope with role and lifecycle
 * timestamps. The watcher uses it to tell assistant messages from the user's
 * own prompt echo, and `time.completed` to detect turn completion.
 */
const AgentMessageInfo = Schema.Struct({
  id: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  time: Schema.optional(
    Schema.Struct({
      created: Schema.optional(Schema.Number),
      completed: Schema.optional(Schema.Number),
    }),
  ),
});

export const AgentEvent = Schema.Struct({
  type: Schema.String,
  properties: Schema.optional(
    Schema.Struct({
      part: Schema.optional(AgentEventPart),
      info: Schema.optional(AgentMessageInfo),
      error: Schema.optional(Schema.Unknown),
      // permission.updated carries its fields flat on properties
      id: Schema.optional(Schema.String),
      sessionID: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});
export type AgentEventT = typeof AgentEvent.Type;

// ---------------------------------------------------------------------------
// SessionMessages — lenient read of `session.messages()` (card chat panel).
//
// SDK shape: Array<{ info: Message, parts: Array<Part> }>. We model only the
// fields history mapping reads: message id/role/completion/error, and each
// part's type + text + tool identity/state. Every field optional so partial or
// drifted rows still decode (tolerant boundaries).
// ---------------------------------------------------------------------------

const SessionPartState = Schema.Struct({
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  time: Schema.optional(
    Schema.Struct({
      start: Schema.optional(Schema.Number),
      end: Schema.optional(Schema.Number),
    }),
  ),
});

const SessionMessagePart = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  synthetic: Schema.optional(Schema.Boolean),
  callID: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  state: Schema.optional(SessionPartState),
});
export type SessionMessagePartT = typeof SessionMessagePart.Type;

const SessionMessageInfo = Schema.Struct({
  id: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  time: Schema.optional(
    Schema.Struct({
      created: Schema.optional(Schema.Number),
      completed: Schema.optional(Schema.Number),
    }),
  ),
  error: Schema.optional(Schema.Unknown),
});

export const SessionMessage = Schema.Struct({
  info: Schema.optional(SessionMessageInfo),
  parts: Schema.optional(Schema.Array(SessionMessagePart)),
});
export type SessionMessageT = typeof SessionMessage.Type;

export const SessionMessages = Schema.Array(SessionMessage);
export type SessionMessagesT = typeof SessionMessages.Type;

// ---------------------------------------------------------------------------
// SessionInfo — lenient read of a Session (fork/children/get). Carries id +
// parentID + title (→ ThreadSummary) and the revert marker (history excludes
// messages at/after revert.messageID — no ghosts after edit/regenerate).
// ---------------------------------------------------------------------------

export const SessionInfo = Schema.Struct({
  id: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  revert: Schema.optional(
    Schema.Struct({
      messageID: Schema.optional(Schema.String),
    }),
  ),
});
export type SessionInfoT = typeof SessionInfo.Type;

export const SessionInfoList = Schema.Array(SessionInfo);
export type SessionInfoListT = typeof SessionInfoList.Type;
