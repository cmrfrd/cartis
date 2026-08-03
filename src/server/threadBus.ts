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

import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect';
import type { ThreadEventT } from '../contracts/thread.ts';

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
 * Terminal mirror for an event — the full `[cartis:*]` line, or undefined for
 * variants too noisy to log (pending tools, image parts). Strings preserve
 * the old activity-log console format exactly (plan Global Constraints).
 */
export function renderThreadEvent(event: ThreadEventT): string | undefined {
  switch (event._tag) {
    case 'TurnStarted':
      return '[cartis:agent] turn started';
    case 'TurnCompleted':
      return `[cartis:agent] turn ${event.status}`;
    case 'SessionError':
      return `[cartis:agent] agent error: ${event.message}`;
    case 'PermissionRequested':
      return `[cartis:agent] permission requested: ${event.title}`;
    case 'Art':
      // Compose lines were agent-sourced in the old log; pipeline lines image-sourced.
      return event.phase === 'composing'
        ? `[cartis:agent] ${event.detail ?? 'composing art prompt'}`
        : `[cartis:image] ${event.detail ?? event.phase}`;
    case 'PartDelta': {
      const part = event.part;
      switch (part._tag) {
        case 'Step':
          return '[cartis:agent] step started';
        case 'Reasoning':
          return '[cartis:agent] thinking…';
        case 'Text':
          return `[cartis:agent] writing response… (${String(part.text.length)} chars)`;
        case 'ToolCall': {
          const title = part.title;
          if (part.status === 'running') {
            return `[cartis:agent] tool ${part.name}: running${
              title !== undefined && title.length > 0 ? ` — ${title}` : ''
            }`;
          }
          if (part.status === 'completed') {
            return `[cartis:agent] tool ${part.name}: done — ${title ?? ''} (${(part.secs ?? 0).toFixed(1)}s)`;
          }
          if (part.status === 'error') {
            return `[cartis:agent] tool ${part.name}: FAILED — ${part.result ?? 'unknown'}`;
          }
          return undefined; // pending — too noisy for the terminal
        }
        case 'Image':
          return undefined;
      }
    }
  }
}

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
          const line = renderThreadEvent(event);
          if (line !== undefined) console.log(line);
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
