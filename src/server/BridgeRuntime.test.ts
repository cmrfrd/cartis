import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { describe, expect } from 'vitest';
import { AgentError, BodyError, StoreError, statusOfError } from '@/contracts/errors.ts';
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

describe('respond — typed errors survive the round-trip (spec §13)', () => {
  it('serializes a tagged failure as { tag, error } with the mapped status', () =>
    new Promise<void>((resolve) => {
      const failing = Effect.fail(
        new StoreError({ op: 'list', status: 500, detail: 'disk exploded' }),
      );
      const runtime = ManagedRuntime.make(Layer.empty);
      const { res, statusCode, body } = fakeRes();
      respond(runtime, res, failing);
      setTimeout(() => {
        const parsed = JSON.parse(body()) as { tag: string; error: string };
        expect(parsed.tag).toBe('StoreError'); // the typed identity crosses the wire
        expect(parsed.error).toBe('store list failed (500)'); // message byte-parity
        expect(statusCode()).toBe(500);
        void runtime.dispose().then(resolve);
      }, 50);
    }));

  it('maps malformed-input tags to 400 via statusOfError', () =>
    new Promise<void>((resolve) => {
      const failing = Effect.fail(new BodyError({ cause: new Error('bad json') }));
      const runtime = ManagedRuntime.make(Layer.empty);
      const { res, statusCode, body } = fakeRes();
      respond(runtime, res, failing);
      setTimeout(() => {
        const parsed = JSON.parse(body()) as { tag: string };
        expect(parsed.tag).toBe('BodyError');
        expect(statusCode()).toBe(400); // caller's fault, not a 500
        void runtime.dispose().then(resolve);
      }, 50);
    }));

  it('statusOfError: BodyError/ParseError → 400, busy AgentError → 409, everything else → 500', () => {
    expect(statusOfError('BodyError')).toBe(400);
    expect(statusOfError('ParseError')).toBe(400);
    expect(statusOfError('StoreError')).toBe(500);
    expect(statusOfError('AgentError')).toBe(500);
    expect(statusOfError('AgentError', new AgentError({ reason: 'busy' }))).toBe(409);
    expect(statusOfError('AgentError', new AgentError({ reason: 'turn-failed' }))).toBe(500);
    expect(statusOfError('Defect')).toBe(500);
  });
});

describe('respond — defect branch', () => {
  it('renders Error defects as message only (no "Error: " prefix) with tag Defect', () =>
    new Promise<void>((resolve) => {
      // A never-failing Effect that immediately dies with an Error — the same
      // path an unexpected throw inside a route handler takes.
      const dying = Effect.die(new Error('spawn ENOENT'));
      const runtime = ManagedRuntime.make(Layer.empty);
      const { res, body } = fakeRes();
      respond(runtime, res, dying);
      // respond is fire-and-forget (void); settle after the micro-task queue drains.
      setTimeout(() => {
        const parsed = JSON.parse(body()) as { tag: string; error: string };
        expect(parsed.error).toBe('spawn ENOENT');
        expect(parsed.tag).toBe('Defect');
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
