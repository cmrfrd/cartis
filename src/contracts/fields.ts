/**
 * Canonical field/aspect schemas — the single source of truth (spec:
 * type-safety & contract hardening, Pillar B).
 *
 * FieldValue/CardData/FieldKind/FieldSpec/AspectRatio each exist ONCE, here,
 * as Schemas; the TS types everywhere else (src/cards/types.ts included)
 * derive via `typeof X.Type`. Closed literal unions replace open strings so an
 * invalid kind or aspect fails decode instead of silently falling through.
 *
 * This module imports nothing from src/cards or src/server — it is pure
 * contract vocabulary, shared by client and server.
 */

import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// FieldValue / CardData
// ---------------------------------------------------------------------------

export const FieldValue = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Undefined,
);
export type FieldValueT = typeof FieldValue.Type;

export const CardDataSchema = Schema.Record({ key: Schema.String, value: FieldValue });
export type CardDataT = typeof CardDataSchema.Type;

// ---------------------------------------------------------------------------
// FieldKind — the closed set of form-field kinds
// ---------------------------------------------------------------------------

export const FieldKind = Schema.Literal('text', 'textarea', 'number', 'select', 'image', 'toggle');
export type FieldKindT = typeof FieldKind.Type;

// ---------------------------------------------------------------------------
// AspectRatio — the closed set replicate/flux accepts (+ match_input_image)
// ---------------------------------------------------------------------------

export const AspectRatio = Schema.Literal(
  '1:1',
  '3:2',
  '2:3',
  '3:4',
  '4:3',
  '16:9',
  '9:16',
  'match_input_image',
);
export type AspectRatioT = typeof AspectRatio.Type;

// ---------------------------------------------------------------------------
// FieldSpec — discriminated on kind; mirrors what layouts declare.
// Validated at theme registration (src/cards/registry.ts), so a malformed
// layout definition is a caught error, not a latent shape bug.
// ---------------------------------------------------------------------------

const FieldCondition = Schema.Struct({
  key: Schema.String,
  equals: FieldValue,
});

const base = {
  key: Schema.String,
  label: Schema.String,
  showIf: Schema.optional(FieldCondition),
};

export const FieldSpecSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('text'),
    ...base,
    placeholder: Schema.optional(Schema.String),
    maxLength: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal('textarea'),
    ...base,
    rows: Schema.optional(Schema.Number),
    placeholder: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('number'),
    ...base,
    min: Schema.Number,
    max: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal('select'),
    ...base,
    options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
  }),
  Schema.Struct({ kind: Schema.Literal('image'), ...base }),
  Schema.Struct({ kind: Schema.Literal('toggle'), ...base }),
);
export type FieldSpecT = typeof FieldSpecSchema.Type;

export const FieldSpecList = Schema.Array(FieldSpecSchema);
