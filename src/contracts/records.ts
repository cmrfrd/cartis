/**
 * Schema contracts for Cartis' stored records.
 *
 * Shapes mirrored from:
 *   - src/storage/StoreClient.ts       (StoreName, StoredWithFile)
 *   - src/server/fileStore.ts:10-17    (StoreName, StoredRecord)
 *   - src/storage/CardArchive.ts:5-23  (StoredCard, StoredExport, ExportFormat)
 *   - src/storage/ImageLibrary.ts:4-13 (StoredImage)
 *   - src/cards/types.ts:4             (FieldValue)
 */

import { Schema } from 'effect';
import { FieldValue } from './fields.ts';
import { CardId, ExportId, ImageId, LayoutId, SessionId, ThemeId, Timestamp } from './ids.ts';

// ---------------------------------------------------------------------------
// StoreName
// ---------------------------------------------------------------------------

export const StoreName = Schema.Literal('images', 'cards', 'exports');
export type StoreNameT = typeof StoreName.Type;

// ---------------------------------------------------------------------------
// StoredRecord
//
// Typed knowns from StoreRecord/StoredRecord + index signature so unknown keys
// in hand-edited sidecars survive encode/decode round-trips.
// fileStore.ts:StoredRecord omits `fileName`; StoreClient.ts adds it. We model
// the superset (fileName present) since both ends touch the same wire shape.
// ---------------------------------------------------------------------------

export const StoredRecord = Schema.Struct(
  {
    id: Schema.String,
    name: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    fileName: Schema.optional(Schema.String),
  },
  { key: Schema.String, value: Schema.Unknown },
);
export type StoredRecordT = typeof StoredRecord.Type;

// ---------------------------------------------------------------------------
// CardRecord
//
// Mirrored from StoredCard (src/storage/CardArchive.ts). A card names its
// theme + layout; legacy templateId rows deliberately fail decode (clean
// break, spec decision 2) and are dropped by the lenient list.
// CardData = Record<string, FieldValue>; FieldValue = string | number | boolean | undefined
// (src/cards/types.ts:4).
// ---------------------------------------------------------------------------

export const CardRecord = Schema.Struct({
  id: CardId,
  name: Schema.String,
  themeId: ThemeId,
  layoutId: LayoutId,
  holo: Schema.Boolean,
  updatedAt: Timestamp,
  data: Schema.Record({ key: Schema.String, value: FieldValue }),
  /**
   * The pi session backing this card's chat (card chat panel, spec
   * 2026-08-03). Optional + absent-tolerant: pre-chat cards and copies decode
   * fine and simply start a fresh conversation. The transcript lives in
   * gitignored cartis-data/chats; we persist only this pointer.
   */
  chatSessionId: Schema.optional(SessionId),
});
export type CardRecordT = typeof CardRecord.Type;

// ---------------------------------------------------------------------------
// ExportRecord
//
// Mirrored from StoredExport (src/storage/CardArchive.ts:16-23).
// ---------------------------------------------------------------------------

export const ExportFormat = Schema.Literal('png', 'jpeg', 'webp');
export type ExportFormatT = typeof ExportFormat.Type;

export const ExportRecord = Schema.Struct({
  id: ExportId,
  name: Schema.String,
  format: ExportFormat,
  type: Schema.String,
  createdAt: Timestamp,
  fileName: Schema.optional(Schema.String),
  /** The saved card this render was exported from (absent on legacy/back exports). */
  cardId: Schema.optional(CardId),
});
export type ExportRecordT = typeof ExportRecord.Type;

// ---------------------------------------------------------------------------
// ImageRecord
//
// Mirrored from StoredImage (src/storage/ImageLibrary.ts:4-13).
// ---------------------------------------------------------------------------

export const ImageKind = Schema.Literal('source', 'generated');
export type ImageKindT = typeof ImageKind.Type;

export const ImageRecord = Schema.Struct({
  id: ImageId,
  name: Schema.String,
  kind: ImageKind,
  prompt: Schema.optional(Schema.String),
  styleId: Schema.optional(Schema.String),
  type: Schema.String,
  createdAt: Timestamp,
  fileName: Schema.optional(Schema.String),
});
export type ImageRecordT = typeof ImageRecord.Type;
