/**
 * Bridge thread-event bus: every AI action emits a typed ThreadEvent here,
 * the browser subscribes via SSE (/api/chat/events), and event lines mirror
 * to the dev-server terminal via renderThreadEvent. In-memory only — history
 * dies with the server (clients rehydrate real conversations from pi's session files).
 *
 * Retypes the old ActivityBus (plan Task 1): same sliding PubSub with replay
 * (late SSE subscriber sees recent events) + capped Ref history, but the
 * payload is the canonical ThreadEvent union instead of prose lines. The
 * console-only log() lane preserves turn-level terminal notes (fill prompts,
 * heartbeats) that intentionally have NO event variant.
 */

import { Context, Effect, Layer, Match, Option, PubSub, Ref, Stream } from 'effect';
import type { ThreadEventT, ThreadPartT } from '../contracts/thread.ts';

const HISTORY_LIMIT = 200;
const PUBSUB_CAPACITY = 128;
const PUBSUB_REPLAY = 50;

export type LogScope = 'agent' | 'image' | 'bridge';

/**
 * Where terminal lines go. The vite plugin injects a sink built on vite's own
 * `createLogger` (timestamped, colored — cohesive with vite's output); the
 * default is a plain console.log preserving the classic `[cartis:*]` lines.
 */
export type LogSink = (scope: LogScope, message: string) => void;

const consoleSink: LogSink = (scope, message) => console.log(`[cartis:${scope}] ${message}`);

export class ThreadBus extends Context.Tag('cartis/ThreadBus')<
  ThreadBus,
  {
    emit(event: ThreadEventT): Effect.Effect<void>;
    /** Terminal-only note — recorded in `logs`, never published as an event. */
    log(scope: LogScope, message: string): Effect.Effect<void>;
    readonly history: Effect.Effect<ReadonlyArray<ThreadEventT>>;
    readonly logs: Effect.Effect<ReadonlyArray<string>>;
    readonly changes: Stream.Stream<ThreadEventT>;
  }
>() {}

/** A rendered terminal line, split so sinks can tag the scope themselves. */
interface ScopedLine {
  readonly scope: LogScope;
  readonly message: string;
}

/**
 * Terminal mirror for an event — Some(full `[cartis:*]` line), or None for
 * variants too noisy to log (pending tools, image parts). Strings preserve
 * the old activity-log console format exactly (plan Global Constraints).
 */
export function renderThreadEvent(event: ThreadEventT): Option.Option<string> {
  return Option.map(renderScoped(event), ({ scope, message }) => `[cartis:${scope}] ${message}`);
}

/** Both levels are Match.exhaustive (spec §Match): new event/part variants fail tsc here. */
const renderPartMessage = (part: ThreadPartT): string | undefined =>
  Match.value(part).pipe(
    Match.tag('Step', () => 'step started'),
    Match.tag('Reasoning', () => 'thinking…'),
    Match.tag('Text', (p) => `writing response… (${String(p.text.length)} chars)`),
    Match.tag('ToolCall', (p) => {
      const title = p.title;
      if (p.status === 'running') {
        return `tool ${p.name}: running${
          title !== undefined && title.length > 0 ? ` — ${title}` : ''
        }`;
      }
      if (p.status === 'completed') {
        return `tool ${p.name}: done — ${title ?? ''} (${(p.secs ?? 0).toFixed(1)}s)`;
      }
      if (p.status === 'error') {
        return `tool ${p.name}: FAILED — ${p.result ?? 'unknown'}`;
      }
      return undefined; // pending — too noisy for the terminal
    }),
    Match.tag('Image', () => undefined),
    Match.tag('File', () => undefined),
    Match.exhaustive,
  );

/** The event's terminal line as (scope, message) — what sinks consume. */
function renderScoped(event: ThreadEventT): Option.Option<ScopedLine> {
  return Option.fromNullable(
    Match.value(event).pipe(
      Match.tag('TurnStarted', (): ScopedLine => ({ scope: 'agent', message: 'turn started' })),
      Match.tag(
        'TurnCompleted',
        (e): ScopedLine => ({ scope: 'agent', message: `turn ${e.status}` }),
      ),
      Match.tag(
        'SessionError',
        (e): ScopedLine => ({ scope: 'agent', message: `agent error: ${e.message}` }),
      ),
      // Compose lines were agent-sourced in the old log; pipeline lines image-sourced.
      Match.tag(
        'Art',
        (e): ScopedLine =>
          e.phase === 'composing'
            ? { scope: 'agent', message: e.detail ?? 'composing art prompt' }
            : { scope: 'image', message: e.detail ?? e.phase },
      ),
      Match.tag('PartDelta', (e): ScopedLine | undefined => {
        const message = renderPartMessage(e.part);
        return message === undefined ? undefined : { scope: 'agent', message };
      }),
      Match.exhaustive,
    ),
  );
}

const capped = <A>(prev: ReadonlyArray<A>, next: A): ReadonlyArray<A> => {
  const out = [...prev, next];
  return out.length > HISTORY_LIMIT ? out.slice(out.length - HISTORY_LIMIT) : out;
};

/** Build the bus internals. `silent` drops the terminal mirror (test layer). */
const makeBus = (silent: boolean, sink: LogSink) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.sliding<ThreadEventT>({
      capacity: PUBSUB_CAPACITY,
      replay: PUBSUB_REPLAY,
    });
    const historyRef = yield* Ref.make<ReadonlyArray<ThreadEventT>>([]);
    const logsRef = yield* Ref.make<ReadonlyArray<string>>([]);

    const emit = (event: ThreadEventT): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(historyRef, (prev) => capped(prev, event));
        if (!silent) {
          Option.match(renderScoped(event), {
            onNone: () => undefined,
            onSome: ({ scope, message }) => sink(scope, message),
          });
        }
        yield* PubSub.publish(pubsub, event);
      });

    const log = (scope: LogScope, message: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(logsRef, (prev) => capped(prev, `[cartis:${scope}] ${message}`));
        if (!silent) sink(scope, message);
      });

    return ThreadBus.of({
      emit,
      log,
      history: Ref.get(historyRef),
      logs: Ref.get(logsRef),
      changes: Stream.fromPubSub(pubsub),
    });
  });

/** Live layer — mirrors to the terminal via `sink` (vite logger in the plugin). */
export function threadBusLive(sink: LogSink = consoleSink): Layer.Layer<ThreadBus> {
  return Layer.scoped(ThreadBus, makeBus(false, sink));
}

/** Test layer — identical bus with the terminal mirror silenced. */
export const threadBusTestLayer: Layer.Layer<ThreadBus> = Layer.scoped(
  ThreadBus,
  makeBus(true, consoleSink),
);
