/**
 * Schema contract for the Replicate API prediction payload.
 *
 * Lenient: only the fields generateWithReplicate reads are included.
 * Verified against src/server/agentBridge.ts:130-194.
 *
 * Fields the code reads:
 *   prediction.id        — line 161, 163
 *   prediction.urls.get  — line 159 (poll URL)
 *   prediction.status    — line 165, 170, 171
 *   prediction.output    — line 123-126 (outputUrlOf)
 *   prediction.error     — line 172
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
  // output is string OR array of strings (agentBridge.ts:123-126 outputUrlOf)
  output: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  error: Schema.optional(Schema.String),
});
export type PredictionT = typeof Prediction.Type;
