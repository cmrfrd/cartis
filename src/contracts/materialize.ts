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
import type { ThreadPartT } from './thread.ts';

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

/**
 * Repair the model-JSON failure classes we have actually seen (live-caught
 * 2026-08-03: flavor text with UNESCAPED inner double quotes broke the whole
 * turn). A `"` inside a string is treated as the CLOSING quote only when the
 * next non-whitespace character is a JSON delimiter (`,:}]` or end); any other
 * `"` is escaped in place. Also strips trailing commas. Valid JSON round-trips
 * unchanged through this by construction.
 */
export function repairJson(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '\\') {
      out += ch + (raw[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j] as string)) j++;
      const next = raw[j];
      if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
        out += ch;
        inString = false;
      } else {
        out += '\\"'; // an inner quote the model forgot to escape
      }
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** First balanced-ish `{ … }` block out of a reply (fences/preamble tolerated). */
export function extractJson(raw: string): Option.Option<unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return Option.none();
  const block = raw.slice(start, end + 1);
  try {
    return Option.some(JSON.parse(block));
  } catch {
    try {
      return Option.some(JSON.parse(repairJson(block)));
    } catch {
      return Option.none();
    }
  }
}

/**
 * Does this text LOOK like an attempted v1 contract? Distinguishes "the model
 * tried the JSON transport and mangled it" from genuine plain-text replies.
 */
export function looksLikeContract(raw: string): boolean {
  const trimmed = raw.trim();
  return (trimmed.startsWith('{') || trimmed.includes('```')) && trimmed.includes('"reply"');
}

/** Last-ditch reply extraction off a broken contract (regex over the reply field). */
function replyOf(raw: string): Option.Option<string> {
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  return match?.[1] !== undefined
    ? Option.some(match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'))
    : Option.none();
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
    // A mangled contract must NEVER render as a raw JSON blob: surface the
    // reply text alone (actions were unrecoverable — history of broken turns).
    if (looksLikeContract(text)) {
      const reply = Option.getOrElse(replyOf(text), () => '(reply could not be parsed)');
      return [{ _tag: 'Text', text: reply }];
    }
    // No contract at all — plain-text fallback (P4 replies, non-conforming output).
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
