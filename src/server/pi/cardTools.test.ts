import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import type { FieldSummaryT } from '@/contracts/fields';
import { cardTools, type IntentCollector, personaPrompt } from './cardTools';

const fields: FieldSummaryT[] = [
  { kind: 'text', key: 'name', label: 'Name' },
  { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
  { kind: 'toggle', key: 'showStats', label: 'Stats' },
  { kind: 'select', key: 'rarity', label: 'Rarity', options: ['common', 'rare'] },
];

const doc = {
  themeId: 'arcane',
  themeOptions: ['arcane'],
  layoutId: 'classic',
  layoutOptions: ['classic', 'fullart'],
  holo: false,
  artAspect: 'auto',
  aspectOptions: ['auto', '1:1', '3:4', '16:9'],
};

const collect = (): IntentCollector => ({ calls: [] });

const toolByName = (name: string, c = collect()) => {
  const tool = cardTools(fields, doc, c).find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
};

describe('cardTools schemas (provider-enforced, spec §3.1)', () => {
  it('card_patch enforces field constraints and rejects unknown keys', () => {
    const schema = toolByName('card_patch').parameters;
    expect(Value.Check(schema, { name: 'Tinker' })).toBe(true);
    expect(Value.Check(schema, { cost: 5, rarity: 'rare' })).toBe(true);
    expect(Value.Check(schema, { cost: 999 })).toBe(false); // max 9
    expect(Value.Check(schema, { rarity: 'banana' })).toBe(false); // off-list
    expect(Value.Check(schema, { showStats: 'yes' })).toBe(false); // wrong type
    expect(Value.Check(schema, { hacker: 'x' })).toBe(false); // unknown key
    expect(Value.Check(schema, {})).toBe(true); // empty patch is representable
  });

  it('card_set_layout only accepts ids from docContext (unrepresentable bug class)', () => {
    const schema = toolByName('card_set_layout').parameters;
    expect(Value.Check(schema, { layoutId: 'fullart' })).toBe(true);
    expect(Value.Check(schema, { layoutId: 'nope' })).toBe(false);
  });

  it('card_set_aspect_ratio only accepts ratios from docContext (unrepresentable bug class)', () => {
    const schema = toolByName('card_set_aspect_ratio').parameters;
    expect(Value.Check(schema, { aspectRatio: 'auto' })).toBe(true);
    expect(Value.Check(schema, { aspectRatio: '16:9' })).toBe(true);
    expect(Value.Check(schema, { aspectRatio: '21:9' })).toBe(false); // off-list
    expect(Value.Check(schema, { aspectRatio: 'match_input_image' })).toBe(false); // retired
  });

  it('omits set_layout/set_theme without docContext; card_patch without fields', () => {
    const names = cardTools([], undefined, collect()).map((t) => t.name);
    expect(names).not.toContain('card_patch');
    expect(names).not.toContain('card_set_layout');
    expect(names).not.toContain('card_set_theme');
    expect(names).not.toContain('card_set_aspect_ratio');
    expect(names).toContain('card_generate_art');
    expect(names).toContain('card_save');
  });

  it('every tool is sequential and records validated args in call order', async () => {
    const c = collect();
    const tools = cardTools(fields, doc, c);
    for (const t of tools) expect(t.executionMode).toBe('sequential');
    const patch = tools.find((t) => t.name === 'card_patch');
    const save = tools.find((t) => t.name === 'card_save');
    if (!patch || !save) throw new Error('tools missing');
    const r1 = await patch.execute('c1', { name: 'X' }, undefined, undefined, {} as never);
    await save.execute('c2', {}, undefined, undefined, {} as never);
    expect(c.calls).toEqual([
      { name: 'card_patch', args: { name: 'X' } },
      { name: 'card_save', args: {} },
    ]);
    // never empty content (some providers reject empty tool results)
    expect(r1.content.length).toBeGreaterThan(0);
  });
});

describe('personaPrompt (spec §2.2 — the marker is dead)', () => {
  const req = {
    sessionId: undefined,
    themeContext: { lookAndFeel: 'painterly oil', palette: 'ember', argumentSummary: 'name' },
    fields,
    currentData: { name: 'Nyra', ability: 'Hand-edited.' },
    currentArtFileName: undefined,
    userPrompt: 'rename him',
  };

  it('carries the card context and no scaffold marker', () => {
    const prompt = personaPrompt(req);
    expect(prompt).toContain('painterly oil');
    expect(prompt).toContain('Hand-edited.');
    expect(prompt).toContain('cost (number)');
    expect(prompt).not.toContain('Author request:');
    expect(prompt).not.toContain(req.userPrompt); // user text is NOT in the system prompt
  });
});
