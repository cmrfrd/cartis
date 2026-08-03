/**
 * Bridge thread-event bus: every AI action emits a typed ThreadEvent here,
 * the browser subscribes via SSE (/api/chat/events), and event lines mirror
 * to the dev-server terminal via renderThreadEvent. In-memory only — history
 * dies with the server (clients rehydrate real conversations from opencode).
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

/**
 * Terminal mirror for an event — Some(full `[cartis:*]` line), or None for
 * variants too noisy to log (pending tools, image parts). Strings preserve
 * the old activity-log console format exactly (plan Global Constraints).
 */
export function renderThreadEvent(event: ThreadEventT): Option.Option<string> {
  return Option.fromNullable(renderLine(event));
}

/** Both levels are Match.exhaustive (spec §Match): new event/part variants fail tsc here. */
const renderPartLine = (part: ThreadPartT): string | undefined =>
  Match.value(part).pipe(
    Match.tag('Step', () => '[cartis:agent] step started'),
    Match.tag('Reasoning', () => '[cartis:agent] thinking…'),
    Match.tag('Text', (p) => `[cartis:agent] writing response… (${String(p.text.length)} chars)`),
    Match.tag('ToolCall', (p) => {
      const title = p.title;
      if (p.status === 'running') {
        return `[cartis:agent] tool ${p.name}: running${
          title !== undefined && title.length > 0 ? ` — ${title}` : ''
        }`;
      }
      if (p.status === 'completed') {
        return `[cartis:agent] tool ${p.name}: done — ${title ?? ''} (${(p.secs ?? 0).toFixed(1)}s)`;
      }
      if (p.status === 'error') {
        return `[cartis:agent] tool ${p.name}: FAILED — ${p.result ?? 'unknown'}`;
      }
      return undefined; // pending — too noisy for the terminal
    }),
    Match.tag('Image', () => undefined),
    Match.exhaustive,
  );

const renderLine = (event: ThreadEventT): string | undefined =>
  Match.value(event).pipe(
    Match.tag('TurnStarted', () => '[cartis:agent] turn started'),
    Match.tag('TurnCompleted', (e) => `[cartis:agent] turn ${e.status}`),
    Match.tag('SessionError', (e) => `[cartis:agent] agent error: ${e.message}`),
    Match.tag('PermissionRequested', (e) => `[cartis:agent] permission requested: ${e.title}`),
    // Compose lines were agent-sourced in the old log; pipeline lines image-sourced.
    Match.tag('Art', (e) =>
      e.phase === 'composing'
        ? `[cartis:agent] ${e.detail ?? 'composing art prompt'}`
        : `[cartis:image] ${e.detail ?? e.phase}`,
    ),
    Match.tag('PartDelta', (e) => renderPartLine(e.part)),
    Match.exhaustive,
  );

const capped = <A>(prev: ReadonlyArray<A>, next: A): ReadonlyArray<A> => {
  const out = [...prev, next];
  return out.length > HISTORY_LIMIT ? out.slice(out.length - HISTORY_LIMIT) : out;
};

/** Build the bus internals. `silent` drops the terminal mirror (test layer). */
const makeBus = (silent: boolean) =>
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
          Option.match(renderThreadEvent(event), {
            onNone: () => undefined,
            onSome: (line) => console.log(line),
          });
        }
        yield* PubSub.publish(pubsub, event);
      });

    const log = (scope: LogScope, message: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const line = `[cartis:${scope}] ${message}`;
        yield* Ref.update(logsRef, (prev) => capped(prev, line));
        if (!silent) console.log(line);
      });

    return ThreadBus.of({
      emit,
      log,
      history: Ref.get(historyRef),
      logs: Ref.get(logsRef),
      changes: Stream.fromPubSub(pubsub),
    });
  });

/** Live layer — mirrors to the dev-server terminal. */
export const threadBusLive: Layer.Layer<ThreadBus> = Layer.scoped(ThreadBus, makeBus(false));

/** Test layer — identical bus with the console mirror silenced. */
export const threadBusTestLayer: Layer.Layer<ThreadBus> = Layer.scoped(ThreadBus, makeBus(true));
