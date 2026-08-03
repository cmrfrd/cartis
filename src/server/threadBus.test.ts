import { Chunk, Effect, Fiber, Option, Stream } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import { MessageId, PermissionId, SessionId } from '../contracts/ids';
import type { ThreadEventT, ThreadPartT } from '../contracts/thread.ts';
import { renderThreadEvent, ThreadBus, threadBusLive, threadBusTestLayer } from './threadBus.ts';

/** Unwrap the Option for terse assertions. */
const render = (event: ThreadEventT) => Option.getOrUndefined(renderThreadEvent(event));

/**
 * ThreadBus retypes the old ActivityBus over ThreadEventT (plan Task 1): same
 * PubSub replay + capped history semantics, console mirror now derived
 * per-variant via renderThreadEvent, plus a console-only log() lane for
 * turn-level notes that have no event variant.
 */

const art = (detail: string): ThreadEventT => ({ _tag: 'Art', phase: 'progress', detail });

describe('ThreadBus', () => {
  it.effect('records history in emit order and notifies subscribers', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      const seen = yield* Effect.fork(bus.changes.pipe(Stream.take(2), Stream.runCollect));
      yield* Effect.yieldNow();
      yield* bus.emit(art('prediction created'));
      yield* bus.emit({
        _tag: 'TurnStarted',
        sessionId: SessionId.make('s1'),
        messageId: MessageId.make('m1'),
      });

      const history = yield* bus.history;
      expect(history.map((e) => e._tag)).toEqual(['Art', 'TurnStarted']);

      const delivered = yield* Fiber.join(seen);
      expect(Chunk.toReadonlyArray(delivered).map((e) => e._tag)).toEqual(['Art', 'TurnStarted']);
    }).pipe(Effect.provide(threadBusTestLayer)),
  );

  it.effect('caps history at 200 events', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      for (let i = 0; i < 230; i++) yield* bus.emit(art(`event ${i}`));
      const history = yield* bus.history;
      expect(history).toHaveLength(200);
      const first = history[0];
      expect(first?._tag === 'Art' && first.detail).toBe('event 30');
    }).pipe(Effect.provide(threadBusTestLayer)),
  );

  it.effect('a late subscriber sees replayed history (≤50)', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      yield* bus.emit(art('first'));
      yield* bus.emit(art('second'));
      const replayed = yield* bus.changes.pipe(Stream.take(2), Stream.runCollect);
      expect(
        Chunk.toReadonlyArray(replayed).map((e) => (e._tag === 'Art' ? e.detail : '')),
      ).toEqual(['first', 'second']);
    }).pipe(Effect.provide(threadBusTestLayer)),
  );

  it.effect('replays at most the last 50 events to a late subscriber', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      for (let i = 0; i < 60; i++) yield* bus.emit(art(`event ${i}`));
      const replayed = yield* bus.changes.pipe(Stream.take(50), Stream.runCollect);
      const details = Chunk.toReadonlyArray(replayed).map((e) =>
        e._tag === 'Art' ? e.detail : '',
      );
      expect(details).toHaveLength(50);
      expect(details[0]).toBe('event 10');
      expect(details[49]).toBe('event 59');
    }).pipe(Effect.provide(threadBusTestLayer)),
  );

  it.effect('log() records console-only lines without polluting event history', () =>
    Effect.gen(function* () {
      const bus = yield* ThreadBus;
      yield* bus.log('agent', 'fill: “rename him”');
      yield* bus.log('agent', 'still working… (5s)');
      expect(yield* bus.history).toHaveLength(0);
      expect(yield* bus.logs).toEqual([
        '[cartis:agent] fill: “rename him”',
        '[cartis:agent] still working… (5s)',
      ]);
    }).pipe(Effect.provide(threadBusTestLayer)),
  );
});

describe('ThreadBus log sink', () => {
  it.effect('routes emitted lines through the injected sink as (scope, message)', () => {
    const seen: Array<[string, string]> = [];
    return Effect.gen(function* () {
      const bus = yield* ThreadBus;
      yield* bus.emit(art('status: processing (2s)'));
      yield* bus.emit({
        _tag: 'TurnStarted',
        sessionId: SessionId.make('s1'),
        messageId: MessageId.make('m1'),
      });
      yield* bus.log('bridge', 'hello');
      expect(seen).toEqual([
        ['image', 'status: processing (2s)'],
        ['agent', 'turn started'],
        ['bridge', 'hello'],
      ]);
    }).pipe(Effect.provide(threadBusLive((scope, message) => seen.push([scope, message]))));
  });
});

// ---------------------------------------------------------------------------
// renderThreadEvent — terminal mirror preserving the old console strings
// ---------------------------------------------------------------------------

describe('renderThreadEvent', () => {
  const delta = (part: ThreadPartT): ThreadEventT => ({
    _tag: 'PartDelta',
    sessionId: SessionId.make('s1'),
    messageId: MessageId.make('m1'),
    partIndex: 0,
    part,
  });

  it('preserves the old [cartis:agent] action lines', () => {
    expect(render(delta({ _tag: 'Step' }))).toBe('[cartis:agent] step started');
    expect(
      render(
        delta({
          _tag: 'ToolCall',
          callId: 'c1',
          name: 'read',
          title: 'src/main.tsx',
          status: 'running',
        }),
      ),
    ).toBe('[cartis:agent] tool read: running — src/main.tsx');
    expect(
      render(
        delta({
          _tag: 'ToolCall',
          callId: 'c1',
          name: 'read',
          title: 'src/main.tsx',
          status: 'completed',
          secs: 2.1,
        }),
      ),
    ).toBe('[cartis:agent] tool read: done — src/main.tsx (2.1s)');
    expect(
      render(
        delta({
          _tag: 'ToolCall',
          callId: 'c2',
          name: 'bash',
          status: 'error',
          result: 'exit 1',
          isError: true,
        }),
      ),
    ).toBe('[cartis:agent] tool bash: FAILED — exit 1');
    expect(render(delta({ _tag: 'Reasoning', text: 'hmm' }))).toBe('[cartis:agent] thinking…');
    expect(render(delta({ _tag: 'Text', text: 'Hello wor' }))).toBe(
      '[cartis:agent] writing response… (9 chars)',
    );
  });

  it('renders quiet variants as undefined (no console line)', () => {
    expect(
      render(delta({ _tag: 'ToolCall', callId: 'c3', name: 'grep', status: 'pending' })),
    ).toBeUndefined();
    expect(render(delta({ _tag: 'Image', url: 'blob:x' }))).toBeUndefined();
  });

  it('renders turn, art, error, and permission lines', () => {
    expect(
      render({
        _tag: 'TurnStarted',
        sessionId: SessionId.make('s1'),
        messageId: MessageId.make('m1'),
      }),
    ).toBe('[cartis:agent] turn started');
    expect(
      render({
        _tag: 'TurnCompleted',
        sessionId: SessionId.make('s1'),
        messageId: MessageId.make('m1'),
        status: 'complete',
      }),
    ).toBe('[cartis:agent] turn complete');
    expect(
      render({
        _tag: 'Art',
        phase: 'composing',
        detail: 'composing art prompt from theme + arguments',
      }),
    ).toBe('[cartis:agent] composing art prompt from theme + arguments');
    expect(render({ _tag: 'Art', phase: 'progress', detail: 'status: processing (2s)' })).toBe(
      '[cartis:image] status: processing (2s)',
    );
    expect(render({ _tag: 'Art', phase: 'downloaded' })).toBe('[cartis:image] downloaded');
    expect(render({ _tag: 'SessionError', message: 'boom' })).toBe(
      '[cartis:agent] agent error: boom',
    );
    expect(
      render({
        _tag: 'PermissionRequested',
        sessionId: SessionId.make('s1'),
        permissionId: PermissionId.make('p1'),
        title: 'Run bash?',
      }),
    ).toBe('[cartis:agent] permission requested: Run bash?');
  });
});
