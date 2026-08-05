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
  Redacted,
  Ref,
  Runtime,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { createLogger, type Logger, type Plugin } from 'vite';
import {
  ChatEditRequest,
  ChatSwitchRequest,
  ChatTurnRequest,
  ImageGenerateRequest,
  SessionAction,
  StorePutRequest,
} from '../contracts/api.ts';
import {
  AgentError,
  type FileStoreError,
  NetworkError,
  ReplicateError,
} from '../contracts/errors.ts';
import {
  type AspectRatioT,
  ConcreteAspectRatio,
  type ConcreteAspectRatioT,
} from '../contracts/fields.ts';
import { type DataUrlT, SessionId } from '../contracts/ids.ts';

import { Prediction, type PredictionT } from '../contracts/replicate.ts';
import type { ThemeContextT } from '../contracts/theme.ts';
import {
  type ArtPhaseT,
  ThreadEventJson,
  type ThreadEventT,
  type ThreadMessageT,
} from '../contracts/thread.ts';
import { bytesToDataUrl } from '../images/codec.ts';
import { makeBridgeRuntime, readBody, respond, sendJson } from './BridgeRuntime.ts';
import { FileStore, type StoreName } from './fileStore.ts';
import { computeAnchors, mapSessionEntries, switchBranch } from './pi/entries.ts';
import { makePiRuntime, type PiRuntime as PiRuntimeT, parseModelRef } from './pi/runtime.ts';
import { runTurn, TurnBusyError, type TurnResult } from './pi/turn.ts';
import { type LogScope, type LogSink, ThreadBus } from './threadBus.ts';

/** Env-at-request-time read; empty values treated as unset. */
function envOption(name: string): Effect.Effect<Option.Option<string>> {
  return Effect.orDie(Config.option(Config.string(name))).pipe(
    Effect.map(Option.filter((value) => value.length > 0)),
  );
}

/**
 * Redacted sibling for secrets (spec §2): the value stringifies to
 * `<redacted>` everywhere; `Redacted.value` unwraps only at the API call.
 */
function envRedacted(name: string): Effect.Effect<Option.Option<Redacted.Redacted<string>>> {
  return Effect.orDie(Config.option(Config.redacted(name))).pipe(
    Effect.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
  );
}

// ---------- pi runtime (in-process agent; migration spec) ----------

/** The composer's output: a prompt plus the CONCRETE ratio the art will use. */
export interface ComposedArt {
  prompt: string;
  aspectRatio: ConcreteAspectRatioT;
}

const decodeConcreteAspect = Schema.decodeUnknownOption(ConcreteAspectRatio);

/**
 * Parse the composer model's reply: an optional `ASPECT: <ratio>` FIRST line
 * (present only when we asked the model to pick), then the prompt paragraph.
 * A recognized ASPECT line is stripped either way; an invalid ratio yields
 * `aspect: undefined` so the caller falls back rather than sending garbage.
 */
export function parseComposedArt(raw: string): {
  prompt: string;
  aspect: ConcreteAspectRatioT | undefined;
} {
  const text = raw.trim();
  const match = /^aspect\s*:\s*(\S+)\s*\n?/i.exec(text);
  if (match === null) return { prompt: text, aspect: undefined };
  return {
    prompt: text.slice(match[0].length).trim(),
    aspect: Option.getOrUndefined(decodeConcreteAspect(match[1])),
  };
}

/**
 * One-shot art composition via pi's completeSimple — no session, no watcher
 * (spec §4.4). Composes the image prompt AND resolves the aspect ratio:
 * a concrete request passes through untouched; 'auto' asks the model to pick
 * from the concrete set (first line `ASPECT: <ratio>`), falling back to 1:1.
 * Falls back to the raw lookAndFeel when the model returns nothing usable.
 */
export async function composeArtPi(
  rt: PiRuntimeT,
  themeContext: ThemeContextT,
  argumentValues: Record<string, string>,
  opts: { aspect: AspectRatioT; hasSourcePhoto: boolean; brief?: string },
): Promise<ComposedArt> {
  const fallbackAspect: ConcreteAspectRatioT = opts.aspect === 'auto' ? '1:1' : opts.aspect;
  const fallback: ComposedArt = { prompt: themeContext.lookAndFeel, aspectRatio: fallbackAspect };
  const { modelRuntime } = await rt.deps();
  const ref = parseModelRef(process.env.CARTIS_MODEL);
  const model = modelRuntime.getModel(ref.provider, ref.modelId);
  if (model === undefined) return fallback;
  const argLines = Object.entries(argumentValues)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const brief = opts.brief;
  const instruction = [
    'You are writing a single image-generation prompt for a standalone artwork. ' +
      'Return ONLY the prompt text — no preamble, no markdown, one paragraph. ' +
      'Describe ONLY the artwork: subject, scene, mood, lighting, style. ' +
      'NEVER use the words "card", "trading card", "frame", "border", or ask for any ' +
      'text, title, stats, or layout elements in the image — the model must paint ' +
      'pure illustration (mentioning a card makes it render card frames and text).',
    opts.aspect === 'auto'
      ? `Before the prompt, on the FIRST line alone, write "ASPECT: <ratio>" choosing the ` +
        `ratio that best suits the subject from exactly: ${ConcreteAspectRatio.literals.join(', ')}. ` +
        (opts.hasSourcePhoto
          ? 'A reference photo is attached to the generation — favor a ratio that flatters a portrait subject.'
          : 'There is no reference photo — pick purely from the subject and scene.')
      : '',
    `Look and feel: ${themeContext.lookAndFeel}`,
    themeContext.palette.length > 0 ? `Palette: ${themeContext.palette}` : '',
    argLines.length > 0 ? `Card arguments:\n${argLines}` : '',
    brief !== undefined && brief.length > 0 ? `Author brief: ${brief}` : '',
  ]
    .filter((l) => l.length > 0)
    .join('\n\n');
  try {
    const message = await modelRuntime.completeSimple(model as never, {
      messages: [{ role: 'user', content: instruction, timestamp: Date.now() } as never],
    });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return fallback;
    }
    const text = (message.content ?? [])
      .map((c) => ('text' in c && c.type === 'text' ? c.text : ''))
      .join('')
      .trim();
    if (text.length === 0) return fallback;
    const parsed = parseComposedArt(text);
    return {
      prompt: parsed.prompt.length > 0 ? parsed.prompt : themeContext.lookAndFeel,
      aspectRatio: opts.aspect === 'auto' ? (parsed.aspect ?? '1:1') : opts.aspect,
    };
  } catch {
    return fallback;
  }
}

/** Turn errors → the typed catalog (spec §3.2). */
function agentErrorOf(cause: unknown): AgentError {
  if (cause instanceof TurnBusyError) return new AgentError({ reason: 'busy' });
  return new AgentError({
    reason: 'turn-failed',
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

// ---------- replicate ----------

export const REPLICATE_MODEL = 'google/nano-banana-pro';
/** 2K balances card-art sharpness (300-DPI export) against cost/speed. */
const REPLICATE_RESOLUTION = '2K';
const POLL_INTERVAL: Schedule.Schedule<number> = Schedule.spaced('1500 millis');
const POLL_TIMEOUT = '120 seconds';

const decodePrediction = Schema.decodeUnknownEither(Prediction);

/** First output URL — composes straight off the Option-decoded field (spec §3/§5). */
function outputUrlOf(prediction: PredictionT): Option.Option<string> {
  return prediction.output.pipe(
    Option.flatMap((output) => {
      if (typeof output === 'string') return Option.some(output);
      return Array.isArray(output) && typeof output[0] === 'string'
        ? Option.some(output[0])
        : Option.none();
    }),
  );
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
    createPrediction(
      token: Redacted.Redacted<string>,
      input: object,
    ): Effect.Effect<PredictionT, ReplicateError>;
    getPrediction(
      token: Redacted.Redacted<string>,
      id: string,
    ): Effect.Effect<PredictionT, ReplicateError>;
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
    const clientFor = (token: Redacted.Redacted<string>) =>
      new Replicate({ auth: Redacted.value(token), useFileOutput: false });

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
      token: Redacted.Redacted<string>,
      // Concrete by type — 'auto' (the AI-picks mode) resolves before this seam.
      input: { prompt: string; imageDataUrl?: DataUrlT; aspectRatio: ConcreteAspectRatioT },
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
      token: Redacted.Redacted<string>,
      input: { prompt: string; imageDataUrl?: DataUrlT; aspectRatio: ConcreteAspectRatioT },
    ): Effect.Effect<string, ReplicateError | NetworkError> =>
      Effect.gen(function* () {
        // Presence IS validity now — the DataUrl brand proves a non-empty
        // base64 source (the E006 empty-image_input class is unrepresentable),
        // and the aspect is concrete by type ('auto' resolved upstream).
        const hasSource = input.imageDataUrl !== undefined;
        const aspectRatio = input.aspectRatio;
        const startedAt = yield* Clock.currentTimeMillis;
        const elapsed = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.round((now - startedAt) / 1000)),
        );

        yield* art(
          'generating',
          hasSource
            ? `sending photo + prompt to replicate (nano-banana-pro, ${aspectRatio})`
            : `sending prompt to replicate (nano-banana-pro, ${aspectRatio})`,
        );
        const created = yield* sdk.createPrediction(token, {
          prompt: input.prompt,
          // nano-banana-pro takes an ARRAY of reference images (up to 14); we send one.
          ...(hasSource ? { image_input: [input.imageDataUrl] } : {}),
          output_format: 'png',
          aspect_ratio: aspectRatio,
          resolution: REPLICATE_RESOLUTION,
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
                new ReplicateError({
                  reason: 'failed',
                  detail: Option.getOrUndefined(prediction.error),
                }),
              );
            }
            if (status === 'canceled') {
              return Effect.fail(
                new ReplicateError({
                  reason: 'canceled',
                  detail: Option.getOrUndefined(prediction.error),
                }),
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
        const url = yield* outputUrlOf(settled).pipe(
          Effect.mapError(() => new ReplicateError({ reason: 'no-output' })),
        );

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

/** E2e harnesses point this at a scratch dir so runs never touch real data. */
const DATA_ROOT = process.env.CARTIS_DATA_ROOT ?? 'cartis-data';
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
const decodeChatEdit = Schema.decodeUnknown(ChatEditRequest);
const decodeChatSwitch = Schema.decodeUnknown(ChatSwitchRequest);
const decodeSessionAction = Schema.decodeUnknown(SessionAction);
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
      // Log through vite's own logger so [cartis:*] lines match vite's output
      // (timestamped, colored prefix) — one cohesive terminal.
      const loggers: Record<LogScope, Logger> = {
        agent: createLogger('info', { prefix: '[cartis:agent]', allowClearScreen: false }),
        image: createLogger('info', { prefix: '[cartis:image]', allowClearScreen: false }),
        bridge: createLogger('info', { prefix: '[cartis:bridge]', allowClearScreen: false }),
      };
      const viteSink: LogSink = (scope, message) =>
        loggers[scope].info(message, { timestamp: true });
      const runtime = makeBridgeRuntime(DATA_ROOT, viteSink);
      // In-process pi agent runtime (migration spec §2) — lazy heavy import.
      // CARTIS_FAKE_AGENT=1 (scripted e2e, test-hardening §Track B): the SAME
      // runtime over a scripted faux model — real loop, real tools, real
      // persistence, zero network. The thunk keeps fakeAgent (and pi) out of
      // the config-load graph.
      const fakeAgent = process.env.CARTIS_FAKE_AGENT === '1';
      if (fakeAgent) {
        process.env.CARTIS_MODEL = 'faux/faux-model';
        loggers.agent.info('CARTIS_FAKE_AGENT=1 — scripted faux model (no network)', {
          timestamp: true,
        });
      }
      const piRt = fakeAgent
        ? makePiRuntime(DATA_ROOT, {
            modelRuntime: () => import('./pi/fakeAgent.ts').then((m) => m.fakeAgentRuntime()),
          })
        : makePiRuntime(DATA_ROOT);
      if (
        !fakeAgent &&
        process.env.ANTHROPIC_API_KEY === undefined &&
        process.env.OPENAI_API_KEY === undefined
      ) {
        loggers.agent.info(
          'no ANTHROPIC_API_KEY / OPENAI_API_KEY set — chat turns will fail until one is configured in .env',
          { timestamp: true },
        );
      }
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
        void runtime.runPromise(envRedacted('REPLICATE_API_TOKEN')).then((token) => {
          sendJson(sres, 200, { image: Option.isSome(token) ? 'replicate' : 'stub' });
        });
      });

      // ----- pi turn plumbing: ThreadBus io + FileStore art reader -----
      const turnIo = {
        emit: (event: ThreadEventT) => {
          void runtime.runPromise(Effect.flatMap(ThreadBus, (b) => b.emit(event)));
        },
        log: (message: string) => {
          void runtime.runPromise(Effect.flatMap(ThreadBus, (b) => b.log('agent', message)));
        },
        readArt: async (fileName: string) => {
          const result = await runtime.runPromise(
            Effect.flatMap(FileStore, (fs) => artReader(fs)(fileName)).pipe(
              Effect.orElseSucceed(() => Option.none<{ mime: string; dataUrl: string }>()),
            ),
          );
          return Option.getOrUndefined(result);
        },
      };
      const runTurnEffect = (
        work: () => Promise<TurnResult>,
      ): Effect.Effect<TurnResult, AgentError> =>
        Effect.tryPromise({ try: work, catch: (cause) => agentErrorOf(cause) });

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
            const parsed = yield* decodeChatTurn(yield* readBody(req));
            return yield* runTurnEffect(() => runTurn(piRt, parsed, turnIo));
          }),
        );
      });

      // ----- /api/chat/edit — edit an earlier user message (tree sibling) -----
      server.middlewares.use('/api/chat/edit', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const parsed = yield* decodeChatEdit(yield* readBody(req));
            const { targetMessageId, ...turnReq } = parsed;
            return yield* runTurnEffect(() =>
              runTurn(piRt, turnReq, turnIo, { kind: 'edit', targetUserEntryId: targetMessageId }),
            );
          }),
        );
      });

      // ----- /api/chat/regenerate — replay the last user turn on a new branch -----
      server.middlewares.use('/api/chat/regenerate', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const parsed = yield* decodeChatTurn(yield* readBody(req));
            return yield* runTurnEffect(() =>
              runTurn(piRt, parsed, turnIo, { kind: 'regenerate' }),
            );
          }),
        );
      });

      // ----- /api/chat/history?sessionId=… — the ACTIVE branch as messages -----
      server.middlewares.use('/api/chat/history', (req, res) => {
        const sres = res as ServerResponse;
        const [, query = ''] = (req.url ?? '').split('?');
        const sessionId = new URLSearchParams(query).get('sessionId') ?? '';
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            if (sessionId.length === 0) return { messages: [] as ThreadMessageT[] };
            // Missing file → empty history (clean break for pre-migration ids).
            const messages = yield* Effect.tryPromise({
              try: async () => mapSessionEntries(await piRt.getSession(sessionId)),
              catch: (cause) => agentErrorOf(cause),
            });
            return { messages };
          }),
        );
      });

      // ----- /api/chat/tree?sessionId=… — ‹ n/m › anchors from the session tree -----
      server.middlewares.use('/api/chat/tree', (req, res) => {
        const sres = res as ServerResponse;
        const [, query = ''] = (req.url ?? '').split('?');
        const sessionId = new URLSearchParams(query).get('sessionId') ?? '';
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            if (sessionId.length === 0) return { anchors: [] };
            const anchors = yield* Effect.tryPromise({
              try: async () => computeAnchors(await piRt.getSession(sessionId)),
              catch: (cause) => agentErrorOf(cause),
            });
            return { anchors };
          }),
        );
      });

      // ----- /api/chat/switch — durable branch switch (leaf_switch entry) -----
      server.middlewares.use('/api/chat/switch', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId, leafId } = yield* decodeChatSwitch(yield* readBody(req));
            if (piRt.inFlight.has(sessionId)) {
              return yield* Effect.fail(new AgentError({ reason: 'busy' }));
            }
            yield* Effect.tryPromise({
              try: async () => switchBranch(await piRt.getSession(sessionId), leafId),
              catch: (cause) => agentErrorOf(cause),
            });
            return { sessionId };
          }),
        );
      });

      // ----- /api/chat/abort — interrupt the running turn -----
      server.middlewares.use('/api/chat/abort', (req, res) => {
        const sres = res as ServerResponse;
        if (req.method !== 'POST') return sendJson(sres, 405, { error: 'POST only' });
        respond(
          runtime,
          sres,
          Effect.gen(function* () {
            const { sessionId } = yield* decodeSessionAction(yield* readBody(req));
            const live = piRt.inFlight.get(sessionId);
            if (live !== undefined) yield* Effect.promise(() => live.abort());
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
        void runtime.runPromise(envRedacted('REPLICATE_API_TOKEN')).then((tokenOpt) => {
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
              // 1) compose prompt + resolve the aspect via the LLM when theme
              //    context is present ('auto' = the model picks a concrete ratio)
              const themeContext = parsed.themeContext;
              const requestedAspect = parsed.aspectRatio;
              const hasSourcePhoto =
                parsed.imageDataUrl !== undefined || parsed.editCurrentArt === true;
              const composed = themeContext
                ? yield* Effect.gen(function* () {
                    const bus = yield* ThreadBus;
                    yield* bus.emit({
                      _tag: 'Art',
                      phase: 'composing',
                      detail: 'composing art prompt from theme + arguments',
                    });
                    const out = yield* Effect.promise(() =>
                      composeArtPi(piRt, themeContext, parsed.argumentValues ?? {}, {
                        aspect: requestedAspect,
                        hasSourcePhoto,
                        brief: parsed.brief,
                      }),
                    );
                    if (requestedAspect === 'auto') {
                      yield* bus.emit({
                        _tag: 'Art',
                        phase: 'composing',
                        detail: `aspect auto → ${out.aspectRatio}`,
                      });
                    }
                    return out;
                  })
                : undefined;
              const prompt = composed?.prompt ?? parsed.prompt;
              // No composer (raw-prompt path): 'auto' has nothing to pick with — 1:1.
              const aspectRatio =
                composed?.aspectRatio ?? (requestedAspect === 'auto' ? '1:1' : requestedAspect);
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
              const bus = yield* ThreadBus;
              const dataUrl = yield* client
                .generate(token, {
                  prompt,
                  imageDataUrl,
                  aspectRatio,
                })
                .pipe(
                  // Surface art failures in the chat as an Art 'error' event.
                  Effect.tapError((e) =>
                    bus.emit({ _tag: 'Art', phase: 'error', detail: e.message }),
                  ),
                );
              return { dataUrl };
            }),
          );
        });
      });
    },
  };
}
