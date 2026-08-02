/**
 * Schema contracts for the 6 bridge HTTP routes.
 *
 * Verified against both ends:
 *   Server:  src/server/agentBridge.ts (route handlers)
 *   Clients: src/storage/StoreClient.ts, src/images/ImageProvider.ts,
 *            src/editor/AgentApi.ts
 */

import { Schema } from 'effect';
import { StoredRecord } from './records.ts';

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
// POST /api/agent/card
//
// Request:  AgentApi.ts: { prompt, code }
//           agentBridge.ts: body.prompt, body.code
// Response: agentBridge.ts: { code }
// ---------------------------------------------------------------------------

export const AgentCardRequest = Schema.Struct({
  prompt: Schema.String,
  code: Schema.String,
});
export type AgentCardRequestT = typeof AgentCardRequest.Type;

export const AgentCardResponse = Schema.Struct({
  code: Schema.String,
});
export type AgentCardResponseT = typeof AgentCardResponse.Type;

// ---------------------------------------------------------------------------
// POST /api/image/generate
//
// Request:  ImageProvider.ts: { prompt, imageDataUrl, aspectRatio }
//           agentBridge.ts: body.prompt, body.imageDataUrl, body.aspectRatio?
// Response: agentBridge.ts: { dataUrl }
//           ImageProvider.ts: body.dataUrl
// ---------------------------------------------------------------------------

export const ImageGenerateRequest = Schema.Struct({
  prompt: Schema.String,
  imageDataUrl: Schema.String,
  aspectRatio: Schema.optional(Schema.String),
});
export type ImageGenerateRequestT = typeof ImageGenerateRequest.Type;

export const ImageGenerateResponse = Schema.Struct({
  dataUrl: Schema.String,
});
export type ImageGenerateResponseT = typeof ImageGenerateResponse.Type;
