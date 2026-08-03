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

// ---------------------------------------------------------------------------
// FieldSummary — the wire-shaped slice of a FieldSpec the agent pipelines see.
// Constraints (number range, select options) TRAVEL WITH IT so the bridge —
// which has no theme registry — can enforce them (spec §6).
// ---------------------------------------------------------------------------

export const FieldSummary = Schema.Struct({
  kind: FieldKind,
  key: Schema.String,
  label: Schema.String,
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  options: Schema.optional(Schema.Array(Schema.String)),
});
export type FieldSummaryT = typeof FieldSummary.Type;

/** Build the wire summary from a layout's FieldSpec (constraints included). */
export function summarizeField(spec: FieldSpecT): FieldSummaryT {
  return {
    kind: spec.kind,
    key: spec.key,
    label: spec.label,
    ...(spec.kind === 'number' ? { min: spec.min, max: spec.max } : {}),
    ...(spec.kind === 'select' ? { options: spec.options.map((o) => o.value) } : {}),
  };
}

// ---------------------------------------------------------------------------
// schemaFromFields — derive the agent-patch validator from field summaries.
// Every key optional; each value typed AND constrained per its field:
// numbers are integers within [min, max], selects must be one of the declared
// options (a Schema.filter over String — validation-equivalent to a literal
// union, with friendlier types), toggles booleans, the rest strings.
// Unknown keys are dropped.
// ---------------------------------------------------------------------------

const plainInt = Schema.Number.pipe(Schema.int());

const rangedInt = (min: number, max: number) =>
  Schema.Number.pipe(Schema.int(), Schema.between(min, max));

const oneOf = (options: readonly string[]) =>
  Schema.String.pipe(
    Schema.filter((value: string) => options.includes(value), {
      message: () => `expected one of: ${options.join(', ')}`,
    }),
  );

type PatchValue =
  | typeof Schema.String
  | typeof Schema.Boolean
  | typeof plainInt
  | ReturnType<typeof rangedInt>
  | ReturnType<typeof oneOf>;

function patchValueFor(field: FieldSummaryT): PatchValue {
  if (field.kind === 'number') {
    return field.min !== undefined && field.max !== undefined
      ? rangedInt(field.min, field.max)
      : plainInt;
  }
  if (field.kind === 'toggle') return Schema.Boolean;
  if (field.kind === 'select' && field.options !== undefined && field.options.length > 0) {
    return oneOf(field.options);
  }
  return Schema.String;
}

export function schemaFromFields(fields: readonly FieldSummaryT[]) {
  const shape: Record<string, Schema.optional<PatchValue>> = {};
  for (const field of fields) {
    shape[field.key] = Schema.optional(patchValueFor(field));
  }
  return Schema.Struct(shape);
}
