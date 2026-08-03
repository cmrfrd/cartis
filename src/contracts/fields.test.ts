/**
 * Canonical field/aspect schemas (spec: type-safety & contract hardening,
 * Pillar B). One source of truth for FieldValue/FieldKind/AspectRatio/FieldSpec
 * — the TS types in src/cards/types.ts derive from these.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { AspectRatio, CardDataSchema, FieldKind, FieldSpecSchema, FieldValue } from './fields';

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
