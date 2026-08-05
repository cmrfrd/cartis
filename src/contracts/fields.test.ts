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
  ConcreteAspectRatio,
  FieldKind,
  FieldSpecSchema,
  FieldValue,
  summarizeField,
} from './fields';

const decodeValue = Schema.decodeUnknownSync(FieldValue);
const decodeKind = Schema.decodeUnknownSync(FieldKind);
const decodeAspect = Schema.decodeUnknownSync(AspectRatio);
const decodeConcreteAspect = Schema.decodeUnknownSync(ConcreteAspectRatio);
const decodeSpec = Schema.decodeUnknownSync(FieldSpecSchema);

const CONCRETE_ASPECTS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'] as const;

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
  it('accepts auto plus the nano-banana-pro concrete set and rejects arbitrary ratios', () => {
    for (const aspect of CONCRETE_ASPECTS) {
      expect(decodeAspect(aspect)).toBe(aspect);
    }
    expect(decodeAspect('auto')).toBe('auto');
    expect(() => decodeAspect('match_input_image')).toThrow(); // retired flux-era value
    expect(() => decodeAspect('5:7')).toThrow();
    expect(() => decodeAspect('')).toThrow();
  });
});

describe('ConcreteAspectRatio', () => {
  it('accepts every concrete ratio but NOT auto (auto must resolve before replicate)', () => {
    for (const aspect of CONCRETE_ASPECTS) {
      expect(decodeConcreteAspect(aspect)).toBe(aspect);
    }
    expect(() => decodeConcreteAspect('auto')).toThrow();
    expect(() => decodeConcreteAspect('match_input_image')).toThrow();
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
