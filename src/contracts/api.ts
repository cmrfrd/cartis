/**
 * Schema contracts for the bridge HTTP routes.
 *
 * Verified against both ends:
 *   Server:  src/server/agentBridge.ts (route handlers)
 *   Clients: src/storage/StoreClient.ts, src/images/ImageProvider.ts
 */

import { Schema } from 'effect';
import { StoredRecord } from './records.ts';
import { ThemeContext } from './theme.ts';

// ---------------------------------------------------------------------------
// Shared error body
// { error: string }  — sendJson(res, 500, { error: ... }) in agentBridge.ts
// ---------------------------------------------------------------------------

export const ErrorBody = Schema.Struct({
  error: Schema.String,
});
export type ErrorBodyT = typeof ErrorBody.Type;

// ---------------------------------------------------------------------------
// PUT /api/store/:store
//
// StoreClient.ts (put): body { record, bytesBase64: bytes ? … : undefined }
// agentBridge.ts: body.record + optional body.bytesBase64
// ---------------------------------------------------------------------------

export const StorePutRequest = Schema.Struct({
  record: StoredRecord,
  bytesBase64: Schema.optional(Schema.String),
});
export type StorePutRequestT = typeof StorePutRequest.Type;

// ---------------------------------------------------------------------------
// GET /api/status
//
// agentBridge.ts:
//   { image: process.env.REPLICATE_API_TOKEN ? 'replicate' : 'stub' }
// ImageProvider.ts: body.image === 'replicate'
// ---------------------------------------------------------------------------

export const StatusResponse = Schema.Struct({
  image: Schema.Literal('replicate', 'stub'),
});
export type StatusResponseT = typeof StatusResponse.Type;

// ---------------------------------------------------------------------------
// POST /api/agent/fill
//
// Conversational AI form fill (spec §AI pipelines): session-per-episode,
// per-turn currentData snapshot (hand edits win), optional vision attach of
// the current art, targeted patch out.
// ---------------------------------------------------------------------------

const FieldValue = Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Undefined);
const CardDataSchema = Schema.Record({ key: Schema.String, value: FieldValue });

/** FieldSpec-shaped summary the LLM sees (kind + key + label). */
const FieldSummary = Schema.Struct({
  kind: Schema.String,
  key: Schema.String,
  label: Schema.String,
});

export const AgentFillRequest = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  themeContext: ThemeContext,
  fields: Schema.Array(FieldSummary),
  currentData: CardDataSchema,
  currentArtFileName: Schema.optional(Schema.String),
  userPrompt: Schema.String,
});
export type AgentFillRequestT = typeof AgentFillRequest.Type;

export const ArtAction = Schema.Struct({
  brief: Schema.String,
  editCurrentArt: Schema.Boolean,
});
export type ArtActionT = typeof ArtAction.Type;

export const AgentFillResponse = Schema.Struct({
  sessionId: Schema.String,
  patch: CardDataSchema,
  artAction: Schema.optional(ArtAction),
});
export type AgentFillResponseT = typeof AgentFillResponse.Type;

/**
 * Derive a Schema for a targeted patch from field specs: every key optional,
 * each typed per its kind (text/select/image/textarea → string, number →
 * number, toggle → boolean). Unknown keys are dropped. The parameter is
 * deliberately minimal ({ kind, key }) so BOTH a layout's full FieldSpec[]
 * and the fill request's { kind, key, label } summaries feed it directly.
 */
export function schemaFromFields(fields: readonly { kind: string; key: string }[]) {
  const shape: Record<
    string,
    Schema.optional<typeof Schema.String | typeof Schema.Number | typeof Schema.Boolean>
  > = {};
  for (const f of fields) {
    const value =
      f.kind === 'number' ? Schema.Number : f.kind === 'toggle' ? Schema.Boolean : Schema.String;
    shape[f.key] = Schema.optional(value);
  }
  return Schema.Struct(shape);
}

// ---------------------------------------------------------------------------
// POST /api/image/generate
//
// Request:  ImageProvider.ts: { prompt, imageDataUrl, aspectRatio, … }
//           agentBridge.ts: body.prompt, body.imageDataUrl, body.aspectRatio?
//           When themeContext is present the bridge composes the final prompt
//           via the LLM (spec §AI pipelines) before calling replicate; when
//           editCurrentArt + currentArtFileName are set the stored art is the
//           editing source image.
// Response: agentBridge.ts: { dataUrl }
//           ImageProvider.ts: body.dataUrl
// ---------------------------------------------------------------------------

export const ImageGenerateRequest = Schema.Struct({
  prompt: Schema.String,
  imageDataUrl: Schema.String,
  aspectRatio: Schema.optional(Schema.String),
  themeContext: Schema.optional(ThemeContext),
  argumentValues: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  brief: Schema.optional(Schema.String),
  editCurrentArt: Schema.optional(Schema.Boolean),
  currentArtFileName: Schema.optional(Schema.String),
});
export type ImageGenerateRequestT = typeof ImageGenerateRequest.Type;

export const ImageGenerateResponse = Schema.Struct({
  dataUrl: Schema.String,
});
export type ImageGenerateResponseT = typeof ImageGenerateResponse.Type;
