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
  Schedule,
  Schema,
  Stream,
} from 'effect';
import type { Plugin } from 'vite';
import { ActivityEventJson } from '../contracts/activity.ts';
import {
  AgentFillRequest,
  type AgentFillRequestT,
  type AgentFillResponseT,
  ArtAction,
  ImageGenerateRequest,
  StorePutRequest,
  schemaFromFields,
} from '../contracts/api.ts';
import {
  AgentError,
  type FileStoreError,
  NetworkError,
  ReplicateError,
} from '../contracts/errors.ts';
import { PromptResult, SessionCreated } from '../contracts/opencode.ts';
import { Prediction, type PredictionT } from '../contracts/replicate.ts';
import type { ThemeContextT } from '../contracts/theme.ts';
import { bytesToDataUrl } from '../images/codec.ts';
import { ActivityBus } from './activity.ts';
import { makeBridgeRuntime, readBody, respond, sendJson } from './BridgeRuntime.ts';
import { FileStore, type StoreName } from './fileStore.ts';

// ---------- opencode ----------

/** The slice of the opencode SDK client the bridge drives. */
export interface OpencodeClient {
  session: {
    create(input: { body: { title: string } }): Promise<unknown>;
    prompt(input: unknown): Promise<unknown>;
  };
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
  }
>() {}

/** Build an AgentClient over a raw opencode SDK client. */
export function agentClientFromSdk(client: OpencodeClient): Context.Tag.Service<AgentClient> {
  return {
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
  };
}

/**
 * Live layer: lazy dynamic import of the opencode SDK on first use, cached so
 * `bun run dev` startup stays fast when the agent is never invoked.
 * `OPENCODE_MODEL` via Config.option.
 */
export const agentClientLive: Layer.Layer<AgentClient> = Layer.effect(
  AgentClient,
  Effect.gen(function* () {
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
    return AgentClient.of({
      createSession: (title) =>
        cached.pipe(Effect.flatMap((client) => agentClientFromSdk(client).createSession(title))),
      prompt: (sessionId, text, image) =>
        cached.pipe(
          Effect.flatMap((client) => agentClientFromSdk(client).prompt(sessionId, text, image)),
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
): Effect.Effect<string, AgentError, AgentClient | ActivityBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ActivityBus;
    yield* bus.emit('agent', 'composing art prompt from theme + arguments');
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
    const result = yield* agent.prompt(id, instruction);
    const composed = promptText(result);
    const final = composed.length > 0 ? composed : themeContext.lookAndFeel;
    yield* bus.emit('agent', `art prompt composed (${String(final.length)} chars)`);
    return final;
  });
}

// ---------- conversational fill ----------

const FILL_GUIDE =
  'You are editing a trading-card record. Reply with ONLY a JSON object ' +
  '{ "patch": { ...only changed fields... }, "artAction"?: { "brief": string, "editCurrentArt": boolean } }. ' +
  'patch must contain only the fields you intend to change. Include artAction ' +
  'ONLY when the request calls for generating or editing the card art.';

const decodeArtActionOption = Schema.decodeUnknownOption(ArtAction);

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

/**
 * One conversational fill turn (spec §AI pipelines): reuse the episode's
 * session (create on the first turn), snapshot currentData into the prompt so
 * hand edits win over session memory, attach the current art for vision when
 * present, and Schema-decode the targeted patch.
 */
export function runFillAgent(
  req: AgentFillRequestT,
  readArt: (
    fileName: string,
  ) => Effect.Effect<Option.Option<{ mime: string; dataUrl: string }>, FileStoreError>,
): Effect.Effect<AgentFillResponseT, AgentError | FileStoreError, AgentClient | ActivityBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ActivityBus;
    const sessionId = req.sessionId ?? (yield* agent.createSession('cartis card fill'));
    const image =
      req.currentArtFileName !== undefined
        ? Option.getOrUndefined(yield* readArt(req.currentArtFileName))
        : undefined;
    const text = [
      FILL_GUIDE,
      `Look and feel: ${req.themeContext.lookAndFeel}`,
      `Fields: ${req.fields.map((f) => `${f.key} (${f.kind})`).join(', ')}`,
      `Current values (respect these; the user may have hand-edited): ${JSON.stringify(req.currentData)}`,
      `User request: ${req.userPrompt}`,
    ].join('\n\n');
    yield* bus.emit('agent', `fill: “${req.userPrompt.slice(0, 60)}”`);
    const result = yield* agent.prompt(sessionId, text, image);
    const json = extractJson(promptText(result));
    if (Option.isNone(json)) {
      return yield* Effect.fail(new AgentError({ reason: 'no-fill' }));
    }
    const body = json.value as { patch?: unknown; artAction?: unknown };
    const patch = yield* Schema.decodeUnknown(schemaFromFields(req.fields))(body.patch ?? {}).pipe(
      Effect.mapError(() => new AgentError({ reason: 'no-fill' })),
    );
    const artAction = Option.getOrUndefined(decodeArtActionOption(body.artAction));
    yield* bus.emit('agent', 'fill patch ready');
    return { sessionId, patch, artAction };
  });
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
  ReplicateSdk | ActivityBus | HttpClient.HttpClient
> = Layer.effect(
  ReplicateClient,
  Effect.gen(function* () {
    const sdk = yield* ReplicateSdk;
    const bus = yield* ActivityBus;
    const http = yield* HttpClient.HttpClient;

    const generate = (
      token: string,
      input: { prompt: string; imageDataUrl: string; aspectRatio?: string },
    ): Effect.Effect<string, ReplicateError | NetworkError> =>
      Effect.gen(function* () {
        const aspectRatio = input.aspectRatio ?? 'match_input_image';
        const startedAt = yield* Clock.currentTimeMillis;
        const elapsed = Clock.currentTimeMillis.pipe(
          Effect.map((now) => Math.round((now - startedAt) / 1000)),
        );

        yield* bus.emit(
          'image',
          `sending photo + prompt to replicate (flux-kontext-pro, ${aspectRatio})`,
        );
        const created = yield* sdk.createPrediction(token, {
          prompt: input.prompt,
          input_image: input.imageDataUrl,
          output_format: 'png',
          aspect_ratio: aspectRatio,
        });
        const id = created.id;
        yield* bus.emit('image', `prediction ${id ?? '?'} created`);
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
              yield* bus.emit('image', `status: ${status} (${secs}s)`);
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
        yield* bus.emit(
          'image',
          `output downloaded (${String(Math.round(bytes.byteLength / 1024))}KB) in ${secs}s`,
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
const decodeFill = Schema.decodeUnknown(AgentFillRequest);
const decodeImageGenerate = Schema.decodeUnknown(ImageGenerateRequest);
const encodeActivity = Schema.encode(ActivityEventJson);

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

      // ----- /api/activity (SSE) -----
      server.middlewares.use('/api/activity', (req, res) => {
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

        const stream = Effect.flatMap(ActivityBus, (bus) =>
          bus.changes.pipe(
            Stream.mapEffect(encodeActivity),
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

      // ----- /api/agent/fill -----
      server.middlewares.use('/api/agent/fill', (req, res) => {
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
            const parsed = yield* decodeFill(body);
            const fs = yield* FileStore;
            const readArt = (fileName: string) =>
              fs.readFile('images', fileName).pipe(
                Effect.map(
                  Option.map((file) => {
                    const raw = file.bytes;
                    const copy = new ArrayBuffer(raw.byteLength);
                    new Uint8Array(copy).set(
                      new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
                    );
                    return { mime: file.type, dataUrl: bytesToDataUrl(copy, file.type) };
                  }),
                ),
              );
            return yield* runFillAgent(parsed, readArt);
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
