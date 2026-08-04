/**
 * Branded ids + validated strings (spec: type-safety & contract hardening §1).
 * Nominal brands are compile-time fences (any string constructs); refinement
 * brands carry real runtime validation.
 */

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  CardId,
  type CardIdT,
  DataUrl,
  ExportId,
  FileName,
  ImageId,
  LayoutId,
  MessageId,
  MimeType,
  NonEmptyString,
  SessionId,
  type SessionIdT,
  Slug,
  ThemeId,
  Timestamp,
} from './ids';

describe('nominal id brands', () => {
  it('construct from any string and round-trip decode', () => {
    const brands = [CardId, ExportId, ImageId, ThemeId, LayoutId, SessionId, MessageId];
    for (const brand of brands) {
      const made = brand.make('some-id-123');
      expect(made).toBe('some-id-123'); // brands are strings at runtime
      expect(Schema.decodeUnknownSync(brand)('ses_abc')).toBe('ses_abc');
    }
  });

  it('different brands do not interchange (compile-time fence)', () => {
    const cardId: CardIdT = CardId.make('c1');
    // @ts-expect-error a CardId is not a SessionId
    const wrong: SessionIdT = cardId;
    expect(wrong).toBe('c1'); // runtime unaffected — the fence is the compiler
  });
});

describe('validated string brands', () => {
  it('DataUrl accepts a real base64 data URL and rejects empties/malformed', () => {
    expect(DataUrl.make('data:image/png;base64,QQ==')).toBe('data:image/png;base64,QQ==');
    expect(() => DataUrl.make('')).toThrow();
    expect(() => DataUrl.make('data:;base64,')).toThrow();
    expect(() => DataUrl.make('data:image/png;base64,')).toThrow(); // empty payload
    expect(() => DataUrl.make('https://example.com/x.png')).toThrow();
  });

  it('NonEmptyString and FileName reject the empty string', () => {
    expect(NonEmptyString.make('x')).toBe('x');
    expect(() => NonEmptyString.make('')).toThrow();
    expect(FileName.make('vorak-756b28.png')).toBe('vorak-756b28.png');
    expect(() => FileName.make('')).toThrow();
  });

  it('Slug allows lowercase/digits/hyphens only', () => {
    expect(Slug.make('ember-duelist-4d356a')).toBe('ember-duelist-4d356a');
    expect(Slug.make('')).toBe(''); // slugOf may legitimately produce empty
    expect(() => Slug.make('Not A Slug')).toThrow();
  });

  it('MimeType requires type/subtype', () => {
    expect(MimeType.make('image/png')).toBe('image/png');
    expect(() => MimeType.make('png')).toThrow();
  });
});

describe('Timestamp', () => {
  it('accepts non-negative integers and rejects negatives/floats', () => {
    expect(Timestamp.make(0)).toBe(0);
    expect(Timestamp.make(1700000000000)).toBe(1700000000000);
    expect(() => Timestamp.make(-1)).toThrow();
    expect(() => Timestamp.make(1.5)).toThrow();
    expect(() => Schema.decodeUnknownSync(Timestamp)(-5)).toThrow();
  });
});
