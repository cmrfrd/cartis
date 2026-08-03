/**
 * The client half of the typed-error round-trip (spec Pillar C §13): a bridge
 * failure arrives as ErrorBody { tag, error } and the ChatThread service fails
 * with a typed ChatRequestError CARRYING the server tag as `remoteTag` — the
 * failure is structurally discriminable end-to-end, message unchanged.
 */

import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect';
import { SessionId } from '../contracts/ids';
import { httpClientFromHandler } from '../lib/http';
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
        expect(error.message).toBe('opencode session did not return an id'); // byte parity
      }
    }).pipe(
      Effect.provide(
        failingBridge({ tag: 'AgentError', error: 'opencode session did not return an id' }),
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
