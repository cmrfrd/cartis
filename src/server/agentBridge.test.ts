import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentClient } from './agentBridge';
import {
  buildAgentPrompt,
  extractCode,
  generateWithReplicate,
  readJson,
  runCardAgent,
} from './agentBridge';

describe('buildAgentPrompt', () => {
  it('embeds the guide, the user request, and the current code', () => {
    const prompt = buildAgentPrompt(
      'make it spooky',
      'export default function C() { return null }',
    );
    expect(prompt).toContain('cartis/cards');
    expect(prompt).toContain('make it spooky');
    expect(prompt).toContain('export default function C()');
    expect(prompt).toContain('default export');
  });
});

describe('extractCode', () => {
  it('prefers structured output when present', () => {
    const result = { data: { info: { structured_output: { code: 'export default 1' } } } };
    expect(extractCode(result)).toBe('export default 1');
  });

  it('falls back to the last tsx code fence in text parts', () => {
    const result = {
      data: {
        parts: [
          {
            type: 'text',
            text: 'Here you go:\n```tsx\nexport default function A() { return null }\n```',
          },
          {
            type: 'text',
            text: 'refined:\n```tsx\nexport default function B() { return null }\n```',
          },
        ],
      },
    };
    expect(extractCode(result)).toContain('function B');
  });

  it('returns undefined when nothing code-like exists', () => {
    expect(extractCode({ data: { parts: [{ type: 'text', text: 'no code' }] } })).toBeUndefined();
    expect(extractCode(undefined)).toBeUndefined();
  });
});

describe('runCardAgent', () => {
  it('creates a session, prompts it, and returns the extracted code', async () => {
    const promptSpy = vi.fn(async (_input: unknown) => ({
      data: {
        parts: [
          {
            type: 'text',
            text: '```tsx\nexport default function X() { return null }\n```',
          },
        ],
      },
    }));
    const client: AgentClient = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        prompt: promptSpy,
      },
    };
    const log: string[] = [];
    const code = await runCardAgent(client, 'do a thing', 'old code', (m) => log.push(m));
    expect(code).toContain('function X');
    const call = promptSpy.mock.calls[0]?.[0] as
      | { path: { id: string }; body: { parts: { text: string }[] } }
      | undefined;
    expect(call?.path.id).toBe('session-1');
    expect(call?.body.parts[0]?.text).toContain('do a thing');
    expect(log.some((m) => m.includes('session session-1 created'))).toBe(true);
    expect(log.some((m) => m.startsWith('done in'))).toBe(true);
  });

  it('throws a clear error when the session has no id', async () => {
    const client: AgentClient = {
      session: { create: vi.fn(async () => ({})), prompt: vi.fn(async () => ({})) },
    };
    await expect(runCardAgent(client, 'p', 'c', () => {})).rejects.toThrow(/session/i);
  });
});

describe('generateWithReplicate', () => {
  const instantSleep = async () => {};

  it('creates a prediction, polls to success, and logs progress', async () => {
    const imageBytes = new TextEncoder().encode('img').buffer as ArrayBuffer;
    let polls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok');
        const body = JSON.parse(String(init?.body)) as {
          input: { prompt: string; input_image: string };
        };
        expect(body.input.prompt).toBe('stylize me');
        expect(body.input.input_image.startsWith('data:')).toBe(true);
        return new Response(
          JSON.stringify({
            id: 'pred-1',
            status: 'starting',
            urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' },
          }),
        );
      }
      if (u.includes('/predictions/pred-1')) {
        polls++;
        return new Response(
          JSON.stringify(
            polls < 2
              ? { id: 'pred-1', status: 'processing' }
              : { id: 'pred-1', status: 'succeeded', output: 'https://img.example/out.png' },
          ),
        );
      }
      return new Response(imageBytes, { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const log: string[] = [];
    const dataUrl = await generateWithReplicate(
      'tok',
      'stylize me',
      'data:image/png;base64,QQ==',
      fetchImpl,
      (m) => log.push(m),
      instantSleep,
    );
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(log.some((m) => m.includes('prediction pred-1 created'))).toBe(true);
    expect(log.some((m) => m.includes('status: processing'))).toBe(true);
    expect(log.some((m) => m.includes('status: succeeded'))).toBe(true);
    expect(log.some((m) => m.includes('output downloaded'))).toBe(true);
  });

  it('surfaces failed predictions with their error detail', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'pred-2', status: 'starting', urls: { get: 'https://x/p/2' } }),
        );
      }
      return new Response(JSON.stringify({ id: 'pred-2', status: 'failed', error: 'nsfw block' }));
    }) as unknown as typeof fetch;
    await expect(
      generateWithReplicate(
        'tok',
        'p',
        'data:image/png;base64,QQ==',
        fetchImpl,
        () => {},
        instantSleep,
      ),
    ).rejects.toThrow(/nsfw block/);
  });

  it('surfaces replicate errors with status detail', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      generateWithReplicate(
        'bad',
        'p',
        'data:image/png;base64,QQ==',
        fetchImpl,
        () => {},
        instantSleep,
      ),
    ).rejects.toThrow(/401/);
  });
});

describe('readJson', () => {
  it('parses a streamed JSON body', async () => {
    const stream = new PassThrough();
    const parsed = readJson(stream);
    stream.end(JSON.stringify({ hello: 'cartis' }));
    await expect(parsed).resolves.toEqual({ hello: 'cartis' });
  });
});
