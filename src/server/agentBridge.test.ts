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
    const code = await runCardAgent(client, 'do a thing', 'old code');
    expect(code).toContain('function X');
    const call = promptSpy.mock.calls[0]?.[0] as
      | { path: { id: string }; body: { parts: { text: string }[] } }
      | undefined;
    expect(call?.path.id).toBe('session-1');
    expect(call?.body.parts[0]?.text).toContain('do a thing');
  });

  it('throws a clear error when the session has no id', async () => {
    const client: AgentClient = {
      session: { create: vi.fn(async () => ({})), prompt: vi.fn(async () => ({})) },
    };
    await expect(runCardAgent(client, 'p', 'c')).rejects.toThrow(/session/i);
  });
});

describe('generateWithReplicate', () => {
  it('POSTs the model, waits, and returns the fetched image as a data url', async () => {
    const imageBytes = new TextEncoder().encode('img').buffer as ArrayBuffer;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('predictions')) {
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer tok');
        expect(headers.Prefer).toBe('wait');
        const body = JSON.parse(String(init?.body)) as {
          input: { prompt: string; input_image: string };
        };
        expect(body.input.prompt).toBe('stylize me');
        expect(body.input.input_image.startsWith('data:')).toBe(true);
        return new Response(
          JSON.stringify({ status: 'succeeded', output: 'https://img.example/out.png' }),
        );
      }
      return new Response(imageBytes, { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const dataUrl = await generateWithReplicate(
      'tok',
      'stylize me',
      'data:image/png;base64,QQ==',
      fetchImpl,
    );
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('surfaces replicate errors with status detail', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      generateWithReplicate('bad', 'p', 'data:image/png;base64,QQ==', fetchImpl),
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
