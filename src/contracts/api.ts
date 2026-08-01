/**
 * Schema contracts for the 6 bridge HTTP routes.
 *
 * Verified against both ends:
 *   Server:  src/server/agentBridge.ts (route handlers)
 *   Clients: src/storage/storeClient.ts, src/images/replicate.ts,
 *            src/images/provider.ts, src/editor/EditorView.tsx
 */

import { Schema } from 'effect';
import { StoredRecord } from './records';

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
// storeClient.ts:48-52: body JSON.stringify({ record, bytesBase64: bytes ? … : undefined })
// agentBridge.ts:258-264: body.record + optional body.bytesBase64
// ---------------------------------------------------------------------------

export const StorePutRequest = Schema.Struct({
  record: StoredRecord,
  bytesBase64: Schema.optional(Schema.String),
});
export type StorePutRequestT = typeof StorePutRequest.Type;

// ---------------------------------------------------------------------------
// GET /api/status
//
// agentBridge.ts:305-307:
//   { image: process.env.REPLICATE_API_TOKEN ? 'replicate' : 'stub' }
// provider.ts:27: body.image === 'replicate'
// ---------------------------------------------------------------------------

export const StatusResponse = Schema.Struct({
  image: Schema.Literal('replicate', 'stub'),
});
export type StatusResponseT = typeof StatusResponse.Type;

// ---------------------------------------------------------------------------
// POST /api/agent/card
//
// Request:  EditorView.tsx:57: { prompt: this.prompt, code: this.source }
//           agentBridge.ts:317-319: body.prompt, body.code
// Response: agentBridge.ts:323: { code }
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
// Request:  replicate.ts:10-14: { prompt, imageDataUrl, aspectRatio }
//           agentBridge.ts:338-343: body.prompt, body.imageDataUrl, body.aspectRatio?
// Response: agentBridge.ts:344: { dataUrl }
//           replicate.ts:19: body.dataUrl
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
