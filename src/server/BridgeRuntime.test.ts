import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import { readBody } from './BridgeRuntime.ts';

/**
 * Build a minimal IncomingMessage stand-in from a PassThrough stream so we can
 * feed chunks synchronously in tests (no real HTTP server needed).
 */
function fakeReq(body: string): IncomingMessage {
  const stream = new PassThrough();
  stream.end(body);
  return stream as unknown as IncomingMessage;
}

describe('readBody', () => {
  it.effect('parses a valid JSON body', () =>
    Effect.gen(function* () {
      const result = yield* readBody(fakeReq('{"key":"value","n":42}'));
      expect(result).toEqual({ key: 'value', n: 42 });
    }),
  );

  it.effect('returns {} for an empty body', () =>
    Effect.gen(function* () {
      const result = yield* readBody(fakeReq(''));
      expect(result).toEqual({});
    }),
  );

  it.effect('fails with BodyError on malformed JSON', () =>
    Effect.gen(function* () {
      const result = yield* readBody(fakeReq('{not valid json')).pipe(Effect.either);
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('BodyError');
      }
    }),
  );
});
