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
import { AgentCardRequest, ImageGenerateRequest, StorePutRequest } from '../contracts/api.ts';
import { AgentError, NetworkError, ReplicateError } from '../contracts/errors.ts';
import { PromptResult, SessionCreated } from '../contracts/opencode.ts';
import { Prediction, type PredictionT } from '../contracts/replicate.ts';
import { bytesToDataUrl } from '../images/codec.ts';
import { ActivityBus } from './activity.ts';
import { makeBridgeRuntime, readBody, respond, sendJson } from './BridgeRuntime.ts';
import { FileStore, type StoreName } from './fileStore.ts';

// ---------- agent prompt ----------

export const CARD_API_GUIDE = `You write TSX modules for Cartis, a trading-card builder.
Rules:
- Output a COMPLETE module whose default export is a card component.
- Allowed imports ONLY: 'cartis/cards', 'cartis/ui', '@expressive/react'.
- 'cartis/cards' exports: ArcaneCard (props: data, holo), CardSurface (375x525 surface, props: holo, frameClass),
  HoloFoil, parts ArcaneTitleBar/ArcaneArtWindow/ArcaneTypeLine/ArcaneRulesBox/ArcaneStatBadge/ArcaneCostPips
  (each takes a palette from paletteFor(essenceId)), paletteFor, ESSENCES, rarityFrom, arcaneTemplate.
- Card data keys for ArcaneCard: name, essence (ember|tide|verdant|radiant|umbral|relic), cost (0-9),
  typeLine, ability, flavor, might, ward, rarity (common|uncommon|rare|mythic), art (image url, optional).
- Style with tailwind utility classNames. Do not use React hooks; expressive Component classes may be subclassed
  (capital-letter methods of ArcaneCard are overridable subcomponents).
- No placeholder comments; the module must compile standalone.
- Reply with EXACTLY ONE fenced \`\`\`tsx code block containing the full revised module, nothing else.`;

export function buildAgentPrompt(userPrompt: string, currentCode: string): string {
  return [
    CARD_API_GUIDE,
    'Current module source:',
    '```tsx',
    currentCode,
    '```',
    'User request:',
    userPrompt,
  ].join('\n\n');
}

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

const decodePromptOption = Schema.decodeUnknownOption(PromptResult);
const decodeSessionOption = Schema.decodeUnknownOption(SessionCreated);

/**
 * Extract card TSX from a prompt result. Reimplemented on the opencode contract
 * (`Schema.decodeUnknownOption`) + the existing fence regex; SAME signature and
 * behavior as today (its tests are the spec).
 */
export function extractCode(result: unknown): string | undefined {
  const decoded = decodePromptOption(result);
  if (Option.isNone(decoded)) return undefined;
  const value = decoded.value;
  // `data` may wrap the payload, or the payload may be flat (result === data).
  const data = value.data ?? value;
  const structured =
    data.info?.structured_output ?? data.structured_output ?? value.structured_output;
  if (typeof structured?.code === 'string' && structured.code.trim().length > 0) {
    return structured.code;
  }
  const parts = data.parts ?? value.parts;
  if (parts) {
    let text = '';
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') text += `\n${part.text}`;
    }
    const fences = [...text.matchAll(/```(?:tsx|jsx|typescript|ts)?\n([\s\S]*?)```/g)];
    const last = fences[fences.length - 1]?.[1];
    if (last && last.trim().length > 0) return last.trim();
  }
  return undefined;
}

export class AgentClient extends Context.Tag('cartis/AgentClient')<
  AgentClient,
  {
    createSession(title: string): Effect.Effect<string, AgentError>;
    prompt(sessionId: string, text: string): Effect.Effect<unknown, AgentError>;
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
    prompt: (sessionId, text) =>
      Effect.promise(() =>
        client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
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
      prompt: (sessionId, text) =>
        cached.pipe(Effect.flatMap((client) => agentClientFromSdk(client).prompt(sessionId, text))),
    });
  }),
);

/**
 * Run the card agent: create a session, prompt it with a 5s heartbeat, extract
 * the code. Log messages are preserved verbatim from today's source.
 */
export function runCardAgent(
  userPrompt: string,
  currentCode: string,
): Effect.Effect<string, AgentError, AgentClient | ActivityBus> {
  return Effect.gen(function* () {
    const agent = yield* AgentClient;
    const bus = yield* ActivityBus;
    const startedAt = yield* Clock.currentTimeMillis;
    const elapsed = Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.round((now - startedAt) / 1000)),
    );

    yield* bus.emit(
      'agent',
      `request: “${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '…' : ''}”`,
    );
    const id = yield* agent.createSession('cartis card edit');
    yield* bus.emit('agent', `session ${id} created — prompting model`);

    const promptWithHeartbeat = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          elapsed.pipe(
            Effect.flatMap((secs) => bus.emit('agent', `still generating… (${secs}s)`)),
            Effect.delay('5 seconds'),
            Effect.forever,
          ),
        );
        return yield* agent.prompt(id, buildAgentPrompt(userPrompt, currentCode));
      }),
    );
    const result = yield* promptWithHeartbeat;

    const code = extractCode(result);
    if (!code) return yield* Effect.fail(new AgentError({ reason: 'no-code' }));
    const secs = yield* elapsed;
    yield* bus.emit('agent', `done in ${secs}s — ${String(code.length)} chars of card code`);
    return code;
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
const decodeAgentCard = Schema.decodeUnknown(AgentCardRequest);
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

      // ----- /api/agent/card -----
      server.middlewares.use('/api/agent/card', (req, res) => {
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
            const { prompt, code } = yield* decodeAgentCard(body);
            const generated = yield* runCardAgent(prompt, code);
            return { code: generated };
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
              const { prompt, imageDataUrl, aspectRatio } = yield* decodeImageGenerate(body);
              const client = yield* ReplicateClient;
              const dataUrl = yield* client.generate(token, {
                prompt,
                imageDataUrl,
                aspectRatio,
              });
              return { dataUrl };
            }),
          );
        });
      });
    },
  };
}
