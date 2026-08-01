import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { bytesToDataUrl } from '../images/codec.ts';
import { activityHistory, emitActivity, subscribeActivity } from './activity.ts';
import type { StoredRecord, StoreName } from './fileStore.ts';
import { deleteRecord, listRecords, putRecord, readStoredFile } from './fileStore.ts';

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

export interface AgentClient {
  session: {
    create(input: { body: { title: string } }): Promise<unknown>;
    prompt(input: unknown): Promise<unknown>;
  };
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

export function extractCode(result: unknown): string | undefined {
  const data = rec(rec(result)?.data) ?? rec(result);
  const structured = rec(rec(data?.info)?.structured_output) ?? rec(data?.structured_output);
  if (typeof structured?.code === 'string' && structured.code.trim().length > 0) {
    return structured.code;
  }
  const parts = data?.parts;
  if (Array.isArray(parts)) {
    let text = '';
    for (const part of parts) {
      const p = rec(part);
      if (p?.type === 'text' && typeof p.text === 'string') text += `\n${p.text}`;
    }
    const fences = [...text.matchAll(/```(?:tsx|jsx|typescript|ts)?\n([\s\S]*?)```/g)];
    const last = fences[fences.length - 1]?.[1];
    if (last && last.trim().length > 0) return last.trim();
  }
  return undefined;
}

export async function runCardAgent(
  client: AgentClient,
  userPrompt: string,
  currentCode: string,
  log: (message: string) => void = (m) => emitActivity('agent', m),
): Promise<string> {
  const startedAt = Date.now();
  log(`request: “${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '…' : ''}”`);
  const created = await client.session.create({ body: { title: 'cartis card edit' } });
  const createdData = rec(rec(created)?.data) ?? rec(created);
  const id = typeof createdData?.id === 'string' ? createdData.id : undefined;
  if (!id) throw new Error('opencode session did not return an id');
  log(`session ${id} created — prompting model`);
  const heartbeat = setInterval(() => {
    log(`still generating… (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }, 5000);
  try {
    const result = await client.session.prompt({
      path: { id },
      body: {
        parts: [{ type: 'text', text: buildAgentPrompt(userPrompt, currentCode) }],
      },
    });
    const code = extractCode(result);
    if (!code) throw new Error('agent returned no code');
    log(
      `done in ${Math.round((Date.now() - startedAt) / 1000)}s — ${String(code.length)} chars of card code`,
    );
    return code;
  } finally {
    clearInterval(heartbeat);
  }
}

let agentClient: Promise<AgentClient> | undefined;

/** Lazy singleton: spawns `opencode` on first use so `bun run dev` stays fast without it. */
function getAgentClient(): Promise<AgentClient> {
  agentClient ??= (async () => {
    const sdk = await import('@opencode-ai/sdk');
    const model = process.env.OPENCODE_MODEL;
    const { client } = await sdk.createOpencode(model ? { config: { model } } : {});
    return client as unknown as AgentClient;
  })();
  return agentClient;
}

// ---------- replicate ----------

const REPLICATE_URL =
  'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

function outputUrlOf(prediction: Record<string, unknown> | undefined): string | undefined {
  const output = prediction?.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
  return undefined;
}

/** Create-and-poll (not Prefer:wait) so progress is observable while it runs. */
export async function generateWithReplicate(
  token: string,
  prompt: string,
  imageDataUrl: string,
  aspectRatio = 'match_input_image',
  fetchImpl: typeof fetch = fetch,
  log: (message: string) => void = (m) => emitActivity('image', m),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const startedAt = Date.now();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  log(`sending photo + prompt to replicate (flux-kontext-pro, ${aspectRatio})`);
  const created = await fetchImpl(REPLICATE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input: {
        prompt,
        input_image: imageDataUrl,
        output_format: 'png',
        aspect_ratio: aspectRatio,
      },
    }),
  });
  if (!created.ok) {
    throw new Error(`replicate error ${String(created.status)}: ${await created.text()}`);
  }
  let prediction = rec(await created.json());
  const pollUrl =
    typeof rec(prediction?.urls)?.get === 'string'
      ? String(rec(prediction?.urls)?.get)
      : `https://api.replicate.com/v1/predictions/${String(prediction?.id ?? '')}`;
  log(`prediction ${String(prediction?.id ?? '?')} created`);
  let lastStatus = '';
  while (true) {
    const status = String(prediction?.status ?? 'unknown');
    if (status !== lastStatus) {
      lastStatus = status;
      log(`status: ${status} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
    if (status === 'succeeded') break;
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`replicate ${status}: ${String(prediction?.error ?? 'no detail')}`);
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error('replicate timed out after 120s');
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = await fetchImpl(pollUrl, { headers });
    if (!polled.ok) {
      throw new Error(`replicate poll error ${String(polled.status)}`);
    }
    prediction = rec(await polled.json());
  }
  const url = outputUrlOf(prediction);
  if (!url) {
    throw new Error('replicate succeeded but returned no output');
  }
  const image = await fetchImpl(url);
  const bytes = await image.arrayBuffer();
  log(
    `output downloaded (${String(Math.round(bytes.byteLength / 1024))}KB) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  return bytesToDataUrl(bytes, image.headers.get('content-type') ?? 'image/png');
}

// ---------- http plumbing ----------

export function readJson(req: {
  on(event: string, cb: (chunk?: unknown) => void): unknown;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    req.on('error', (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))));
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

async function respondWith(res: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await work());
  } catch (cause) {
    sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
}

const DATA_ROOT = 'cartis-data';
const STORES: readonly StoreName[] = ['images', 'cards', 'exports'];

function parseStorePath(url: string): { store: StoreName; rest: string } | undefined {
  const [path = ''] = url.split('?');
  const segments = path.split('/').filter((s) => s.length > 0);
  const store = STORES.find((name) => name === segments[0]);
  if (!store) return undefined;
  return { store, rest: decodeURIComponent(segments.slice(1).join('/')) };
}

export function cartisBridge(): Plugin {
  return {
    name: 'cartis-bridge',
    configureServer(server) {
      // file-backed persistence: real files under ./cartis-data
      server.middlewares.use('/api/store', (req, res) => {
        const parsed = parseStorePath(req.url ?? '');
        const sres = res as ServerResponse;
        if (!parsed) {
          sendJson(sres, 404, { error: 'unknown store' });
          return;
        }
        void respondWith(sres, async () => {
          if (req.method === 'GET') return await listRecords(DATA_ROOT, parsed.store);
          if (req.method === 'PUT') {
            const body = rec(await readJson(req)) ?? {};
            const record = rec(body.record);
            if (!record || typeof record.id !== 'string') throw new Error('record.id required');
            return await putRecord(
              DATA_ROOT,
              parsed.store,
              record as StoredRecord,
              typeof body.bytesBase64 === 'string' ? body.bytesBase64 : undefined,
            );
          }
          if (req.method === 'DELETE' && parsed.rest.length > 0) {
            await deleteRecord(DATA_ROOT, parsed.store, parsed.rest);
            return { ok: true };
          }
          throw new Error(`unsupported ${String(req.method)} on /api/store`);
        });
      });
      server.middlewares.use('/files', (req, res) => {
        const parsed = parseStorePath(req.url ?? '');
        const sres = res as ServerResponse;
        void (async () => {
          const file = parsed
            ? await readStoredFile(DATA_ROOT, parsed.store, parsed.rest)
            : undefined;
          if (!file) {
            sendJson(sres, 404, { error: 'not found' });
            return;
          }
          sres.statusCode = 200;
          sres.setHeader('Content-Type', file.type);
          sres.end(file.bytes);
        })();
      });
      server.middlewares.use('/api/activity', (req, res) => {
        const sse = res as ServerResponse;
        sse.statusCode = 200;
        sse.setHeader('Content-Type', 'text/event-stream');
        sse.setHeader('Cache-Control', 'no-cache');
        sse.setHeader('Connection', 'keep-alive');
        for (const event of activityHistory().slice(-50)) {
          sse.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        const stop = subscribeActivity((event) => {
          sse.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        req.on('close', stop);
      });
      server.middlewares.use('/api/status', (_req, res) => {
        sendJson(res as ServerResponse, 200, {
          image: process.env.REPLICATE_API_TOKEN ? 'replicate' : 'stub',
        });
      });
      server.middlewares.use('/api/agent/card', (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res as ServerResponse, 405, { error: 'POST only' });
          return;
        }
        void respondWith(res as ServerResponse, async () => {
          const body = rec(await readJson(req)) ?? {};
          const code = await runCardAgent(
            await getAgentClient(),
            String(body.prompt ?? ''),
            String(body.code ?? ''),
          );
          return { code };
        });
      });
      server.middlewares.use('/api/image/generate', (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res as ServerResponse, 405, { error: 'POST only' });
          return;
        }
        const token = process.env.REPLICATE_API_TOKEN;
        if (!token) {
          sendJson(res as ServerResponse, 503, {
            error: 'REPLICATE_API_TOKEN not set — using stub locally',
          });
          return;
        }
        void respondWith(res as ServerResponse, async () => {
          const body = rec(await readJson(req)) ?? {};
          const dataUrl = await generateWithReplicate(
            token,
            String(body.prompt ?? ''),
            String(body.imageDataUrl ?? ''),
            typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
          );
          return { dataUrl };
        });
      });
    },
  };
}
