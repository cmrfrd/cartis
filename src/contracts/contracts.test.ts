/**
 * Tests for the Task-2 Schema contracts and HttpClient seam.
 *
 * Test file lives under src/ (matches vitest glob src/**\/*.test.{ts,tsx}).
 * Uses it.effect from test/effect.ts for effect-based tests; plain it() for
 * synchronous Schema.decodeUnknownSync tests (avoids useYield lint errors).
 */

import { HttpClient, HttpClientError, HttpClientResponse } from '@effect/platform';
import { Effect, Option, Schema } from 'effect';
import { describe, expect } from 'vitest';
import { AppHttpLive, httpClientFromHandler } from '@/lib/http';
import { it } from '../../test/effect';
import {
  ChatAttachment,
  ChatHistoryResponse,
  ChatTurnRequest,
  ChatTurnResponse,
  ErrorBody,
  ImageGenerateRequest,
  ImageGenerateResponse,
  SessionRef,
  StatusResponse,
  StorePutRequest,
} from './api';
import {
  CardRecord,
  ExportFormat,
  ExportRecord,
  ImageRecord,
  StoredRecord,
  StoreName,
} from './records';
import { Prediction } from './replicate';

// ---------------------------------------------------------------------------
// StoreName
// ---------------------------------------------------------------------------

describe('StoreName', () => {
  it('accepts valid literals', () => {
    expect(Schema.decodeUnknownSync(StoreName)('images')).toBe('images');
    expect(Schema.decodeUnknownSync(StoreName)('cards')).toBe('cards');
    expect(Schema.decodeUnknownSync(StoreName)('exports')).toBe('exports');
  });

  it('rejects unknown store name', () => {
    expect(() => Schema.decodeUnknownSync(StoreName)('foobar')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// StoredRecord
// ---------------------------------------------------------------------------

describe('StoredRecord', () => {
  it('decodes a sidecar-like object', () => {
    const raw = {
      id: 'abc123',
      name: 'Dragon Art',
      type: 'image/png',
      fileName: 'dragon-art-abc123.png',
      createdAt: 1234567890,
    };
    const decoded = Schema.decodeUnknownSync(StoredRecord)(raw);
    expect(decoded.id).toBe('abc123');
    expect(decoded.name).toBe('Dragon Art');
    // extra key survives
    expect((decoded as Record<string, unknown>).createdAt).toBe(1234567890);
  });

  it('unknown extra keys survive decode→encode round-trip', () => {
    const raw = {
      id: 'xyz',
      name: 'My Image',
      kind: 'generated',
      styleId: 'neon',
      customField: 42,
    };
    const decoded = Schema.decodeUnknownSync(StoredRecord)(raw);
    const encoded = Schema.encodeSync(StoredRecord)(decoded);
    expect(encoded.id).toBe('xyz');
    expect((encoded as Record<string, unknown>).customField).toBe(42);
  });

  it('missing id fails', () => {
    expect(() => Schema.decodeUnknownSync(StoredRecord)({ name: 'no id here' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CardRecord
// ---------------------------------------------------------------------------

describe('CardRecord', () => {
  it('decodes a valid card with themeId + layoutId', () => {
    const raw = {
      id: 'card-1',
      name: 'Ember Sprite',
      themeId: 'arcane',
      layoutId: 'classic',
      holo: false,
      updatedAt: 1700000000,
      data: { name: 'Ember Sprite', cost: 3, holo: true, flavor: undefined },
    };
    const decoded = Schema.decodeUnknownSync(CardRecord)(raw);
    expect(decoded.themeId).toBe('arcane');
    expect(decoded.layoutId).toBe('classic');
    expect(decoded.data.cost).toBe(3);
    expect(decoded.data.flavor).toBeUndefined();
    expect(decoded.chatSessionId).toBeUndefined(); // absent-tolerant (pre-chat cards)
  });

  it('carries an optional chatSessionId when present (card chat panel)', () => {
    const decoded = Schema.decodeUnknownSync(CardRecord)({
      id: 'card-3',
      name: 'Chatted',
      themeId: 'arcane',
      layoutId: 'classic',
      holo: false,
      updatedAt: 1700000000,
      data: {},
      chatSessionId: 'ses_abc123',
    });
    expect(decoded.chatSessionId).toBe('ses_abc123');
  });

  it('rejects an old templateId-only row (clean break, decision 2)', () => {
    const legacy = {
      id: 'old-1',
      name: 'Legacy',
      templateId: 'arcane-hero',
      holo: false,
      updatedAt: 1700000000,
      data: {},
    };
    expect(() => Schema.decodeUnknownSync(CardRecord)(legacy)).toThrow();
  });

  it('rejects wrong-typed field (holo must be boolean)', () => {
    const bad = {
      id: 'card-2',
      name: 'Test',
      themeId: 'arcane',
      layoutId: 'classic',
      holo: 'yes', // wrong type
      updatedAt: 1700000000,
      data: {},
    };
    expect(() => Schema.decodeUnknownSync(CardRecord)(bad)).toThrow();
  });

  it('rejects a negative or non-integer updatedAt (refined Timestamp)', () => {
    const base = {
      id: 'card-2',
      name: 'Test',
      themeId: 'arcane',
      layoutId: 'classic',
      holo: false,
      data: {},
    };
    expect(() => Schema.decodeUnknownSync(CardRecord)({ ...base, updatedAt: -5 })).toThrow();
    expect(() => Schema.decodeUnknownSync(CardRecord)({ ...base, updatedAt: 1.5 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ExportRecord
// ---------------------------------------------------------------------------

describe('ExportRecord', () => {
  it('decodes a valid export (with optional fileName)', () => {
    const raw = {
      id: 'exp-1',
      name: 'My Card Export',
      format: 'png',
      type: 'image/png',
      createdAt: 1700000001,
      fileName: 'my-card-export-exp-1ab.png',
    };
    const decoded = Schema.decodeUnknownSync(ExportRecord)(raw);
    expect(decoded.format).toBe('png');
    expect(decoded.fileName).toBe('my-card-export-exp-1ab.png');
  });

  it('decodes with a cardId linking the render to its card', () => {
    const raw = {
      id: 'exp-9',
      name: 'linked.png',
      format: 'png',
      type: 'image/png',
      createdAt: 1700000009,
      cardId: 'card-1',
    };
    const decoded = Schema.decodeUnknownSync(ExportRecord)(raw);
    expect(decoded.cardId).toBe('card-1');
  });

  it('decodes without optional fileName', () => {
    const raw = {
      id: 'exp-2',
      name: 'No File',
      format: 'webp',
      type: 'image/webp',
      createdAt: 1700000002,
    };
    const decoded = Schema.decodeUnknownSync(ExportRecord)(raw);
    expect(decoded.fileName).toBeUndefined();
  });

  it('rejects invalid format', () => {
    const bad = {
      id: 'exp-3',
      name: 'Bad',
      format: 'gif', // not in 'png' | 'jpeg' | 'webp'
      type: 'image/gif',
      createdAt: 1700000003,
    };
    expect(() => Schema.decodeUnknownSync(ExportRecord)(bad)).toThrow();
  });

  it('ExportFormat accepts only png|jpeg|webp', () => {
    expect(Schema.decodeUnknownSync(ExportFormat)('jpeg')).toBe('jpeg');
    expect(() => Schema.decodeUnknownSync(ExportFormat)('bmp')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ImageRecord
// ---------------------------------------------------------------------------

describe('ImageRecord', () => {
  it('decodes a full image record', () => {
    const raw = {
      id: 'img-1',
      name: 'Dragon Portrait',
      kind: 'generated',
      prompt: 'a mythic dragon in ember hues',
      styleId: 'arcane',
      type: 'image/png',
      createdAt: 1700000010,
      fileName: 'dragon-portrait-img-1ab.png',
    };
    const decoded = Schema.decodeUnknownSync(ImageRecord)(raw);
    expect(decoded.kind).toBe('generated');
    expect(decoded.prompt).toBe('a mythic dragon in ember hues');
  });

  it('decodes a source image (optional fields absent)', () => {
    const raw = {
      id: 'img-2',
      name: 'My Photo',
      kind: 'source',
      type: 'image/jpeg',
      createdAt: 1700000020,
    };
    const decoded = Schema.decodeUnknownSync(ImageRecord)(raw);
    expect(decoded.prompt).toBeUndefined();
    expect(decoded.styleId).toBeUndefined();
    expect(decoded.fileName).toBeUndefined();
  });

  it('rejects wrong kind', () => {
    const bad = {
      id: 'img-3',
      name: 'Bad',
      kind: 'upload', // not 'source' | 'generated'
      type: 'image/png',
      createdAt: 1700000030,
    };
    expect(() => Schema.decodeUnknownSync(ImageRecord)(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

describe('Prediction', () => {
  it('decodes a succeeded prediction with string output', () => {
    const raw = {
      id: 'pred-1',
      status: 'succeeded',
      urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' },
      output: 'https://example.com/output.png',
    };
    const decoded = Schema.decodeUnknownSync(Prediction)(raw);
    expect(decoded.status).toBe('succeeded');
    // null | absent | T decodes straight into Option (spec §5)
    expect(Option.getOrUndefined(decoded.output)).toBe('https://example.com/output.png');
  });

  it('decodes a succeeded prediction with array output', () => {
    const raw = {
      id: 'pred-2',
      status: 'succeeded',
      urls: { get: 'https://api.replicate.com/v1/predictions/pred-2' },
      output: ['https://example.com/out1.png', 'https://example.com/out2.png'],
    };
    const decoded = Schema.decodeUnknownSync(Prediction)(raw);
    expect(Array.isArray(Option.getOrUndefined(decoded.output))).toBe(true);
  });

  it('decodes a failed prediction', () => {
    const raw = {
      id: 'pred-3',
      status: 'failed',
      urls: { get: 'https://api.replicate.com/v1/predictions/pred-3' },
      error: 'NSFW content detected',
    };
    const decoded = Schema.decodeUnknownSync(Prediction)(raw);
    expect(decoded.status).toBe('failed');
    expect(Option.getOrUndefined(decoded.error)).toBe('NSFW content detected');
  });

  it('decodes a starting/processing prediction (minimal)', () => {
    const raw = { id: 'pred-4', status: 'starting' };
    const decoded = Schema.decodeUnknownSync(Prediction)(raw);
    expect(decoded.id).toBe('pred-4');
    expect(Option.isNone(decoded.output)).toBe(true);
  });

  it('decodes a realistic fresh prediction with explicit nulls (live API shape)', () => {
    // The real API returns "output": null and "error": null on a fresh create —
    // this exact shape came from a live call and MUST decode successfully.
    const raw = {
      id: 'gm3qorzdhgbfurvjtvhg6dckhu',
      model: 'black-forest-labs/flux-kontext-pro',
      version: 'hidden',
      input: { prompt: 'stylize me' },
      logs: '',
      output: null,
      error: null,
      status: 'starting',
      data_removed: false,
      created_at: '2026-08-01T00:00:00.000Z',
      urls: {
        get: 'https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu',
        cancel: 'https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu/cancel',
      },
    };
    const decoded = Schema.decodeUnknownSync(Prediction)(raw);
    expect(decoded.id).toBe('gm3qorzdhgbfurvjtvhg6dckhu');
    expect(decoded.status).toBe('starting');
    // explicit nulls decode as None — no NullOr juggling downstream (spec §5)
    expect(Option.isNone(decoded.output)).toBe(true);
    expect(Option.isNone(decoded.error)).toBe(true);
    expect(decoded.urls?.get).toContain('/predictions/');
  });
});

// ---------------------------------------------------------------------------
// api.ts schemas
// ---------------------------------------------------------------------------

describe('StorePutRequest', () => {
  it('decodes with optional bytesBase64 absent', () => {
    const raw = { record: { id: 'rec-1', name: 'test' } };
    const decoded = Schema.decodeUnknownSync(StorePutRequest)(raw);
    expect(decoded.record.id).toBe('rec-1');
    expect(decoded.bytesBase64).toBeUndefined();
  });

  it('decodes with bytesBase64 present', () => {
    const raw = { record: { id: 'rec-2' }, bytesBase64: 'SGVsbG8=' };
    const decoded = Schema.decodeUnknownSync(StorePutRequest)(raw);
    expect(decoded.bytesBase64).toBe('SGVsbG8=');
  });

  it('extra unknown keys on the record survive encode round-trip', () => {
    // StoredRecord carries an index signature so hand-edited sidecars with
    // unknown fields are not stripped during encode. This locks that behaviour.
    const raw = { record: { id: 'rec-3', name: 'Ember', customField: 'keep-me', score: 99 } };
    const decoded = Schema.decodeUnknownSync(StorePutRequest)(raw);
    const encoded = Schema.encodeSync(StorePutRequest)(decoded);
    expect((encoded.record as Record<string, unknown>).customField).toBe('keep-me');
    expect((encoded.record as Record<string, unknown>).score).toBe(99);
  });
});

describe('ErrorBody', () => {
  it('decodes { error: string }', () => {
    const decoded = Schema.decodeUnknownSync(ErrorBody)({ error: 'something went wrong' });
    expect(decoded.error).toBe('something went wrong');
  });

  it('rejects missing error field', () => {
    expect(() => Schema.decodeUnknownSync(ErrorBody)({})).toThrow();
  });
});

describe('StatusResponse', () => {
  it('decodes replicate status', () => {
    const decoded = Schema.decodeUnknownSync(StatusResponse)({ image: 'replicate' });
    expect(decoded.image).toBe('replicate');
  });

  it('decodes stub status', () => {
    const decoded = Schema.decodeUnknownSync(StatusResponse)({ image: 'stub' });
    expect(decoded.image).toBe('stub');
  });
});

describe('ChatTurnRequest / Response + history + session refs', () => {
  it('decodes a chat turn request and its structured response', () => {
    const req = Schema.decodeUnknownSync(ChatTurnRequest)({
      sessionId: 'card-1',
      themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
      fields: [{ kind: 'text', key: 'name', label: 'Name' }],
      currentData: { name: 'Nyra' },
      userPrompt: 'rename him',
    });
    expect(req.sessionId).toBe('card-1');
    const res = Schema.decodeUnknownSync(ChatTurnResponse)({
      sessionId: 'card-1',
      reply: 'done',
      toolCalls: [{ name: 'card_patch', args: { name: 'Vorak' } }],
      userEntryId: 'u1',
      assistantEntryId: 'a1',
    });
    expect(res.reply).toBe('done');
    expect(res.toolCalls[0]?.args.name).toBe('Vorak');
    expect(res.userEntryId).toBe('u1');
    expect(res.assistantEntryId).toBe('a1');
  });

  it('decodes a history response of thread messages', () => {
    const hist = Schema.decodeUnknownSync(ChatHistoryResponse)({
      messages: [
        { id: 'u1', role: 'user', status: 'complete', parts: [{ _tag: 'Text', text: 'hi' }] },
        {
          id: 'm1',
          role: 'assistant',
          status: 'complete',
          parts: [{ _tag: 'ToolCall', callId: 'c', name: 'card_patch', status: 'completed' }],
        },
      ],
    });
    expect(hist.messages).toHaveLength(2);
  });

  it('decodes a session ref (fork/abort/revert ack)', () => {
    expect(Schema.decodeUnknownSync(SessionRef)({ sessionId: 'branch-2' }).sessionId).toBe(
      'branch-2',
    );
  });

  it('decodes a chat attachment and rejects an empty mime', () => {
    const att = Schema.decodeUnknownSync(ChatAttachment)({
      name: 'notes.md',
      mime: 'text/markdown',
      dataUrl: 'data:text/markdown;base64,QQ==',
    });
    expect(att.name).toBe('notes.md');
    expect(() =>
      Schema.decodeUnknownSync(ChatAttachment)({
        name: 'notes.md',
        mime: '',
        dataUrl: 'data:text/markdown;base64,QQ==',
      }),
    ).toThrow();
  });

  it('decodes a turn request with attachments (and still without)', () => {
    const base = {
      themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
      fields: [{ kind: 'text', key: 'name', label: 'Name' }],
      currentData: { name: 'Nyra' },
      userPrompt: '',
    };
    const withAtt = Schema.decodeUnknownSync(ChatTurnRequest)({
      ...base,
      attachments: [{ name: 'ref.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
    });
    expect(withAtt.attachments).toHaveLength(1);
    expect(Schema.decodeUnknownSync(ChatTurnRequest)(base).attachments).toBeUndefined();
  });
});

// schemaFromFields constraint tests live in src/contracts/fields.test.ts.

describe('ImageGenerateRequest / ImageGenerateResponse', () => {
  it('decodes request with aspectRatio', () => {
    const decoded = Schema.decodeUnknownSync(ImageGenerateRequest)({
      prompt: 'mythic ember dragon',
      imageDataUrl: 'data:image/png;base64,abc',
      aspectRatio: '3:2',
    });
    expect(decoded.aspectRatio).toBe('3:2');
  });

  it('fills the decode-side aspectRatio default (a decoded request is always complete)', () => {
    const decoded = Schema.decodeUnknownSync(ImageGenerateRequest)({
      prompt: 'mythic ember dragon',
      imageDataUrl: 'data:image/png;base64,abc',
    });
    expect(decoded.aspectRatio).toBe('match_input_image');
  });

  it('rejects an empty imageDataUrl (the old sentinel) and unknown aspects', () => {
    expect(() =>
      Schema.decodeUnknownSync(ImageGenerateRequest)({
        prompt: 'p',
        imageDataUrl: 'data:application/octet-stream;base64,',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ImageGenerateRequest)({ prompt: 'p', aspectRatio: '5:7' }),
    ).toThrow();
    // absent imageDataUrl = text-to-image — decodes fine
    const textFirst = Schema.decodeUnknownSync(ImageGenerateRequest)({ prompt: 'p' });
    expect(textFirst.imageDataUrl).toBeUndefined();
  });

  it('decodes response', () => {
    const decoded = Schema.decodeUnknownSync(ImageGenerateResponse)({
      dataUrl: 'data:image/png;base64,abc',
    });
    expect(decoded.dataUrl).toContain('data:image');
  });
});

// ---------------------------------------------------------------------------
// HttpClient seam (httpClientFromHandler)
// ---------------------------------------------------------------------------

describe('httpClientFromHandler', () => {
  it.effect('serves a canned JSON response and decodes with schemaBodyJson', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get('https://example.com/status');
      const decoded = yield* HttpClientResponse.schemaBodyJson(StatusResponse)(response);
      expect(decoded.image).toBe('replicate');
    }).pipe(
      Effect.provide(
        httpClientFromHandler(
          () =>
            new Response(JSON.stringify({ image: 'replicate' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      ),
    ),
  );

  it.effect('a handler that throws surfaces a typed HttpClientError', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const result = yield* client.get('https://example.com/fail').pipe(Effect.either);
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(HttpClientError.isHttpClientError(result.left)).toBe(true);
        expect(result.left._tag).toBe('RequestError');
      }
    }).pipe(
      Effect.provide(
        httpClientFromHandler(() => {
          throw new Error('network is down');
        }),
      ),
    ),
  );

  it.effect('AppHttpLive is a valid layer for HttpClient (service is present)', () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      expect(typeof client.get).toBe('function');
    }).pipe(Effect.provide(AppHttpLive)),
  );
});
