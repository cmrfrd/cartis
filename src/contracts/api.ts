/**
 * Schema contracts for the bridge HTTP routes.
 *
 * Verified against both ends:
 *   Server:  src/server/agentBridge.ts (route handlers)
 *   Clients: src/storage/StoreClient.ts, src/images/ImageProvider.ts
 */

import { Schema } from 'effect';
import { AspectRatio, CardDataSchema, FieldSummary } from './fields.ts';
import { DataUrl, FileName, MessageId, MimeType, SessionId } from './ids.ts';
import { StoredRecord } from './records.ts';
import { ThemeContext } from './theme.ts';
import { ThreadMessage } from './thread.ts';

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
// Card chat panel — session passthrough over the in-process pi runtime.
// ---------------------------------------------------------------------------

/** Lenient card-data record (patch shape when no field schema is available). */
export const CardData = CardDataSchema;
export type CardDataT = typeof CardData.Type;

export const ArtAction = Schema.Struct({
  brief: Schema.String,
  editCurrentArt: Schema.Boolean,
});
export type ArtActionT = typeof ArtAction.Type;

/** Current + available document knobs, rendered into the turn prompt. */
export const DocContext = Schema.Struct({
  themeId: Schema.String,
  themeOptions: Schema.Array(Schema.String),
  layoutId: Schema.String,
  layoutOptions: Schema.Array(Schema.String),
  holo: Schema.Boolean,
  /** The card's resolved art aspect + the pickable set (drives the tool schema). */
  artAspect: Schema.String,
  aspectOptions: Schema.Array(Schema.String),
});
export type DocContextT = typeof DocContext.Type;

// POST /api/chat/turn — one conversational card-editing turn.
// Request carries the session-per-card pointer, currentData snapshot, and
// optional vision attach; the response is STRUCTURED (reply + validated tool
// intents + authoritative entry ids — migration spec §3.2).
/**
 * One user attachment riding a chat turn (spec 2026-08-03 chat-panel-maturity
 * §1). The data-URL doubles as the composer thumbnail src; on the wire images
 * become pi image inputs and text files inline into the user content (their
 * names persisted via the turn_meta entry).
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
  docContext: Schema.optional(DocContext),
  /** Downscaled snapshot of the rendered preview — attached UNNAMED (vision). */
  previewDataUrl: Schema.optional(DataUrl),
});
export type ChatTurnRequestT = typeof ChatTurnRequest.Type;

/** One validated tool intent (pi tool transport, migration spec §3.2). */
export const ToolCallIntent = Schema.Struct({
  name: Schema.String,
  args: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type ToolCallIntentT = typeof ToolCallIntent.Type;

export const ChatTurnResponse = Schema.Struct({
  sessionId: SessionId,
  /** Assistant prose — plain text, no transport JSON to parse. */
  reply: Schema.String,
  /** Validated tool intents in canonical (persisted block) order. */
  toolCalls: Schema.Array(ToolCallIntent),
  /** Tool-argument validation failures the model hit (note strip). */
  toolErrors: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, message: Schema.String })),
  ),
  /** Authoritative pi entry ids — the client RE-KEYS its bubbles to these. */
  userEntryId: MessageId,
  assistantEntryId: MessageId,
});
export type ChatTurnResponseT = typeof ChatTurnResponse.Type;

// POST /api/chat/edit — edit an earlier user message (tree sibling branch).
export const ChatEditRequest = Schema.Struct({
  ...ChatTurnRequest.fields,
  targetMessageId: MessageId,
});
export type ChatEditRequestT = typeof ChatEditRequest.Type;

// GET /api/chat/tree?sessionId=… — ‹ n/m › anchors from the session tree.
export const ChatTreeResponse = Schema.Struct({
  anchors: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      index: Schema.Number,
      count: Schema.Number,
      siblingLeafIds: Schema.Array(Schema.String),
    }),
  ),
});
export type ChatTreeResponseT = typeof ChatTreeResponse.Type;

// POST /api/chat/switch — durable branch switch (leaf_switch entry).
export const ChatSwitchRequest = Schema.Struct({
  sessionId: SessionId,
  leafId: Schema.String,
});
export type ChatSwitchRequestT = typeof ChatSwitchRequest.Type;

// GET /api/chat/history?sessionId=… — rehydrate a card's conversation.
export const ChatHistoryResponse = Schema.Struct({
  messages: Schema.Array(ThreadMessage),
});
export type ChatHistoryResponseT = typeof ChatHistoryResponse.Type;

// The switch/abort ack body.
export const SessionRef = Schema.Struct({
  sessionId: SessionId,
});
export type SessionRefT = typeof SessionRef.Type;

// POST /api/chat/abort — request body.
export const SessionAction = Schema.Struct({
  sessionId: SessionId,
});
export type SessionActionT = typeof SessionAction.Type;

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
  aspectRatio: Schema.optionalWith(AspectRatio, { default: () => 'auto' as const }),
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
