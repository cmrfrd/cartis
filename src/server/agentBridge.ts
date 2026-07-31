import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { bytesToDataUrl } from '../images/codec.ts';

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
): Promise<string> {
  const created = await client.session.create({ body: { title: 'cartis card edit' } });
  const createdData = rec(rec(created)?.data) ?? rec(created);
  const id = typeof createdData?.id === 'string' ? createdData.id : undefined;
  if (!id) throw new Error('opencode session did not return an id');
  const result = await client.session.prompt({
    path: { id },
    body: {
      parts: [{ type: 'text', text: buildAgentPrompt(userPrompt, currentCode) }],
    },
  });
  const code = extractCode(result);
  if (!code) throw new Error('agent returned no code');
  return code;
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

export async function generateWithReplicate(
  token: string,
  prompt: string,
  imageDataUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const started = await fetchImpl(REPLICATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input: { prompt, input_image: imageDataUrl, output_format: 'png' } }),
  });
  if (!started.ok) {
    throw new Error(`replicate error ${String(started.status)}: ${await started.text()}`);
  }
  const prediction = rec(await started.json());
  const output = prediction?.output;
  const url =
    typeof output === 'string'
      ? output
      : Array.isArray(output) && typeof output[0] === 'string'
        ? output[0]
        : undefined;
  if (!url) {
    throw new Error(`replicate returned no output (status ${String(prediction?.status)})`);
  }
  const image = await fetchImpl(url);
  const bytes = await image.arrayBuffer();
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

export function cartisBridge(): Plugin {
  return {
    name: 'cartis-bridge',
    configureServer(server) {
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
          );
          return { dataUrl };
        });
      });
    },
  };
}
