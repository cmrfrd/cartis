/**
 * Branded ids + validated strings — the nominal-typing home (spec: type-safety
 * & contract hardening §1, maximal branding).
 *
 * Two species:
 *   - NOMINAL id brands: structurally strings, nominally distinct — the
 *     compiler rejects passing a SessionId where a CardId is expected. No
 *     runtime refinement (ids come from crypto.randomUUID(), opencode, or
 *     code-defined theme/layout definitions; transient sentinels like '' stay
 *     constructible).
 *   - REFINED string brands: carry a real runtime validation (DataUrl's
 *     pattern makes "valid non-empty data URL" a type-level fact — the E006
 *     empty-input_image bug class becomes unrepresentable).
 *
 * Minting: `CardId.make(crypto.randomUUID())` at creation sites; wire decode
 * through a schema that uses these brands produces branded values for free.
 * Brands encode as plain strings — the wire format is unchanged.
 */

import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// Nominal id brands
// ---------------------------------------------------------------------------

export const CardId = Schema.String.pipe(Schema.brand('CardId'));
export type CardIdT = typeof CardId.Type;

export const ExportId = Schema.String.pipe(Schema.brand('ExportId'));
export type ExportIdT = typeof ExportId.Type;

export const ImageId = Schema.String.pipe(Schema.brand('ImageId'));
export type ImageIdT = typeof ImageId.Type;

export const ThemeId = Schema.String.pipe(Schema.brand('ThemeId'));
export type ThemeIdT = typeof ThemeId.Type;

export const LayoutId = Schema.String.pipe(Schema.brand('LayoutId'));
export type LayoutIdT = typeof LayoutId.Type;

export const SessionId = Schema.String.pipe(Schema.brand('SessionId'));
export type SessionIdT = typeof SessionId.Type;

export const MessageId = Schema.String.pipe(Schema.brand('MessageId'));
export type MessageIdT = typeof MessageId.Type;

export const PermissionId = Schema.String.pipe(Schema.brand('PermissionId'));
export type PermissionIdT = typeof PermissionId.Type;

// ---------------------------------------------------------------------------
// Refined string brands
// ---------------------------------------------------------------------------

export const NonEmptyString = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand('NonEmptyString'),
);
export type NonEmptyStringT = typeof NonEmptyString.Type;

/** A non-empty base64 data URL — validity is part of the type. */
export const DataUrl = Schema.String.pipe(
  Schema.pattern(/^data:[^;]+;base64,.+$/),
  Schema.brand('DataUrl'),
);
export type DataUrlT = typeof DataUrl.Type;

export const FileName = Schema.String.pipe(Schema.minLength(1), Schema.brand('FileName'));
export type FileNameT = typeof FileName.Type;

/** Lowercase/digit/hyphen slug (may be empty — slugOf of an all-symbol name). */
export const Slug = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]*$/), Schema.brand('Slug'));
export type SlugT = typeof Slug.Type;

export const MimeType = Schema.String.pipe(
  Schema.pattern(/^[\w.+-]+\/[\w.+-]+$/),
  Schema.brand('MimeType'),
);
export type MimeTypeT = typeof MimeType.Type;

// ---------------------------------------------------------------------------
// Timestamp — epoch millis, non-negative integer
// ---------------------------------------------------------------------------

export const Timestamp = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand('Timestamp'),
);
export type TimestampT = typeof Timestamp.Type;
