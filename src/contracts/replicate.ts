/**
 * Schema contract for the Replicate API prediction payload.
 *
 * Lenient: only the fields the ReplicateClient reads are included.
 *
 * Fields the code reads (src/server/agentBridge.ts):
 *   prediction.id        — poll target
 *   prediction.urls.get  — poll URL
 *   prediction.status    — loop control
 *   prediction.output    — outputUrlOf
 *   prediction.error     — failed/canceled detail
 *
 * The real API returns EXPLICIT NULLS on fresh predictions ("output": null,
 * "error": null) — observed live, and the SDK types carry `output?: any` /
 * `error?: unknown`. So `output` and `error` accept null as well as absent.
 * `id`, `status`, `urls`, `urls.get` are non-null in the SDK's types; they stay
 * optional-only (leniency for partial payloads, not null-tolerance).
 */

import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// PredictionStatus
//
// Statuses the code branches on (agentBridge.ts:170-171):
//   'succeeded' → break
//   'failed' | 'canceled' → throw
//   'starting' | 'processing' → loop (the code treats anything else as "still running")
// ---------------------------------------------------------------------------

export const PredictionStatus = Schema.Literal(
  'starting',
  'processing',
  'succeeded',
  'failed',
  'canceled',
);
export type PredictionStatusT = typeof PredictionStatus.Type;

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export const Prediction = Schema.Struct({
  id: Schema.optional(Schema.String),
  status: Schema.optional(PredictionStatus),
  urls: Schema.optional(
    Schema.Struct({
      get: Schema.optional(Schema.String),
    }),
  ),
  // output is string OR array of strings (outputUrlOf); the live API sends
  // "output": null before completion. `null | absent | T` decodes STRAIGHT
  // into Option<T> (spec §5) — no manual NullOr juggling downstream.
  output: Schema.optionalWith(Schema.Union(Schema.String, Schema.Array(Schema.String)), {
    as: 'Option',
    nullable: true,
  }),
  // error is a string on failure and explicitly null otherwise.
  error: Schema.optionalWith(Schema.String, { as: 'Option', nullable: true }),
});
export type PredictionT = typeof Prediction.Type;
