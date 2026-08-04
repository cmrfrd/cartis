/**
 * Schema contracts for the bridge HTTP routes.
 *
 * Verified against both ends:
 *   Server:  src/server/agentBridge.ts (route handlers)
 *   Clients: src/storage/StoreClient.ts, src/images/ImageProvider.ts
 */

import { Schema } from 'effect';
import { AspectRatio, CardDataSchema, FieldSummary } from './fields.ts';
import { DataUrl, FileName, MessageId, MimeType, PermissionId, SessionId } from './ids.ts';
import { StoredRecord } from './records.ts';
import { ThemeContext } from './theme.ts';
import { ThreadMessage, ThreadSummary } from './thread.ts';

// ---------------------------------------------------------------------------
// Shared error body
// { error: string }  — sendJson(res, 500, { error: ... }) in agentBridge.ts
// ---------------------------------------------------------------------------

export const ErrorBody = Schema.Struct({
  error: Schema.String,
  /**
   * The server-side tagged error's `_tag` (spec §13) — a failure crosses the
   * wire as a TYPED error the client can discriminate structurally, not a
   * bare string. Optional for leniency toward older/foreign payloads.
   */
  tag: Schema.optional(Schema.String),
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
// Card chat panel (spec 2026-08-03) — session passthrough over opencode.
// ---------------------------------------------------------------------------

/** Lenient card-data record (patch shape when no field schema is available). */
export const CardData = CardDataSchema;
export type CardDataT = typeof CardData.Type;

export const ArtAction = Schema.Struct({
  brief: Schema.String,
  editCurrentArt: Schema.Boolean,
});
export type ArtActionT = typeof ArtAction.Type;

/**
 * A document-level action the agent may request (chat-doc-actions spec):
 * save / save-as-copy / export the CURRENT card. Executed client-side by the
 * BuilderView appliers, in order, after the patch and any art run.
 */
export const DocAction = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('save') }),
  Schema.Struct({ kind: Schema.Literal('saveAsCopy') }),
  Schema.Struct({
    kind: Schema.Literal('export'),
    /** png = 300 DPI plain, print = 600 DPI + bleed/marks, sheet = 3×3 A4. */
    target: Schema.Literal('png', 'print', 'sheet'),
  }),
);
export type DocActionT = typeof DocAction.Type;

// POST /api/chat/turn — one conversational card-editing turn.
// Request mirrors the fill request (session-per-card, currentData snapshot,
// optional vision attach); the response carries the raw assistant text (fed to
// the SHARED materializer for display) plus the validated patch (applied to the
// card) and an optional art action.
/**
 * One user attachment riding a chat turn (spec 2026-08-03 chat-panel-maturity
 * §1). The data-URL doubles as the composer thumbnail src; on the wire it
 * becomes an opencode FilePartInput whose `filename` marks it as user-supplied
 * (the unnamed card-art context part stays invisible).
 */
export const ChatAttachment = Schema.Struct({
  name: FileName,
  mime: MimeType,
  dataUrl: DataUrl,
});
export type ChatAttachmentT = typeof ChatAttachment.Type;

export const ChatTurnRequest = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  themeContext: ThemeContext,
  fields: Schema.Array(FieldSummary),
  currentData: CardDataSchema,
  currentArtFileName: Schema.optional(Schema.String),
  userPrompt: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ChatTurnRequestT = typeof ChatTurnRequest.Type;

export const ChatTurnResponse = Schema.Struct({
  sessionId: SessionId,
  /** Raw model output — the client runs it through materializeAssistantParts. */
  assistantText: Schema.String,
  /** Field-schema-validated patch, safe to apply to the card. */
  patch: CardDataSchema,
  artAction: Schema.optional(ArtAction),
  /** Document actions (save/copy/export), decoded per-entry leniently. */
  actions: Schema.optional(Schema.Array(DocAction)),
});
export type ChatTurnResponseT = typeof ChatTurnResponse.Type;

// GET /api/chat/history?sessionId=… — rehydrate a card's conversation.
export const ChatHistoryResponse = Schema.Struct({
  messages: Schema.Array(ThreadMessage),
});
export type ChatHistoryResponseT = typeof ChatHistoryResponse.Type;

// GET /api/chat/siblings?sessionId=… — parent-first branch set for ‹ n/m ›.
export const ChatBranchesResponse = Schema.Struct({
  branches: Schema.Array(ThreadSummary),
});
export type ChatBranchesResponseT = typeof ChatBranchesResponse.Type;

// POST /api/chat/fork — branch a session; also the abort/revert/regenerate ack.
export const SessionRef = Schema.Struct({
  sessionId: SessionId,
});
export type SessionRefT = typeof SessionRef.Type;

// POST /api/chat/abort|revert|regenerate — request bodies.
export const SessionAction = Schema.Struct({
  sessionId: SessionId,
  /** revert target; regenerate/abort ignore it. */
  messageId: Schema.optional(MessageId),
});
export type SessionActionT = typeof SessionAction.Type;

// POST /api/chat/permission — reply to a requires-action prompt (Task 5).
export const PermissionReply = Schema.Struct({
  sessionId: SessionId,
  permissionId: PermissionId,
  granted: Schema.Boolean,
});
export type PermissionReplyT = typeof PermissionReply.Type;

// schemaFromFields lives in ./fields.ts (constraint-honoring; spec §6).

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
  /**
   * The source photo as a validated data URL. ABSENT means text-to-image —
   * the old empty-string sentinel is unrepresentable now (the E006
   * empty-input_image bug class is caught at decode).
   */
  imageDataUrl: Schema.optional(DataUrl),
  /** Closed union with a decode-side default — a decoded request is always complete. */
  aspectRatio: Schema.optionalWith(AspectRatio, { default: () => 'match_input_image' as const }),
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
