/**
 * Canonical field/aspect schemas (spec: type-safety & contract hardening,
 * Pillar B). One source of truth for FieldValue/FieldKind/AspectRatio/FieldSpec
 * — the TS types in src/cards/types.ts derive from these.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  AspectRatio,
  CardDataSchema,
  decodePatchLenient,
  FieldKind,
  FieldSpecSchema,
  type FieldSummaryT,
  FieldValue,
  schemaFromFields,
  summarizeField,
} from './fields';

const decodeValue = Schema.decodeUnknownSync(FieldValue);
const decodeKind = Schema.decodeUnknownSync(FieldKind);
const decodeAspect = Schema.decodeUnknownSync(AspectRatio);
const decodeSpec = Schema.decodeUnknownSync(FieldSpecSchema);

describe('FieldValue', () => {
  it('accepts string, number, boolean, undefined', () => {
    expect(decodeValue('x')).toBe('x');
    expect(decodeValue(3)).toBe(3);
    expect(decodeValue(true)).toBe(true);
    expect(decodeValue(undefined)).toBeUndefined();
  });

  it('rejects null and objects', () => {
    expect(() => decodeValue(null)).toThrow();
    expect(() => decodeValue({})).toThrow();
  });

  it('CardDataSchema decodes a mixed record', () => {
    const data = { name: 'Nyra', cost: 3, holo: true, flavor: undefined };
    expect(Schema.decodeUnknownSync(CardDataSchema)(data)).toEqual(data);
  });
});

describe('decodePatchLenient', () => {
  const fields: FieldSummaryT[] = [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'might', label: 'Might', min: 0, max: 20 },
    { kind: 'toggle', key: 'showStats', label: 'Stats' },
    { kind: 'select', key: 'rarity', label: 'Rarity', options: ['common', 'rare'] },
  ];

  it('keeps valid fields and DROPS invalid ones instead of failing (live-caught)', () => {
    // The reproduced turn-killer: the model "clears" might/ward with null when
    // asked for "no might/ward stuff" — one bad value must not nuke the turn.
    const { patch, dropped } = decodePatchLenient(fields, {
      name: 'Tinker',
      showStats: false,
      might: null,
      rarity: 'banana',
      hacker: 'x',
    });
    expect(patch).toEqual({ name: 'Tinker', showStats: false });
    expect(dropped.sort()).toEqual(['hacker', 'might', 'rarity']);
  });

  it('a fully valid patch passes through with nothing dropped', () => {
    const { patch, dropped } = decodePatchLenient(fields, {
      name: 'X',
      might: 5,
      rarity: 'rare',
    });
    expect(patch).toEqual({ name: 'X', might: 5, rarity: 'rare' });
    expect(dropped).toEqual([]);
  });

  it('non-object input yields an empty patch', () => {
    expect(decodePatchLenient(fields, null)).toEqual({ patch: {}, dropped: [] });
    expect(decodePatchLenient(fields, 'nope')).toEqual({ patch: {}, dropped: [] });
  });
});

describe('FieldKind', () => {
  it('accepts the six kinds and rejects unknown ones', () => {
    for (const kind of ['text', 'textarea', 'number', 'select', 'image', 'toggle']) {
      expect(decodeKind(kind)).toBe(kind);
    }
    expect(() => decodeKind('slider')).toThrow();
  });
});

describe('AspectRatio', () => {
  it('accepts the closed set and rejects arbitrary ratios', () => {
    for (const aspect of ['1:1', '3:2', '2:3', '3:4', '4:3', '16:9', '9:16', 'match_input_image']) {
      expect(decodeAspect(aspect)).toBe(aspect);
    }
    expect(() => decodeAspect('5:7')).toThrow();
    expect(() => decodeAspect('')).toThrow();
  });
});

describe('FieldSpecSchema', () => {
  it('accepts each of the six kinds with their required fields', () => {
    const specs = [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'x', maxLength: 40 },
      { kind: 'textarea', key: 'ability', label: 'Ability', rows: 3 },
      { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
      {
        kind: 'select',
        key: 'essence',
        label: 'Essence',
        options: [{ value: 'ember', label: 'Ember' }],
      },
      { kind: 'image', key: 'art', label: 'Portrait' },
      { kind: 'toggle', key: 'showStats', label: 'Stats', showIf: { key: 'x', equals: true } },
    ];
    for (const spec of specs) {
      expect(decodeSpec(spec)).toEqual(spec);
    }
  });

  it('rejects a number spec without min/max and a select without options', () => {
    expect(() => decodeSpec({ kind: 'number', key: 'cost', label: 'Cost' })).toThrow();
    expect(() => decodeSpec({ kind: 'select', key: 'essence', label: 'Essence' })).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => decodeSpec({ kind: 'slider', key: 'x', label: 'X' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// schemaFromFields — the agent-patch validator MUST honor field constraints
// (spec §6: a chat agent could previously set cost: 999 or an invalid select
// value and it validated and applied).
// ---------------------------------------------------------------------------

describe('schemaFromFields', () => {
  const fields = [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    { kind: 'select', key: 'essence', label: 'Essence', options: ['ember', 'tide'] },
    { kind: 'toggle', key: 'showStats', label: 'Stats' },
  ] as const;
  const decode = Schema.decodeUnknownSync(schemaFromFields(fields));

  it('accepts an in-constraint patch', () => {
    expect(decode({ name: 'Vorak', cost: 5, essence: 'tide', showStats: true })).toEqual({
      name: 'Vorak',
      cost: 5,
      essence: 'tide',
      showStats: true,
    });
  });

  it('rejects an out-of-range number (the cost:999 hole)', () => {
    expect(() => decode({ cost: 999 })).toThrow();
    expect(() => decode({ cost: -1 })).toThrow();
  });

  it('rejects a non-integer number', () => {
    expect(() => decode({ cost: 1.5 })).toThrow();
  });

  it('rejects a select value outside its options', () => {
    expect(() => decode({ essence: 'banana' })).toThrow();
  });

  it('still drops unknown keys and rejects wrong-typed values', () => {
    expect(decode({ name: 'X', hacker: 'y' })).toEqual({ name: 'X' });
    expect(() => decode({ cost: 'expensive' })).toThrow();
    expect(() => decode({ showStats: 'yes' })).toThrow();
  });

  it('a number summary without min/max validates as a plain integer', () => {
    const loose = Schema.decodeUnknownSync(
      schemaFromFields([{ kind: 'number', key: 'n', label: 'N' }]),
    );
    expect(loose({ n: 42 })).toEqual({ n: 42 });
    expect(() => loose({ n: 1.5 })).toThrow();
  });
});

describe('summarizeField', () => {
  it('carries number ranges and select options onto the wire summary', () => {
    expect(summarizeField({ kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 })).toEqual({
      kind: 'number',
      key: 'cost',
      label: 'Cost',
      min: 0,
      max: 9,
    });
    expect(
      summarizeField({
        kind: 'select',
        key: 'essence',
        label: 'Essence',
        options: [
          { value: 'ember', label: 'Ember' },
          { value: 'tide', label: 'Tide' },
        ],
      }),
    ).toEqual({ kind: 'select', key: 'essence', label: 'Essence', options: ['ember', 'tide'] });
    expect(summarizeField({ kind: 'text', key: 'name', label: 'Name' })).toEqual({
      kind: 'text',
      key: 'name',
      label: 'Name',
    });
  });
});
