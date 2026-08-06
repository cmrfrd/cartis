/**
 * The client half of the typed-error round-trip (spec Pillar C §13): a bridge
 * failure arrives as ErrorBody { tag, error } and the ChatThread service fails
 * with a typed ChatRequestError CARRYING the server tag as `remoteTag` — the
 * failure is structurally discriminable end-to-end, message unchanged.
 */

import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';
import { MessageId, SessionId } from '@/contracts/ids';
import { httpClientFromHandler } from '@/lib/http';
import { it } from '../../test/effect';
import { ChatThread, chatThreadLive } from './ChatThread';

const failingBridge = (body: unknown, status = 500) =>
  chatThreadLive.pipe(
    Layer.provide(
      httpClientFromHandler(
        () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ),
  );

const turnReq = {
  sessionId: SessionId.make('s1'),
  themeContext: { lookAndFeel: 'oil', palette: '', argumentSummary: '' },
  fields: [],
  currentData: {},
  userPrompt: 'hi',
};

describe('ChatThread typed-error round-trip', () => {
  it.effect('decodes the server tag onto ChatRequestError.remoteTag', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flatMap(ChatThread, (c) => c.turn(turnReq)).pipe(Effect.flip);
      expect(error._tag).toBe('ChatRequestError');
      if (error._tag === 'ChatRequestError') {
        expect(error.remoteTag).toBe('AgentError'); // the typed identity survived
        expect(error.status).toBe(500);
        expect(error.message).toBe('the agent turn failed — try again'); // byte parity
      }
    }).pipe(
      Effect.provide(
        failingBridge({ tag: 'AgentError', error: 'the agent turn failed — try again' }),
      ),
    ),
  );

  it.effect('tolerates a tagless (legacy) error body — remoteTag simply absent', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flatMap(ChatThread, (c) => c.turn(turnReq)).pipe(Effect.flip);
      expect(error._tag).toBe('ChatRequestError');
      if (error._tag === 'ChatRequestError') {
        expect(error.remoteTag).toBeUndefined();
        expect(error.message).toBe('plain message');
      }
    }).pipe(Effect.provide(failingBridge({ error: 'plain message' }))),
  );
});

// ---------------------------------------------------------------------------
// Wire shapes — the live layer's encode side (each route uses its OWN schema)
// ---------------------------------------------------------------------------

const V2_RESPONSE = {
  sessionId: 's1',
  reply: 'ok',
  toolCalls: [{ name: 'card_patch', args: { name: 'X' } }],
  userEntryId: 'ue1',
  assistantEntryId: 'ae1',
};

/** Captures every request body + url; answers every POST with a v2 turn. */
const capturingBridge = (captured: Array<{ url: string; body: unknown }>) =>
  chatThreadLive.pipe(
    Layer.provide(
      httpClientFromHandler(async (request) => {
        const body =
          request.body._tag === 'Uint8Array'
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined;
        captured.push({ url: request.url, body });
        return new Response(JSON.stringify(V2_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    ),
  );

describe('ChatThread wire shapes', () => {
  it.effect('turn() posts the encoded request and decodes the v2 response', () =>
    Effect.gen(function* () {
      const captured: Array<{ url: string; body: unknown }> = [];
      const result = yield* Effect.flatMap(ChatThread, (c) => c.turn(turnReq)).pipe(
        Effect.provide(capturingBridge(captured)),
      );
      expect(captured[0]?.url).toBe('/api/chat/turn');
      expect((captured[0]?.body as { userPrompt?: string } | undefined)?.userPrompt).toBe('hi');
      expect(result.reply).toBe('ok');
      expect(result.toolCalls).toEqual([{ name: 'card_patch', args: { name: 'X' } }]);
      expect(result.userEntryId).toBe('ue1');
    }),
  );

  it.effect('edit() carries targetMessageId on the wire (ChatEditRequest schema)', () =>
    Effect.gen(function* () {
      const captured: Array<{ url: string; body: unknown }> = [];
      yield* Effect.flatMap(ChatThread, (c) => c.edit(turnReq, MessageId.make('target-1'))).pipe(
        Effect.provide(capturingBridge(captured)),
      );
      expect(captured[0]?.url).toBe('/api/chat/edit');
      expect((captured[0]?.body as { targetMessageId?: string } | undefined)?.targetMessageId).toBe(
        'target-1',
      );
    }),
  );

  it.effect('switch() posts {sessionId, leafId}; cancel() posts {sessionId}', () =>
    Effect.gen(function* () {
      const captured: Array<{ url: string; body: unknown }> = [];
      const bridge = chatThreadLive.pipe(
        Layer.provide(
          httpClientFromHandler(async (request) => {
            const body =
              request.body._tag === 'Uint8Array'
                ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
                : undefined;
            captured.push({ url: request.url, body });
            return new Response(JSON.stringify({ sessionId: 's1' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      );
      yield* Effect.flatMap(ChatThread, (c) => c.switch(SessionId.make('s1'), 'leaf-9')).pipe(
        Effect.provide(bridge),
      );
      yield* Effect.flatMap(ChatThread, (c) => c.cancel(SessionId.make('s1'))).pipe(
        Effect.provide(bridge),
      );
      expect(captured[0]).toEqual({
        url: '/api/chat/switch',
        body: { sessionId: 's1', leafId: 'leaf-9' },
      });
      expect(captured[1]).toEqual({ url: '/api/chat/abort', body: { sessionId: 's1' } });
    }),
  );
});
