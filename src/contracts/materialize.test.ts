/**
 * partsFromTurn — the display builder for the pi tool transport (migration
 * spec §3.2). Structured wire data in, thread parts out; no parsing anywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  CARD_GENERATE_ART_TOOL,
  CARD_PATCH_TOOL,
  CARD_SAVE_TOOL,
  CARD_SET_LAYOUT_TOOL,
  partsFromTurn,
} from './materialize';

describe('partsFromTurn', () => {
  it('reply text first, then one completed chip per tool intent, in order', () => {
    const parts = partsFromTurn('Renamed and saved.', [
      { name: CARD_PATCH_TOOL, args: { name: 'Tinker' } },
      { name: CARD_SAVE_TOOL, args: {} },
    ]);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'Renamed and saved.' });
    const patch = parts[1];
    expect(patch?._tag === 'ToolCall' ? patch.name : undefined).toBe(CARD_PATCH_TOOL);
    expect(patch?._tag === 'ToolCall' ? patch.status : undefined).toBe('completed');
    expect(patch?._tag === 'ToolCall' ? patch.argsText : undefined).toBe('{"name":"Tinker"}');
    const save = parts[2];
    expect(save?._tag === 'ToolCall' ? save.name : undefined).toBe(CARD_SAVE_TOOL);
  });

  it('trims the reply and omits an empty text part when tools ran', () => {
    const parts = partsFromTurn('  \n', [{ name: CARD_GENERATE_ART_TOOL, args: { brief: 'x' } }]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?._tag).toBe('ToolCall');
  });

  it('known tools get display titles; unknown tools fall back to their name', () => {
    const parts = partsFromTurn('', [
      { name: CARD_SET_LAYOUT_TOOL, args: { layoutId: 'fullart' } },
      { name: 'mystery_tool', args: {} },
    ]);
    expect(parts[0]?._tag === 'ToolCall' ? parts[0].title : undefined).toBe('Switch layout');
    expect(parts[1]?._tag === 'ToolCall' ? parts[1].title : undefined).toBe('mystery_tool');
  });

  it('a fully empty turn still yields one (empty) text part', () => {
    expect(partsFromTurn('', [])).toEqual([{ _tag: 'Text', text: '' }]);
  });
});
