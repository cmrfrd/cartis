import type { ServerResponse } from 'node:http';
import { HttpClient, type HttpClientResponse } from '@effect/platform';
import {
  Clock,
  Config,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Runtime,
  Schedule,
  Schema,
  Stream,
} from 'effect';
import type { Plugin } from 'vite';
import {
  ArtAction,
  type ArtActionT,
  CardData,
  type CardDataT,
  ChatTurnRequest,
  type ChatTurnRequestT,
  type ChatTurnResponseT,
  ImageGenerateRequest,
  PermissionReply,
  SessionAction,
  StorePutRequest,
  schemaFromFields,
} from '../contracts/api.ts';
import {
  AgentError,
  type FileStoreError,
  NetworkError,
  ReplicateError,
} from '../contracts/errors.ts';
import { materializeAssistantParts } from '../contracts/materialize.ts';
import {
  AgentEvent,
  PromptResult,
  SessionCreated,
  SessionInfo,
  type SessionInfoT,
  type SessionMessagePartT,
  SessionMessages,
  type SessionMessagesT,
} from '../contracts/opencode.ts';
import { Prediction, type PredictionT } from '../contracts/replicate.ts';
import type { ThemeContextT } from '../contracts/theme.ts';
import {
  type ArtPhaseT,
  ThreadEventJson,
  type ThreadEventT,
  type ThreadMessageT,
  type ThreadPartT,
} from '../contracts/thread.ts';
import { bytesToDataUrl } from '../images/codec.ts';
import { makeBridgeRuntime, readBody, respond, sendJson } from './BridgeRuntime.ts';
import { FileStore, type StoreName } from './fileStore.ts';
import { ThreadBus } from './threadBus.ts';

// ---------- opencode ----------

/** The slice of the opencode SDK client the bridge drives. */
export interface OpencodeClient {
  session: {
    create(input: { body: { title: string } }): Promise<unknown>;
    prompt(input: unknown): Promise<unknown>;
    messages(input: unknown): Promise<unknown>;
    get(input: unknown): Promise<unknown>;
    abort(input: unknown): Promise<unknown>;
    revert(input: unknown): Promise<unknown>;
    fork(input: unknown): Promise<unknown>;
    children(input: unknown): Promise<unknown>;
  };
  /** Top-level on the SDK client: postSessionIdPermissionsPermissionId. */
  permission(input: unknown): Promise<unknown>;
  event: {
    /** Returns a lazy { stream } async iterable — events flow only while drained. */
    subscribe(options: { signal?: AbortSignal }): Promise<unknown>;
  };
}

/** Unwrap the hey-api `{ data, error }` envelope (SDK calls) → the inner value. */
function unwrapData(result: unknown): unknown {
  if (typeof result === 'object' && result !== null && 'data' in result) {
    return (result as { data: unknown }).data;
  }
  return result;
}

/**
 * Env-at-request-time variable read. Empty string counts as absent — parity
 * with today's `process.env.X ?` truthiness checks. Config.option never
 * reports a missing value, but its type still carries ConfigError; a genuinely
 * malformed source is a defect.
 */
function envOption(name: string): Effect.Effect<Option.Option<string>> {
  return Effect.orDie(Config.option(Config.string(name))).pipe(
    Effect.map(Option.filter((value) => value.length > 0)),
  );
}

const decodeSessionOption = Schema.decodeUnknownOption(SessionCreated);
const decodeSessionMessages = Schema.decodeUnknownOption(SessionMessages);
const decodeSessionInfo = Schema.decodeUnknownOption(SessionInfo);
const decodeSessionInfoList = Schema.decodeUnknownOption(Schema.Array(SessionInfo));

// ---------- session thread watcher ----------

const decodeAgentEvent = Schema.decodeUnknownOption(AgentEvent);

interface TextTrack {
  readonly tag: 'Text' | 'Reasoning';
  readonly text: string;
  readonly lastEmitAt: number;
  readonly dirty: boolean;
}

/**
 * Reducer state for the thread watcher: message roles (assistant parts stream,
 * the user's prompt echo is skipped), turn start/completion dedupe, stable
 * part indexes per message, tool-state transition dedupe, and the cumulative
 * text throttle with its unflushed tail.
 */
export interface WatchState {
  readonly roles: ReadonlyMap<string, 'user' | 'assistant'>;
  readonly started: ReadonlySet<string>;
  readonly completed: ReadonlySet<string>;
  readonly partIndexByKey: ReadonlyMap<string, number>;
  readonly partCountByMessage: ReadonlyMap<string, number>;
  readonly toolStatusByCall: ReadonlyMap<string, string>;
  readonly textByKey: ReadonlyMap<string, TextTrack>;
}

export const initialWatchState: WatchState = {
  roles: new Map(),
  started: new Set(),
  completed: new Set(),
  partIndexByKey: new Map(),
  partCountByMessage: new Map(),
  toolStatusByCall: new Map(),
  textByKey: new Map(),
};

const TEXT_DELTA_INTERVAL_MS = 2000;

const mapSet = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  new Map([...map, [key, value]]);
const setAdd = <A>(set: ReadonlySet<A>, value: A): ReadonlySet<A> => new Set([...set, value]);

function sessionErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'unknown';
}

/** Stable part index for `key` within `messageId`, assigning the next slot on first sight. */
function assignIndex(
  state: WatchState,
  messageId: string,
  key: string,
): { index: number; state: WatchState } {
  const fullKey = `${messageId}/${key}`;
  const existing = state.partIndexByKey.get(fullKey);
  if (existing !== undefined) return { index: existing, state };
  const index = state.partCountByMessage.get(messageId) ?? 0;
  return {
    index,
    state: {
      ...state,
      partIndexByKey: mapSet(state.partIndexByKey, fullKey, index),
      partCountByMessage: mapSet(state.partCountByMessage, messageId, index + 1),
    },
  };
}

const partDelta = (
  sessionId: string,
  messageId: string,
  partIndex: number,
  part: ThreadPartT,
): ThreadEventT => ({ _tag: 'PartDelta', sessionId, messageId, partIndex, part });

/** Cumulative text/reasoning delta, throttled to one emission per 2s per part. */
function textDelta(
  state: WatchState,
  sessionId: string,
  messageId: string,
  key: string,
  tag: 'Text' | 'Reasoning',
  text: string,
  now: number,
): { events: readonly ThreadEventT[]; state: WatchState } {
  const assigned = assignIndex(state, messageId, key);
  const fullKey = `${messageId}/${key}`;
  const track = assigned.state.textByKey.get(fullKey);
  if (track !== undefined && now - track.lastEmitAt < TEXT_DELTA_INTERVAL_MS) {
    return {
      events: [],
      state: {
        ...assigned.state,
        textByKey: mapSet(assigned.state.textByKey, fullKey, {
          tag,
          text,
          lastEmitAt: track.lastEmitAt,
          dirty: true,
        }),
      },
    };
  }
  const part: ThreadPartT = tag === 'Text' ? { _tag: 'Text', text } : { _tag: 'Reasoning', text };
  return {
    events: [partDelta(sessionId, messageId, assigned.index, part)],
    state: {
      ...assigned.state,
      textByKey: mapSet(assigned.state.textByKey, fullKey, {
        tag,
        text,
        lastEmitAt: now,
        dirty: false,
      }),
    },
  };
}

/** Unthrottled final deltas for every dirty text part of `messageId` (spec: final flush). */
function flushDirtyText(
  state: WatchState,
  sessionId: string,
  messageId: string,
): { events: readonly ThreadEventT[]; state: WatchState } {
  const events: ThreadEventT[] = [];
  let textByKey = state.textByKey;
  const prefix = `${messageId}/`;
  for (const [fullKey, track] of state.textByKey) {
    if (!fullKey.startsWith(prefix) || !track.dirty) continue;
    const index = state.partIndexByKey.get(fullKey);
    if (index === undefined) continue;
    const part: ThreadPartT =
      track.tag === 'Text'
        ? { _tag: 'Text', text: track.text }
        : { _tag: 'Reasoning', text: track.text };
    events.push(partDelta(sessionId, messageId, index, part));
    textByKey = mapSet(textByKey, fullKey, { ...track, dirty: false });
  }
  return { events, state: { ...state, textByKey } };
}

const TOOL_STATUSES = ['pending', 'running', 'completed', 'error'] as const;
type ToolStatus = (typeof TOOL_STATUSES)[number];
const toolStatusOf = (raw: string | undefined): ToolStatus =>
  TOOL_STATUSES.find((s) => s === raw) ?? 'pending';

/**
 * Pure per-event reducer: raw opencode events → typed ThreadEvents for the
 * watched session. TurnStarted/TurnCompleted derive from `message.updated`
 * (real message ids end to end); assistant parts become PartDeltas at stable
 * indexes; the user's prompt echo is skipped; unknown event/part kinds map to
 * NO event — dropped, never a decode crash (spec: tolerant boundaries).
 */
export function mapAgentEvent(
  raw: unknown,
  sessionId: string,
  state: WatchState,
  now: number,
): { events: readonly ThreadEventT[]; state: WatchState } {
  const decoded = decodeAgentEvent(raw);
  if (Option.isNone(decoded)) return { events: [], state };
  const event = decoded.value;

  if (event.type === 'session.error') {
    return {
      events: [{ _tag: 'SessionError', message: sessionErrorMessage(event.properties?.error) }],
      state,
    };
  }

  if (event.type === 'permission.updated') {
    const props = event.properties;
    if (props?.sessionID !== sessionId) return { events: [], state };
    return {
      events: [
        {
          _tag: 'PermissionRequested',
          sessionId,
          permissionId: props.id ?? '',
          title: props.title ?? 'permission requested',
        },
      ],
      state,
    };
  }

  if (event.type === 'message.updated') {
    const info = event.properties?.info;
    if (!info || info.sessionID !== sessionId) return { events: [], state };
    const id = info.id ?? '';
    const role =
      info.role === 'assistant' ? 'assistant' : info.role === 'user' ? 'user' : undefined;
    if (id.length === 0 || role === undefined) return { events: [], state };
    let next: WatchState =
      state.roles.get(id) === role ? state : { ...state, roles: mapSet(state.roles, id, role) };
    if (role !== 'assistant') return { events: [], state: next };
    const events: ThreadEventT[] = [];
    if (!next.started.has(id)) {
      events.push({ _tag: 'TurnStarted', sessionId, messageId: id });
      next = { ...next, started: setAdd(next.started, id) };
    }
    if (info.time?.completed !== undefined && !next.completed.has(id)) {
      const flushed = flushDirtyText(next, sessionId, id);
      events.push(...flushed.events);
      events.push({ _tag: 'TurnCompleted', sessionId, messageId: id, status: 'complete' });
      next = { ...flushed.state, completed: setAdd(flushed.state.completed, id) };
    }
    return { events, state: next };
  }

  if (event.type !== 'message.part.updated') return { events: [], state };
  const part = event.properties?.part;
  if (!part || part.sessionID !== sessionId) return { events: [], state };
  const messageId = part.messageID ?? '';
  if (messageId.length === 0 || state.roles.get(messageId) !== 'assistant') {
    return { events: [], state };
  }

  switch (part.type) {
    case 'step-start': {
      const assigned = assignIndex(state, messageId, part.id ?? 'step');
      return {
        events: [partDelta(sessionId, messageId, assigned.index, { _tag: 'Step' })],
        state: assigned.state,
      };
    }
    case 'tool': {
      const callId = part.callID ?? part.id ?? 'tool';
      const status = toolStatusOf(part.state?.status);
      if (state.toolStatusByCall.get(callId) === status) return { events: [], state };
      const assigned = assignIndex(state, messageId, part.id ?? callId);
      const st = part.state;
      const secs =
        status === 'completed'
          ? ((st?.time?.end ?? now) - (st?.time?.start ?? now)) / 1000
          : undefined;
      const result = status === 'error' ? (st?.error ?? 'unknown') : st?.output;
      const toolPart: ThreadPartT = {
        _tag: 'ToolCall',
        callId,
        name: part.tool ?? 'tool',
        ...(st?.title !== undefined ? { title: st.title } : {}),
        status,
        ...(st?.input !== undefined ? { argsText: JSON.stringify(st.input) } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(status === 'error' ? { isError: true } : {}),
        ...(secs !== undefined ? { secs } : {}),
      };
      return {
        events: [partDelta(sessionId, messageId, assigned.index, toolPart)],
        state: {
          ...assigned.state,
          toolStatusByCall: mapSet(assigned.state.toolStatusByCall, callId, status),
        },
      };
    }
    case 'reasoning':
      return textDelta(
        state,
        sessionId,
        messageId,
        part.id ?? 'reasoning',
        'Reasoning',
        part.text ?? '',
        now,
      );
    case 'text':
      return textDelta(
        state,
        sessionId,
        messageId,
        part.id ?? 'text',
        'Text',
        part.text ?? '',
        now,
      );
    default:
      return { events: [], state };
  }
}

export class AgentClient extends Context.Tag('cartis/AgentClient')<
  AgentClient,
  {
    createSession(title: string): Effect.Effect<string, AgentError>;
    /** `image` attaches a vision part (SDK FilePartInput with a data-URL). */
    prompt(
      sessionId: string,
      text: string,
      image?: { mime: string; dataUrl: string },
    ): Effect.Effect<unknown, AgentError>;
    /**
     * Run `effect` with the session's activity watcher forked in scope (live:
     * SDK event stream → ThreadBus events; stubs: identity).
     */
    withActivity<A, E>(sessionId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E>;
    /** Decoded message list for a session (history rehydration + regenerate). */
    messages(sessionId: string): Effect.Effect<SessionMessagesT, AgentError>;
    /** Session envelope — carries the revert marker + parent/title. */
    info(sessionId: string): Effect.Effect<SessionInfoT, AgentError>;
    /** Interrupt the running turn (cancel). */
    abort(sessionId: string): Effect.Effect<void, AgentError>;
    /** Revert the session to (and undoing) `messageId` — edit/regenerate basis. */
    revert(sessionId: string, messageId: string): Effect.Effect<void, AgentError>;
    /** Branch the session; resolves the new session's id. */
    fork(sessionId: string): Effect.Effect<string, AgentError>;
    /** Child (branch) sessions of `sessionId`. */
    children(sessionId: string): Effect.Effect<readonly SessionInfoT[], AgentError>;
    /** Reply to a pending permission request (Task 5 prompts). */
    replyPermission(
      sessionId: string,
      permissionId: string,
      granted: boolean,
    ): Effect.Effect<void, AgentError>;
  }
>() {}

/** Live wiring the watcher needs: the bus to emit on + a runtime for the SSE callback. */
export interface AgentActivityWiring {
  readonly bus: Context.Tag.Service<ThreadBus>;
  readonly runtime: Runtime.Runtime<never>;
}

/** Structurally narrow the SDK's subscribe result to its async event stream. */
function eventStreamOf(result: unknown): AsyncIterable<unknown> | undefined {
  if (typeof result !== 'object' || result === null || !('stream' in result)) return undefined;
  const stream = (result as { stream: unknown }).stream;
  if (typeof stream !== 'object' || stream === null || !(Symbol.asyncIterator in stream)) {
    return undefined;
  }
  return stream as AsyncIterable<unknown>;
}

/** Build an AgentClient over a raw opencode SDK client. */
export function agentClientFromSdk(
  client: OpencodeClient,
  activity?: AgentActivityWiring,
): Context.Tag.Service<AgentClient> {
  const withActivity = <A, E>(
    sessionId: string,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => {
    if (!activity) return effect;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const controller = new AbortController();
            const state = { current: initialWatchState };
            // Best-effort: a failed subscription must never break the prompt.
            // The SDK's SSE result is a LAZY async generator — events only
            // flow while the stream is drained, so we pump it here.
            void (async () => {
              const result = await client.event.subscribe({ signal: controller.signal });
              const stream = eventStreamOf(result);
              if (!stream) return;
              for await (const data of stream) {
                const out = mapAgentEvent(data, sessionId, state.current, Date.now());
                state.current = out.state;
                for (const event of out.events) {
                  Runtime.runSync(activity.runtime)(activity.bus.emit(event));
                }
              }
            })().catch(() => undefined);
            return controller;
          }),
          (controller) => Effect.sync(() => controller.abort()),
        );
        return yield* effect;
      }),
    );
  };
  return {
    withActivity,
    createSession: (title) =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() => client.session.create({ body: { title } }));
        const decoded = decodeSessionOption(created);
        const id = Option.isSome(decoded)
          ? (decoded.value.data?.id ?? decoded.value.id)
          : undefined;
        if (typeof id !== 'string' || id.length === 0) {
          return yield* Effect.fail(new AgentError({ reason: 'no-session-id' }));
        }
        return id;
      }),
    prompt: (sessionId, text, image) =>
      Effect.promise(() =>
        client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: image
              ? [
                  { type: 'text', text },
                  { type: 'file', mime: image.mime, url: image.dataUrl },
                ]
              : [{ type: 'text', text }],
          },
        }),
      ),
    messages: (sessionId) =>
      Effect.promise(() => client.session.messages({ path: { id: sessionId } })).pipe(
        Effect.map(unwrapData),
        Effect.flatMap((raw) =>
          Option.match(decodeSessionMessages(raw), {
            onNone: () => Effect.succeed([] as SessionMessagesT),
            onSome: (msgs) => Effect.succeed(msgs),
          }),
        ),
      ),
    info: (sessionId) =>
      Effect.promise(() => client.session.get({ path: { id: sessionId } })).pipe(
        Effect.map(unwrapData),
        Effect.flatMap((raw) =>
          Option.match(decodeSessionInfo(raw), {
            onNone: () => Effect.fail(new AgentError({ reason: 'no-session-id' })),
            onSome: (info) => Effect.succeed(info),
          }),
        ),
      ),
    abort: (sessionId) =>
      Effect.promise(() => client.session.abort({ path: { id: sessionId } })).pipe(Effect.asVoid),
    revert: (sessionId, messageId) =>
      Effect.promise(() =>
        client.session.revert({ path: { id: sessionId }, body: { messageID: messageId } }),
      ).pipe(Effect.asVoid),
    fork: (sessionId) =>
      Effect.promise(() => client.session.fork({ path: { id: sessionId } })).pipe(
        Effect.map(unwrapData),
        Effect.flatMap((raw) => {
          const decoded = decodeSessionInfo(raw);
          const id = Option.isSome(decoded) ? decoded.value.id : undefined;
          return typeof id === 'string' && id.length > 0
            ? Effect.succeed(id)
            : Effect.fail(new AgentError({ reason: 'no-session-id' }));
        }),
      ),
    children: (sessionId) =>
      Effect.promise(() => client.session.children({ path: { id: sessionId } })).pipe(
        Effect.map(unwrapData),
        Effect.map((raw) =>
          Option.getOrElse(decodeSessionInfoList(raw), () => [] as SessionInfoT[]),
        ),
      ),
    replyPermission: (sessionId, permissionId, granted) =>
      Effect.promise(() =>
        client.permission({
          path: { id: sessionId, permissionID: permissionId },
          body: { response: granted ? 'once' : 'reject' },
        }),
      ).pipe(Effect.asVoid),
  };
}

/**
 * Live layer: lazy dynamic import of the opencode SDK on first use, cached so
 * `bun run dev` startup stays fast when the agent is never invoked.
 * `OPENCODE_MODEL` via Config.option.
 */
export const agentClientLive: Layer.Layer<AgentClient, never, ThreadBus> = Layer.effect(
  AgentClient,
  Effect.gen(function* () {
    const bus = yield* ThreadBus;
    const runtime = yield* Effect.runtime<never>();
    const wiring: AgentActivityWiring = { bus, runtime };
    const model = yield* envOption('OPENCODE_MODEL');
    const acquire = Effect.promise(async () => {
      const sdk = await import('@opencode-ai/sdk');
      const { client } = await sdk.createOpencode(
        Option.isSome(model) ? { config: { model: model.value } } : {},
      );
      return client as unknown as OpencodeClient;
    });
    const cached = yield* Effect.cached(acquire);
    // Delegate to a per-call client resolved from the cached SDK handle.
    const svc = (client: OpencodeClient) => agentClientFromSdk(client, wiring);
    return AgentClient.of({
      createSession: (title) =>
        cached.pipe(Effect.flatMap((client) => svc(client).createSession(title))),
      prompt: (sessionId, text, image) =>
        cached.pipe(Effect.flatMap((client) => svc(client).prompt(sessionId, text, image))),
      withActivity: (sessionId, effect) =>
        cached.pipe(Effect.flatMap((client) => svc(client).withActivity(sessionId, effect))),
      messages: (sessionId) =>
        cached.pipe(Effect.flatMap((client) => svc(client).messages(sessionId))),
      info: (sessionId) => cached.pipe(Effect.flatMap((client) => svc(client).info(sessionId))),
      abort: (sessionId) => cached.pipe(Effect.flatMap((client) => svc(client).abort(sessionId))),
      revert: (sessionId, messageId) =>
        cached.pipe(Effect.flatMap((client) => svc(client).revert(sessionId, messageId))),
      fork: (sessionId) => cached.pipe(Effect.flatMap((client) => svc(client).fork(sessionId))),
      children: (sessionId) =>
        cached.pipe(Effect.flatMap((client) => svc(client).children(sessionId))),
      replyPermission: (sessionId, permissionId, granted) =>
        cached.pipe(
          Effect.flatMap((client) => svc(client).replyPermission(sessionId, permissionId, granted)),
        ),
    });
  }),
);

// ---------- art-prompt composition ----------

const decodePromptText = Schema.decodeUnknownOption(PromptResult);

/** Concatenate the text parts of a prompt result (no fence extraction — plain prose). */
function promptText(result: unknown): string {
  const decoded = decodePromptText(result);
  if (Option.isNone(decoded)) return '';
  const value = decoded.value;
  const data = value.data ?? value;
  const parts = data.parts ?? value.parts ?? [];
  let text = '';
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') text += `\n${part.text}`;
  }
  return text.trim();
}

const ART_COMPOSER_GUIDE =
  'You are writing a single image-generation prompt for a trading-card art slot. ' +
  'Return ONLY the prompt text — no preamble, no markdown, one paragraph.';

/**
 * LLM art-prompt composition (spec §AI pipelines): one-shot session fed the
 * theme context + the layout's argument values (+ an optional brief from a
 * fill turn). Falls back to the raw lookAndFeel if the model returns nothing.
 */
export function composeArtPrompt(
  themeContext: ThemeContextT,
  argumentValues: Record<string, string>,
  brief?: string,
): Effect.Effect<string, AgentError, AgentClient | ThreadBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ThreadBus;
    yield* bus.emit({
      _tag: 'Art',
      phase: 'composing',
      detail: 'composing art prompt from theme + arguments',
    });
    const id = yield* agent.createSession('cartis art compose');
    const argLines = Object.entries(argumentValues)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    const instruction = [
      ART_COMPOSER_GUIDE,
      `Look and feel: ${themeContext.lookAndFeel}`,
      themeContext.palette.length > 0 ? `Palette: ${themeContext.palette}` : '',
      argLines.length > 0 ? `Card arguments:\n${argLines}` : '',
      brief !== undefined && brief.length > 0 ? `Requested emphasis: ${brief}` : '',
    ]
      .filter((s) => s.length > 0)
      .join('\n\n');
    const result = yield* agent.withActivity(id, agent.prompt(id, instruction));
    const composed = promptText(result);
    const final = composed.length > 0 ? composed : themeContext.lookAndFeel;
    yield* bus.emit({
      _tag: 'Art',
      phase: 'composing',
      detail: `art prompt composed (${String(final.length)} chars)`,
    });
    return final;
  });
}

// ---------- conversational chat turn ----------

const CHAT_GUIDE =
  'You are editing a trading-card record through a conversation with its author. ' +
  'Reply with ONLY a JSON object ' +
  '{ "reply": string, "patch"?: { ...only changed fields... }, "artAction"?: { "brief": string, "editCurrentArt": boolean } }. ' +
  '"reply" is a short natural-language message to the author (what you changed, or a clarifying question). ' +
  'Include "patch" only when you are changing fields, containing only those fields. ' +
  'Include "artAction" ONLY when the request calls for generating or editing the card art.';

const decodeArtActionOption = Schema.decodeUnknownOption(ArtAction);
const decodeCardData = Schema.decodeUnknownOption(CardData);

/** Parse the first {...} block out of a model reply (fences tolerated). */
function extractJson(raw: string): Option.Option<unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return Option.none();
  try {
    return Option.some(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return Option.none();
  }
}

/** The rich prompt for one chat turn (guide + theme + fields + snapshot + ask). */
function chatPromptText(req: ChatTurnRequestT): string {
  return [
    CHAT_GUIDE,
    `Look and feel: ${req.themeContext.lookAndFeel}`,
    `Fields: ${req.fields.map((f) => `${f.key} (${f.kind})`).join(', ')}`,
    `Current values (respect these; the author may have hand-edited): ${JSON.stringify(req.currentData)}`,
    `Author request: ${req.userPrompt}`,
  ].join('\n\n');
}

/** Run one prompt under the activity watcher with a 5s console heartbeat. */
function promptWithHeartbeat(
  agent: Context.Tag.Service<AgentClient>,
  bus: Context.Tag.Service<ThreadBus>,
  sessionId: string,
  text: string,
  image?: { mime: string; dataUrl: string },
): Effect.Effect<unknown, AgentError> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const elapsed = Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.round((now - startedAt) / 1000)),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          elapsed.pipe(
            Effect.flatMap((secs) => bus.log('agent', `still working… (${String(secs)}s)`)),
            Effect.delay('5 seconds'),
            Effect.forever,
          ),
        );
        return yield* agent.withActivity(sessionId, agent.prompt(sessionId, text, image));
      }),
    );
  });
}

/**
 * Parse a chat reply into { assistantText, patch, artAction }. Conversational:
 * a reply with NO JSON is valid (a question/acknowledgement) → empty patch.
 * A JSON reply whose patch mistypes a field is a genuine error (AgentError).
 */
function parseChatReply(
  raw: string,
  decodePatch: (u: unknown) => Effect.Effect<CardDataT, AgentError>,
): Effect.Effect<{ assistantText: string; patch: CardDataT; artAction?: ArtActionT }, AgentError> {
  return Effect.gen(function* () {
    const json = extractJson(raw);
    if (Option.isNone(json)) return { assistantText: raw, patch: {} };
    const body = json.value as { patch?: unknown; artAction?: unknown };
    const patch = yield* decodePatch(body.patch ?? {});
    const artAction = Option.getOrUndefined(decodeArtActionOption(body.artAction));
    return { assistantText: raw, patch, artAction };
  });
}

/**
 * One conversational chat turn (card chat panel, spec 2026-08-03): reuse the
 * card's session (create on the first turn), snapshot currentData so hand edits
 * win, attach the current art for vision when present. TurnStarted/PartDelta/
 * TurnCompleted stream live from the watcher; this returns the structured
 * result the client applies + materializes for display.
 */
export function runChatTurn(
  req: ChatTurnRequestT,
  readArt: (
    fileName: string,
  ) => Effect.Effect<Option.Option<{ mime: string; dataUrl: string }>, FileStoreError>,
): Effect.Effect<ChatTurnResponseT, AgentError | FileStoreError, AgentClient | ThreadBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ThreadBus;
    const sessionId = req.sessionId ?? (yield* agent.createSession('cartis card chat'));
    const image =
      req.currentArtFileName !== undefined
        ? Option.getOrUndefined(yield* readArt(req.currentArtFileName))
        : undefined;
    yield* bus.log('agent', `chat: “${req.userPrompt.slice(0, 60)}”`);
    const result = yield* promptWithHeartbeat(agent, bus, sessionId, chatPromptText(req), image);
    const decodePatch = (u: unknown): Effect.Effect<CardDataT, AgentError> =>
      Schema.decodeUnknown(schemaFromFields(req.fields))(u).pipe(
        Effect.mapError(() => new AgentError({ reason: 'no-fill' })),
      );
    const parsed = yield* parseChatReply(promptText(result), decodePatch);
    yield* bus.log('agent', 'chat turn ready');
    return { sessionId, ...parsed };
  });
}

/**
 * Regenerate the last assistant turn (Task 5): revert it, then re-send the
 * stored last user text (the full rich prompt) so the reproduction is faithful.
 * Without the field spec, the new patch is decoded leniently against CardData.
 */
export function runRegenerate(
  sessionId: string,
): Effect.Effect<ChatTurnResponseT, AgentError, AgentClient | ThreadBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ThreadBus;
    const messages = yield* agent.messages(sessionId);
    const lastUser = [...messages].reverse().find((m) => m.info?.role === 'user');
    const lastAssistant = [...messages].reverse().find((m) => m.info?.role === 'assistant');
    const userText = lastUser ? textOfParts(lastUser.parts ?? []) : '';
    if (userText.length === 0) return yield* Effect.fail(new AgentError({ reason: 'no-fill' }));
    if (lastAssistant?.info?.id !== undefined) {
      yield* agent.revert(sessionId, lastAssistant.info.id);
    }
    yield* bus.log('agent', 'regenerate: replaying last turn');
    const result = yield* promptWithHeartbeat(agent, bus, sessionId, userText);
    const decodePatch = (u: unknown): Effect.Effect<CardDataT, AgentError> =>
      Effect.succeed(Option.getOrElse(decodeCardData(u), () => ({}) as CardDataT));
    const parsed = yield* parseChatReply(promptText(result), decodePatch);
    return { sessionId, ...parsed };
  });
}

// ---------- history mapping (opencode messages → thread messages) ----------

/** Concatenate the non-synthetic text parts of a message. */
function textOfParts(parts: readonly SessionMessagePartT[]): string {
  let text = '';
  for (const part of parts) {
    if (part.type === 'text' && part.synthetic !== true && typeof part.text === 'string') {
      text += part.text;
    }
  }
  return text.trim();
}

/**
 * Map an opencode message list to thread messages (history route). Real tool
 * parts map directly; the assistant's text runs through the SHARED
 * materializer so the v1 JSON contract renders as reply + card chips (never raw
 * JSON) — both transports handled indefinitely. Messages at/after
 * `revertMessageId` are excluded (no ghosts after edit/regenerate).
 */
export function mapSessionMessages(
  messages: SessionMessagesT,
  revertMessageId?: string,
): ThreadMessageT[] {
  const cut =
    revertMessageId !== undefined ? messages.findIndex((m) => m.info?.id === revertMessageId) : -1;
  const live = cut >= 0 ? messages.slice(0, cut) : messages;
  const out: ThreadMessageT[] = [];
  for (const message of live) {
    const role = message.info?.role === 'assistant' ? 'assistant' : 'user';
    const id = message.info?.id ?? '';
    if (id.length === 0) continue;
    const parts = message.parts ?? [];
    if (role === 'user') {
      const text = textOfParts(parts);
      out.push({ id, role, status: 'complete', parts: [{ _tag: 'Text', text }] });
      continue;
    }
    // assistant: real tool/reasoning parts in order, then materialized card actions.
    const threadParts: ThreadPartT[] = [];
    for (const part of parts) {
      if (part.type === 'tool') {
        const st = part.state;
        const status = toolStatusOf(st?.status);
        const secs =
          st?.time?.start !== undefined && st?.time?.end !== undefined
            ? (st.time.end - st.time.start) / 1000
            : undefined;
        const result = status === 'error' ? (st?.error ?? 'unknown') : st?.output;
        threadParts.push({
          _tag: 'ToolCall',
          callId: part.callID ?? part.id ?? 'tool',
          name: part.tool ?? 'tool',
          ...(st?.title !== undefined ? { title: st.title } : {}),
          status,
          ...(st?.input !== undefined ? { argsText: JSON.stringify(st.input) } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(status === 'error' ? { isError: true } : {}),
          ...(secs !== undefined ? { secs } : {}),
        });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        threadParts.push({ _tag: 'Reasoning', text: part.text });
      }
    }
    const answer = textOfParts(parts);
    if (answer.length > 0) threadParts.push(...materializeAssistantParts(answer));
    const status = message.info?.error !== undefined ? 'incomplete' : 'complete';
    out.push({ id, role, status, parts: threadParts });
  }
  return out;
}

// ---------- replicate ----------

const REPLICATE_MODEL = 'black-forest-labs/flux-kontext-pro';
const POLL_INTERVAL: Schedule.Schedule<number> = Schedule.spaced('1500 millis');
const POLL_TIMEOUT = '120 seconds';

const decodePrediction = Schema.decodeUnknownEither(Prediction);

function outputUrlOf(prediction: PredictionT): string | undefined {
  const output = prediction.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
  return undefined;
}

/** Reason text carried on the ApiError → ReplicateError 'create' detail. */
function apiErrorDetail(error: unknown): { status: number; detail: string } {
  // Replicate's ApiError carries a `response` (a web Response) and `message`.
  if (typeof error === 'object' && error !== null) {
    const e = error as { response?: { status?: unknown }; message?: unknown };
    const status = typeof e.response?.status === 'number' ? e.response.status : 0;
    const detail = typeof e.message === 'string' ? e.message : String(error);
    return { status, detail };
  }
  return { status: 0, detail: String(error) };
}

export class ReplicateSdk extends Context.Tag('cartis/ReplicateSdk')<
  ReplicateSdk,
  {
    createPrediction(token: string, input: object): Effect.Effect<PredictionT, ReplicateError>;
    getPrediction(token: string, id: string): Effect.Effect<PredictionT, ReplicateError>;
  }
>() {}

/**
 * Live layer: thin Effect wrapper over the official Replicate SDK. Constructs a
 * `Replicate` per token (env-at-request-time semantics), wraps the SDK promises
 * in `Effect.tryPromise`, maps SDK ApiError → ReplicateError, and decodes every
 * SDK result leniently through the Prediction contract (SDK types are
 * compile-time claims about a remote API — validated at runtime here).
 */
export const replicateSdkLive: Layer.Layer<ReplicateSdk> = Layer.effect(
  ReplicateSdk,
  Effect.gen(function* () {
    const { default: Replicate } = yield* Effect.promise(() => import('replicate'));
    const clientFor = (token: string) => new Replicate({ auth: token, useFileOutput: false });

    const decode = (
      value: unknown,
      onFail: (detail: string) => ReplicateError,
    ): Effect.Effect<PredictionT, ReplicateError> => {
      const decoded = decodePrediction(value);
      return decoded._tag === 'Right'
        ? Effect.succeed(decoded.right)
        : Effect.fail(onFail(decoded.left.message));
    };

    return ReplicateSdk.of({
      createPrediction: (token, input) =>
        Effect.tryPromise({
          try: () => clientFor(token).predictions.create({ model: REPLICATE_MODEL, input }),
          catch: (cause) => {
            const { status, detail } = apiErrorDetail(cause);
            return new ReplicateError({ reason: 'create', status, detail });
          },
        }).pipe(
          Effect.flatMap((p) =>
            decode(p, (d) => new ReplicateError({ reason: 'create', status: 0, detail: d })),
          ),
        ),
      getPrediction: (token, id) =>
        Effect.tryPromise({
          try: () => clientFor(token).predictions.get(id),
          catch: (cause) => {
            const { status } = apiErrorDetail(cause);
            return new ReplicateError({ reason: 'poll', status });
          },
        }).pipe(
          // decode failure → 'poll' (carries only status per the contract; the
          // decode-failure detail is intentionally dropped).
          Effect.flatMap((p) => decode(p, () => new ReplicateError({ reason: 'poll', status: 0 }))),
        ),
    });
  }),
);

export class ReplicateClient extends Context.Tag('cartis/ReplicateClient')<
  ReplicateClient,
  {
    generate(
      token: string,
      input: { prompt: string; imageDataUrl: string; aspectRatio?: string },
    ): Effect.Effect<string, ReplicateError | NetworkError>;
  }
>() {}

export const replicateClientLive: Layer.Layer<
  ReplicateClient,
  never,
  ReplicateSdk | ThreadBus | HttpClient.HttpClient
> = Layer.effect(
  ReplicateClient,
  Effect.gen(function* () {
    const sdk = yield* ReplicateSdk;
    const bus = yield* ThreadBus;
    const http = yield* HttpClient.HttpClient;
    const art = (phase: ArtPhaseT, detail: string): Effect.Effect<void> =>
      bus.emit({ _tag: 'Art', phase, detail });

    const generate = (
      token: string,
      input: { prompt: string; imageDataUrl: string; aspectRatio?: string },
    ): Effect.Effect<string, ReplicateError | NetworkError> =>
      Effect.gen(function* () {
        // Text-first generation sends an EMPTY data URL — flux-kontext-pro
        // rejects it (E006). Omit input_image entirely (pure text-to-image)
        // and never ask to match a nonexistent input image's aspect.
        const hasSource = /^data:[^;]+;base64,.+/.test(input.imageDataUrl);
        const requested = input.aspectRatio ?? 'match_input_image';
        const aspectRatio = !hasSource && requested === 'match_input_image' ? '1:1' : requested;
        const startedAt = yield* Clock.currentTimeMillis;
        const elapsed = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.round((now - startedAt) / 1000)),
        );

        yield* art(
          'generating',
          hasSource
            ? `sending photo + prompt to replicate (flux-kontext-pro, ${aspectRatio})`
            : `sending prompt to replicate (flux-kontext-pro, ${aspectRatio})`,
        );
        const created = yield* sdk.createPrediction(token, {
          prompt: input.prompt,
          ...(hasSource ? { input_image: input.imageDataUrl } : {}),
          output_format: 'png',
          aspect_ratio: aspectRatio,
        });
        const id = created.id;
        yield* art('generating', `prediction ${id ?? '?'} created`);
        if (typeof id !== 'string') {
          return yield* Effect.fail(new ReplicateError({ reason: 'no-output' }));
        }

        const lastStatus = yield* Ref.make('');
        const logStatusChange = (prediction: PredictionT) =>
          Effect.gen(function* () {
            const status = prediction.status ?? 'unknown';
            const prev = yield* Ref.get(lastStatus);
            if (status !== prev) {
              yield* Ref.set(lastStatus, status);
              const secs = yield* elapsed;
              yield* art('progress', `status: ${status} (${String(secs)}s)`);
            }
          });

        // Log the create-time status before the first poll (parity with today,
        // where the first loop iteration logs the created prediction's status).
        yield* logStatusChange(created);

        // Poll returns the schedule's output (a count), so the settled
        // prediction is captured in a Ref and read back after the loop.
        const latest = yield* Ref.make<PredictionT>(created);
        const poll = sdk.getPrediction(token, id).pipe(
          Effect.tap(logStatusChange),
          Effect.tap((prediction) => Ref.set(latest, prediction)),
          Effect.flatMap((prediction) => {
            const status = prediction.status;
            if (status === 'failed') {
              return Effect.fail(
                new ReplicateError({ reason: 'failed', detail: prediction.error ?? undefined }),
              );
            }
            if (status === 'canceled') {
              return Effect.fail(
                new ReplicateError({ reason: 'canceled', detail: prediction.error ?? undefined }),
              );
            }
            return Effect.succeed(prediction);
          }),
          Effect.repeat({
            schedule: POLL_INTERVAL,
            until: (prediction) => prediction.status === 'succeeded',
          }),
        );

        // Timeout covers polling only (not prediction creation) — intentional.
        yield* poll.pipe(
          Effect.timeoutFail({
            duration: POLL_TIMEOUT,
            onTimeout: () => new ReplicateError({ reason: 'timeout' }),
          }),
        );

        const settled = yield* Ref.get(latest);
        const url = outputUrlOf(settled);
        if (!url) return yield* Effect.fail(new ReplicateError({ reason: 'no-output' }));

        const response: HttpClientResponse.HttpClientResponse = yield* http
          .get(url)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        const bytes = yield* response.arrayBuffer.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const contentType = response.headers['content-type'] ?? 'image/png';
        const secs = yield* elapsed;
        yield* art(
          'downloaded',
          `output downloaded (${String(Math.round(bytes.byteLength / 1024))}KB) in ${String(secs)}s`,
        );
        return bytesToDataUrl(bytes, contentType);
      });

    return ReplicateClient.of({ generate });
  }),
);

// ---------- vite plugin ----------

const DATA_ROOT = 'cartis-data';
const STORES: readonly StoreName[] = ['images', 'cards', 'exports'];

function parseStorePath(url: string): { store: StoreName; rest: string } | undefined {
  const [path = ''] = url.split('?');
  const segments = path.split('/').filter((s) => s.length > 0);
  const store = STORES.find((name) => name === segments[0]);
  if (!store) return undefined;
  return { store, rest: decodeURIComponent(segments.slice(1).join('/')) };
}

const decodeStorePut = Schema.decodeUnknown(StorePutRequest);
const decodeChatTurn = Schema.decodeUnknown(ChatTurnRequest);
const decodeSessionAction = Schema.decodeUnknown(SessionAction);
const decodePermissionReply = Schema.decodeUnknown(PermissionReply);
const decodeImageGenerate = Schema.decodeUnknown(ImageGenerateRequest);
const encodeThreadEvent = Schema.encode(ThreadEventJson);

/** Read the FileStore art-vision reader used by chat turns (copy Buffer → fresh ArrayBuffer). */
function artReader(fs: Context.Tag.Service<FileStore>) {
  return (fileName: string) =>
    fs.readFile('images', fileName).pipe(
      Effect.map(
        Option.map((file) => {
          const raw = file.bytes;
          const copy = new ArrayBuffer(raw.byteLength);
          new Uint8Array(copy).set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
          return { mime: file.type, dataUrl: bytesToDataUrl(copy, file.type) };
        }),
      ),
    );
}

export function cartisBridge(): Plugin {
  return {
    name: 'cartis-bridge',
    configureServer(server) {
      const runtime = makeBridgeRuntime(DATA_ROOT);
      server.httpServer?.once('close', () => {
        void runtime.dispose();
      });

      // ----- /api/store -----
      server.middlewares.use('/api/store', (req, res) => {
        const parsed = parseStorePath(req.url ?? '');
        const sres = res as ServerResponse;
        if (!parsed) {
          sendJson(sres, 404, { error: 'unknown store' });
          return;
        }
        const { store, rest } = parsed;
        if (req.method === 'GET') {
          respond(
            runtime,
            sres,
            Effect.flatMap(FileStore, (fs) => fs.list(store)),
          );
          return;
        }
        if (req.method === 'PUT') {
          respond(
            runtime,
            sres,
            Effect.gen(function* () {
              const body = yield* readBody(req);
              const { record, bytesBase64 } = yield* decodeStorePut(body);
              const fs = yield* FileStore;
              return yield* fs.put(store, record, bytesBase64);
            }),
          );
          return;
        }
        if (req.method === 'DELETE' && rest.length > 0) {
          respond(
            runtime,
            sres,
            Effect.gen(function* () {
              const fs = yield* FileStore;
              yield* fs.remove(store, rest);
              return { ok: true };
            }),
          );
          return;
        }
        sendJson(sres, 500, { error: `unsupported ${String(req.method)} on /api/store` });
      });

      // ----- /files -----
      server.middlewares.use('/files', (req, res) => {
        const parsed = parseStorePath(req.url ?? '');
        const sres = res as ServerResponse;
        const effect = parsed
          ? Effect.flatMap(FileStore, (fs) => fs.readFile(parsed.store, parsed.rest))
          : Effect.succeed(Option.none<{ bytes: Buffer; type: string }>());
        void runtime.runPromiseExit(effect).then((exit) => {
          if (exit._tag === 'Success' && Option.isSome(exit.value)) {
            const file = exit.value.value;
            sres.statusCode = 200;
            sres.setHeader('Content-Type', file.type);
            sres.end(file.bytes);
          } else {
            sendJson(sres, 404, { error: 'not found' });
          }
        });
      });

      // ----- /api/chat/events (SSE) -----
      server.middlewares.use('/api/chat/events', (req, res) => {
        const sse = res as ServerResponse;
        sse.statusCode = 200;
        sse.setHeader('Content-Type', 'text/event-stream');
        sse.setHeader('Cache-Control', 'no-cache');
        sse.setHeader('Connection', 'keep-alive');

        const write = (frame: string): Effect.Effect<void> =>
          Effect.async<void>((resume) => {
            if (sse.write(frame)) {
              resume(Effect.void);
            } else {
              sse.once('drain', () => resume(Effect.void));
            }
          });

        const stream = Effect.flatMap(ThreadBus, (bus) =>
          bus.changes.pipe(
            Stream.mapEffect(encodeThreadEvent),
            Stream.map((json) => `data: ${json}\n\n`),
            Stream.runForEach(write),
          ),
        );
        const fiber = runtime.runFork(stream);
        // The client closing the SSE connection interrupts the streaming fiber
        // (releasing its PubSub subscription).
        req.on('close', () => {
          runtime.runFork(Fiber.interrupt(fiber));
        });
      });

      // ----- /api/status -----
      server.middlewares.use('/api/status', (_req, res) => {
        const sres = res as ServerResponse;
        void runtime.runPromise(envOption('REPLICATE_API_TOKEN')).then((token) => {
          sendJson(sres, 200, { image: Option.isSome(token) ? 'replicate' : 'stub' });
        });
      });

      // ----- /api/chat/turn — one conversational card-editing turn -----
      server.middlewares.use('/api/chat/turn', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') {
          sendJson(sres, 405, { error: 'POST only' });
          return;
        }
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const body = yield* readBody(req);
            const parsed = yield* decodeChatTurn(body);
            const fs = yield* FileStore;
            return yield* runChatTurn(parsed, artReader(fs));
          }),
        );
      });

      // ----- /api/chat/history?sessionId=… — rehydrate a card's conversation -----
      server.middlewares.use('/api/chat/history', (req, res) => {
        const sres = res as ServerResponse;
        const [, query = ''] = (req.url ?? '').split('?');
        const sessionId = new URLSearchParams(query).get('sessionId') ?? '';
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            if (sessionId.length === 0) return { messages: [] as ThreadMessageT[] };
            const agent = yield* AgentClient;
            const messages = yield* agent.messages(sessionId);
            const info = yield* agent.info(sessionId).pipe(Effect.orElseSucceed(() => undefined));
            return { messages: mapSessionMessages(messages, info?.revert?.messageID) };
          }),
        );
      });

      // ----- /api/chat/abort|revert|regenerate|fork|permission -----
      server.middlewares.use('/api/chat/abort', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId } = yield* decodeSessionAction(yield* readBody(req));
            const agent = yield* AgentClient;
            yield* agent.abort(sessionId);
            return { sessionId };
          }),
        );
      });

      server.middlewares.use('/api/chat/revert', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId, messageId } = yield* decodeSessionAction(yield* readBody(req));
            const agent = yield* AgentClient;
            if (messageId !== undefined) yield* agent.revert(sessionId, messageId);
            return { sessionId };
          }),
        );
      });

      server.middlewares.use('/api/chat/regenerate', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId } = yield* decodeSessionAction(yield* readBody(req));
            return yield* runRegenerate(sessionId);
          }),
        );
      });

      server.middlewares.use('/api/chat/fork', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId } = yield* decodeSessionAction(yield* readBody(req));
            const agent = yield* AgentClient;
            const forkedId = yield* agent.fork(sessionId);
            return { sessionId: forkedId };
          }),
        );
      });

      server.middlewares.use('/api/chat/permission', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId, permissionId, granted } = yield* decodePermissionReply(
              yield* readBody(req),
            );
            const agent = yield* AgentClient;
            yield* agent.replyPermission(sessionId, permissionId, granted);
            return { sessionId };
          }),
        );
      });

      // ----- /api/image/generate -----
      server.middlewares.use('/api/image/generate', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') {
          sendJson(sres, 405, { error: 'POST only' });
          return;
        }
        void runtime.runPromise(envOption('REPLICATE_API_TOKEN')).then((tokenOpt) => {
          if (Option.isNone(tokenOpt)) {
            sendJson(sres, 503, {
              error: 'REPLICATE_API_TOKEN not set — using stub locally',
            });
            return;
          }
          const token = tokenOpt.value;
          respond(
            runtime,
            sres,
            Effect.gen(function* () {
              const body = yield* readBody(req);
              const parsed = yield* decodeImageGenerate(body);
              // 1) compose the final prompt via the LLM when theme context is present
              const prompt = parsed.themeContext
                ? yield* composeArtPrompt(
                    parsed.themeContext,
                    parsed.argumentValues ?? {},
                    parsed.brief,
                  )
                : parsed.prompt;
              // 2) resolve the source image: current art (edit mode) beats the attached photo
              let imageDataUrl = parsed.imageDataUrl;
              if (parsed.editCurrentArt === true && parsed.currentArtFileName !== undefined) {
                const fs = yield* FileStore;
                const file = yield* fs.readFile('images', parsed.currentArtFileName);
                if (Option.isSome(file)) {
                  const raw = file.value.bytes;
                  // Copy into a fresh ArrayBuffer (Buffer.buffer may be a SharedArrayBuffer).
                  const copy = new ArrayBuffer(raw.byteLength);
                  new Uint8Array(copy).set(
                    new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
                  );
                  imageDataUrl = bytesToDataUrl(copy, file.value.type);
                }
              }
              const client = yield* ReplicateClient;
              const dataUrl = yield* client.generate(token, {
                prompt,
                imageDataUrl,
                aspectRatio: parsed.aspectRatio,
              });
              return { dataUrl };
            }),
          );
        });
      });
    },
  };
}
