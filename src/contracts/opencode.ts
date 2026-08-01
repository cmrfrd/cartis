/**
 * Schema contracts for the opencode SDK responses consumed by the agent bridge.
 *
 * These are lenient fully-optional structs replacing the `rec()` guards and casts
 * in src/server/agentBridge.ts:45-65 and the session-create path (~lines 68-110).
 *
 * Designed so `Schema.decodeUnknownOption` on these + the existing tsx-fence
 * regex can reimplement extractCode later — agentBridge.ts is NOT touched here.
 *
 * Verified against agentBridge.ts:
 *   SessionCreated — lines 76-78:
 *     rec(rec(created)?.data) ?? rec(created)  then  createdData.id
 *   PromptResult   — lines 48-65 (extractCode):
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
// extractCode (agentBridge.ts:48-65) walks two nested paths:
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
  // flat fallback — extractCode does `rec(data?.structured_output) ?? rec(data?.structured_output)`
  // but also: `const data = rec(rec(result)?.data) ?? rec(result)`, so result itself
  // may be the data object when there's no wrapper.
  structured_output: Schema.optional(StructuredOutput),
  info: Schema.optional(
    Schema.Struct({
      structured_output: Schema.optional(StructuredOutput),
    }),
  ),
  parts: Schema.optional(Schema.Array(TextPart)),
});
export type PromptResultT = typeof PromptResult.Type;
