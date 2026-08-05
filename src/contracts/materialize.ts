/**
 * partsFromTurn — the display builder for the pi tool transport (migration
 * spec §3.2). The wire carries STRUCTURED data ({ reply, toolCalls }); this
 * turns it into thread parts for live turns. History rehydration maps
 * persisted entries server-side (src/server/pi/entries.ts) — chips render
 * identically because both go through the same ThreadPart vocabulary.
 *
 * The old v1 JSON-transport parser (extractJson/repairJson/contract decode)
 * is GONE: the provider validates tool arguments, so no model output is ever
 * parsed as JSON again.
 */

import type { ToolCallIntentT } from './api.ts';
import type { ThreadPartT } from './thread.ts';

/** Tool-call ids/names for the card actions, shared with the tool-UI registry. */
export const CARD_PATCH_TOOL = 'card_patch';
export const CARD_GENERATE_ART_TOOL = 'card_generate_art';
export const CARD_SAVE_TOOL = 'card_save';
export const CARD_SAVE_COPY_TOOL = 'card_save_copy';
export const CARD_EXPORT_TOOL = 'card_export';
export const CARD_SET_LAYOUT_TOOL = 'card_set_layout';
export const CARD_SET_THEME_TOOL = 'card_set_theme';
export const CARD_SET_HOLO_TOOL = 'card_set_holo';

/** Display title for a tool name (chips; falls back to the raw name). */
export const toolTitleOf = (name: string): string => TITLES[name] ?? name;

const TITLES: Record<string, string> = {
  [CARD_PATCH_TOOL]: 'Edit card fields',
  [CARD_GENERATE_ART_TOOL]: 'Generate art',
  [CARD_SAVE_TOOL]: 'Save card',
  [CARD_SAVE_COPY_TOOL]: 'Save as copy',
  [CARD_EXPORT_TOOL]: 'Export render',
  [CARD_SET_LAYOUT_TOOL]: 'Switch layout',
  [CARD_SET_THEME_TOOL]: 'Switch theme',
  [CARD_SET_HOLO_TOOL]: 'Toggle holo',
};

/** Build a turn's display parts: reply text, then one chip per tool intent. */
export function partsFromTurn(reply: string, toolCalls: readonly ToolCallIntentT[]): ThreadPartT[] {
  const parts: ThreadPartT[] = [];
  const text = reply.trim();
  if (text.length > 0) parts.push({ _tag: 'Text', text });
  toolCalls.forEach((call, i) => {
    parts.push({
      _tag: 'ToolCall',
      callId: `intent-${String(i)}`,
      name: call.name,
      title: TITLES[call.name] ?? call.name,
      status: 'completed',
      argsText: JSON.stringify(call.args),
    });
  });
  if (parts.length === 0) parts.push({ _tag: 'Text', text: '' });
  return parts;
}
