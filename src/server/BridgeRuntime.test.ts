import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import { readBody, respond } from './BridgeRuntime.ts';

/**
 * Build a minimal IncomingMessage stand-in from a PassThrough stream so we can
 * feed chunks synchronously in tests (no real HTTP server needed).
 */
function fakeReq(body: string): IncomingMessage {
  const stream = new PassThrough();
  stream.end(body);
  return stream as unknown as IncomingMessage;
}

/**
 * Minimal ServerResponse stand-in that captures the status code and collects
 * the body written via `end()` so tests can assert on it.
 */
function fakeRes(): { res: ServerResponse; statusCode: () => number; body: () => string } {
  let capturedStatus = 0;
  let capturedBody = '';
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (data: string) => {
      capturedStatus = (res as unknown as { statusCode: number }).statusCode;
      capturedBody = data;
    },
  } as unknown as ServerResponse;
  return {
    res,
    statusCode: () => capturedStatus,
    body: () => capturedBody,
  };
}

describe('respond — defect branch', () => {
  it('renders Error defects as message only (no "Error: " prefix)', () =>
    new Promise<void>((resolve) => {
      // A never-failing Effect that immediately dies with an Error — this is the
      // same path that agentClientLive takes when opencode is not installed.
      const dying = Effect.die(new Error('spawn opencode ENOENT'));
      const runtime = ManagedRuntime.make(Layer.empty);
      const { res, body } = fakeRes();
      respond(runtime, res, dying);
      // respond is fire-and-forget (void); settle after the micro-task queue drains.
      setTimeout(() => {
        const parsed = JSON.parse(body()) as { error: string };
        expect(parsed.error).toBe('spawn opencode ENOENT');
        void runtime.dispose().then(resolve);
      }, 50);
    }));
});

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
