import { Cause, Context, Effect, FiberId, Layer, Ref, Schema, TestClock } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect';
import {
  AgentError,
  CompileError,
  ExportError,
  MediaError,
  noteFromCause,
  ReplicateError,
  StoreError,
} from './errors';

// A toy service to prove Context.Tag + Layer wiring works end-to-end.
class Greeter extends Context.Tag('cartis/test/Greeter')<
  Greeter,
  { readonly greet: (name: string) => string }
>() {}

const GreeterLive = Layer.succeed(Greeter, {
  greet: (name) => `hello ${name}`,
});

describe('effect toolchain canary', () => {
  it.effect('Schema decodes a struct — success and failure', () =>
    Effect.gen(function* () {
      const Card = Schema.Struct({ name: Schema.String, cost: Schema.Number });
      const decoded = Schema.decodeUnknownSync(Card)({ name: 'Ember Sprite', cost: 3 });
      expect(decoded).toEqual({ name: 'Ember Sprite', cost: 3 });
      expect(() => Schema.decodeUnknownSync(Card)({ name: 'x', cost: 'nope' })).toThrow();
    }),
  );

  it.effect('Layer + Context.Tag: a service is provided and consumed', () =>
    Effect.gen(function* () {
      const greeter = yield* Greeter;
      return greeter.greet('cartis');
    }).pipe(
      Effect.provide(GreeterLive),
      Effect.tap((msg) =>
        Effect.sync(() => {
          expect(msg).toBe('hello cartis');
        }),
      ),
    ),
  );

  it.effect('TestClock makes time deterministic', () =>
    Effect.gen(function* () {
      const done = yield* Ref.make(false);
      yield* Effect.forkScoped(
        Effect.sleep('5 seconds').pipe(Effect.zipRight(Ref.set(done, true))),
      );
      // Nothing has elapsed yet on the (virtual) clock.
      expect(yield* Ref.get(done)).toBe(false);
      yield* TestClock.adjust('5 seconds');
      expect(yield* Ref.get(done)).toBe(true);
    }),
  );

  it.effect('tagged errors: _tag and message strings match today’s source', () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const listErr = new StoreError({ op: 'list', status: 500 });
      expect(listErr._tag).toBe('StoreError');
      expect(listErr.message).toBe('store list failed (500)');

      const putErrDefault = new StoreError({ op: 'put', status: 502 });
      expect(putErrDefault.message).toBe('store put failed (502)');
      const putErrDetail = new StoreError({ op: 'put', status: 400, detail: 'record.id required' });
      expect(putErrDetail.message).toBe('record.id required');

      const noSession = new AgentError({ reason: 'no-session-id' });
      expect(noSession._tag).toBe('AgentError');
      expect(noSession.message).toBe('opencode session did not return an id');
      const noCode = new AgentError({ reason: 'no-code' });
      expect(noCode.message).toBe('agent returned no code');

      const timeout = new ReplicateError({ reason: 'timeout' });
      expect(timeout._tag).toBe('ReplicateError');
      expect(timeout.message).toBe('replicate timed out after 120s');

      // A couple more to lock the templated strings.
      const create = new ReplicateError({ reason: 'create', status: 422, detail: 'bad input' });
      expect(create.message).toBe('replicate error 422: bad input');
      const shape = new CompileError({
        phase: 'shape',
        detail: 'Module needs a component default export (export default function …)',
      });
      expect(shape.message).toBe(
        'Module needs a component default export (export default function …)',
      );
      const exportErr = new ExportError({ detail: 'canvas 2d unavailable' });
      expect(exportErr.message).toBe('canvas 2d unavailable');
      const media = new MediaError({ detail: 'Camera unavailable: denied' });
      expect(media.message).toBe('Camera unavailable: denied');
    }),
  );

  it.effect('noteFromCause: failure / defect / interrupt', () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const failure = Cause.fail(new AgentError({ reason: 'no-code' }));
      expect(noteFromCause(failure)).toBe('agent returned no code');

      const defect = Cause.die(new Error('boom'));
      expect(noteFromCause(defect)).toBe('boom');

      const nonErrorDefect = Cause.die('raw string defect');
      expect(noteFromCause(nonErrorDefect)).toBe('raw string defect');

      const interrupt = Cause.interrupt(FiberId.none);
      expect(noteFromCause(interrupt)).toBe('');
      expect(noteFromCause(Cause.empty)).toBe('');
    }),
  );
});
