/**
 * The shared v1-transport materializer (spec §Future-proofing 1). One pure
 * function turns an assistant's raw text into display parts; used by BOTH the
 * live turn path (client) and server history mapping, so JSON never reaches
 * the UI and both transports render identically forever.
 */

import { describe, expect, it } from 'vitest';
import {
  CARD_EXPORT_TOOL,
  CARD_GENERATE_ART_TOOL,
  CARD_PATCH_TOOL,
  CARD_SAVE_TOOL,
  materializeAssistantParts,
} from './materialize';
import type { ThreadPartT } from './thread';

const tags = (parts: readonly ThreadPartT[]) => parts.map((p) => p._tag);

describe('materializeAssistantParts', () => {
  it('splits a reply + patch into a text part and a card_patch tool chip', () => {
    const parts = materializeAssistantParts(
      '{"reply": "Renamed him to Vorak.", "patch": {"name": "Vorak"}}',
    );
    expect(tags(parts)).toEqual(['Text', 'ToolCall']);
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'Renamed him to Vorak.' });
    const chip = parts[1];
    expect(chip?._tag === 'ToolCall' ? chip : undefined).toMatchObject({
      callId: CARD_PATCH_TOOL,
      name: CARD_PATCH_TOOL,
      status: 'completed',
      argsText: '{"name":"Vorak"}',
    });
  });

  it('adds a card_generate_art chip when the turn requested art', () => {
    const parts = materializeAssistantParts(
      '{"reply": "Making it fiercer.", "patch": {}, "artAction": {"brief": "angrier", "editCurrentArt": true}}',
    );
    expect(tags(parts)).toEqual(['Text', 'ToolCall']); // empty patch → no card_patch chip
    const chip = parts[1];
    expect(chip?._tag === 'ToolCall' ? chip.name : undefined).toBe(CARD_GENERATE_ART_TOOL);
    expect(chip?._tag === 'ToolCall' ? chip.argsText : undefined).toContain('angrier');
  });

  it('emits patch then art chips in order when both are present', () => {
    const parts = materializeAssistantParts(
      '{"reply": "Done.", "patch": {"name": "X"}, "artAction": {"brief": "b", "editCurrentArt": false}}',
    );
    expect(tags(parts)).toEqual(['Text', 'ToolCall', 'ToolCall']);
    expect(parts.map((p) => (p._tag === 'ToolCall' ? p.name : ''))).toEqual([
      '',
      CARD_PATCH_TOOL,
      CARD_GENERATE_ART_TOOL,
    ]);
  });

  it('tolerates prose around the JSON block (fences / preamble)', () => {
    const parts = materializeAssistantParts(
      'Sure!\n```json\n{"reply": "ok", "patch": {"cost": 3}}\n```',
    );
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'ok' });
    expect(tags(parts)).toEqual(['Text', 'ToolCall']);
  });

  it('falls back to plain text when no JSON contract parses (P4 replies)', () => {
    const parts = materializeAssistantParts('Just a plain sentence, no JSON here.');
    expect(parts).toEqual([{ _tag: 'Text', text: 'Just a plain sentence, no JSON here.' }]);
  });

  it('never renders raw JSON: a contract with no reply drops the text part', () => {
    const parts = materializeAssistantParts('{"patch": {"name": "Q"}}');
    expect(tags(parts)).toEqual(['ToolCall']); // no empty/JSON text part
    const chip = parts[0];
    expect(chip?._tag === 'ToolCall' ? chip.name : undefined).toBe(CARD_PATCH_TOOL);
  });

  it('yields a single empty text part for an empty contract (never a blank crash)', () => {
    expect(materializeAssistantParts('{}')).toEqual([{ _tag: 'Text', text: '' }]);
  });

  it('emits card_save / card_export chips for document actions, after patch/art', () => {
    const parts = materializeAssistantParts(
      '{"reply": "Saved and exported.", "patch": {"name": "X"}, ' +
        '"actions": [{"kind": "save"}, {"kind": "export", "target": "print"}]}',
    );
    expect(parts.map((p) => (p._tag === 'ToolCall' ? p.name : 'text'))).toEqual([
      'text',
      CARD_PATCH_TOOL,
      CARD_SAVE_TOOL,
      CARD_EXPORT_TOOL,
    ]);
    const exportChip = parts[3];
    expect(exportChip?._tag === 'ToolCall' ? exportChip.argsText : '').toContain('print');
  });

  it('drops mistyped action entries but keeps the valid ones', () => {
    const parts = materializeAssistantParts(
      '{"reply": "ok", "actions": [{"kind": "export", "target": "pdf"}, {"kind": "saveAsCopy"}]}',
    );
    const chips = parts.filter((p) => p._tag === 'ToolCall');
    expect(chips.map((c) => (c._tag === 'ToolCall' ? c.name : ''))).toEqual([CARD_SAVE_TOOL]);
  });

  // Live-caught (2026-08-03 goblin-engineer turn): the model wrote flavor text
  // with UNESCAPED inner quotes — invalid JSON — and the raw blob rendered as
  // the reply while the patch silently dropped. The repair pass must recover it.
  it('repairs unescaped inner quotes in string values (the flavor-text class)', () => {
    const parts = materializeAssistantParts(
      '{\n' +
        '  "reply": "Replaced Nyra with a goblin engineer.",\n' +
        '  "patch": {\n' +
        '    "name": "Grubwick Boltsnap",\n' +
        '    "flavor": ""I meant to do that."",\n' +
        '    "cost": 2\n' +
        '  },\n' +
        '  "artAction": { "brief": "ugly goblin engineer", "editCurrentArt": false }\n' +
        '}',
    );
    expect(tags(parts)).toEqual(['Text', 'ToolCall', 'ToolCall']);
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'Replaced Nyra with a goblin engineer.' });
    const chip = parts[1];
    expect(chip?._tag === 'ToolCall' ? chip.argsText : '').toContain('Grubwick Boltsnap');
    expect(chip?._tag === 'ToolCall' ? chip.argsText : '').toContain('I meant to do that.');
  });

  it('repairs trailing commas', () => {
    const parts = materializeAssistantParts('{"reply": "ok", "patch": {"cost": 3,},}');
    expect(tags(parts)).toEqual(['Text', 'ToolCall']);
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'ok' });
  });

  it('a hopelessly broken contract still surfaces the reply text, never the raw blob', () => {
    // Unbalanced braces + garbage — beyond repair, but the reply is extractable.
    const parts = materializeAssistantParts(
      '{"reply": "I tried to update the card.", "patch": {"name": "X", "cost": }',
    );
    expect(parts[0]).toEqual({ _tag: 'Text', text: 'I tried to update the card.' });
    expect(JSON.stringify(parts)).not.toContain('"patch"'); // no raw JSON leaks
  });
});
