/**
 * The shared v1-transport materializer (spec §Future-proofing 1).
 *
 * Under the v1 JSON transport, the assistant's opencode-side message TEXT is
 * the raw `{ reply, patch, artAction? }` blob. This one pure function turns
 * that text into display parts, and it is called in BOTH places that surface
 * assistant content:
 *   - the live turn path (client, ThreadState.send) — on the turn's assistantText
 *   - server history mapping (/api/chat/history) — on each stored assistant text
 * so history and live render identically, and raw JSON never reaches the UI.
 *
 * After the P4 MCP inversion this stays on as the fallback parser: old sessions
 * carry JSON-contract turns, new ones carry plain-text replies + real tool
 * parts. A non-conforming/plain-text reply falls through to a single Text part.
 *
 * Imports thread contracts ONLY — never opencode/server shapes.
 */

import { Option, Schema } from 'effect';
import type { ThreadPartT } from './thread';

/** Tool-call ids/names for the v1 card actions, shared with the tool-UI registry. */
export const CARD_PATCH_TOOL = 'card_patch';
export const CARD_GENERATE_ART_TOOL = 'card_generate_art';

const ChatContract = Schema.Struct({
  reply: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  artAction: Schema.optional(
    Schema.Struct({
      brief: Schema.optional(Schema.String),
      editCurrentArt: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeContract = Schema.decodeUnknownOption(ChatContract);

/** First balanced-ish `{ … }` block out of a reply (fences/preamble tolerated). */
function extractJson(raw: string): Option.Option<unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return Option.none();
  try {
    return Option.some(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return Option.none();
  }
}

const toolChip = (id: string, title: string, args: unknown): ThreadPartT => ({
  _tag: 'ToolCall',
  callId: id,
  name: id,
  title,
  status: 'completed',
  argsText: JSON.stringify(args),
});

/** Parse assistant text into ordered display parts (reply text, then action chips). */
export function materializeAssistantParts(text: string): ThreadPartT[] {
  const decoded = extractJson(text).pipe(Option.flatMap(decodeContract));
  if (Option.isNone(decoded)) {
    // No contract parsed — plain-text fallback (P4 replies, non-conforming output).
    return [{ _tag: 'Text', text: text.trim() }];
  }
  const contract = decoded.value;
  const parts: ThreadPartT[] = [];
  const reply = (contract.reply ?? '').trim();
  if (reply.length > 0) parts.push({ _tag: 'Text', text: reply });
  if (contract.patch !== undefined && Object.keys(contract.patch).length > 0) {
    parts.push(toolChip(CARD_PATCH_TOOL, 'Edit card fields', contract.patch));
  }
  if (contract.artAction !== undefined) {
    parts.push(toolChip(CARD_GENERATE_ART_TOOL, 'Generate art', contract.artAction));
  }
  // A parsed-but-empty contract still yields a (blank) message, never nothing.
  if (parts.length === 0) parts.push({ _tag: 'Text', text: '' });
  return parts;
}
