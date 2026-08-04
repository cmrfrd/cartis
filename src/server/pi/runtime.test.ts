import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makePiRuntime, parseModelRef } from './runtime';

const root = mkdtempSync(join(tmpdir(), 'pi-runtime-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parseModelRef', () => {
  it('parses provider/model and defaults when unset', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseModelRef('openai/gpt-5.2')).toEqual({ provider: 'openai', modelId: 'gpt-5.2' });
    expect(parseModelRef(undefined).provider).toBe('anthropic');
    expect(parseModelRef('  ').provider).toBe('anthropic');
  });

  it('rejects malformed refs', () => {
    expect(() => parseModelRef('nonsense')).toThrow(/provider\/model-id/);
    expect(() => parseModelRef('anthropic/')).toThrow(/provider\/model-id/);
  });
});

describe('makePiRuntime session cache (spec §2.1)', () => {
  it('caches SessionManagers per id and creates file-less sessions for unknown ids', async () => {
    const rt = makePiRuntime(root);
    const a1 = await rt.getSession('11111111-aaaa-bbbb-cccc-000000000001');
    const a2 = await rt.getSession('11111111-aaaa-bbbb-cccc-000000000001');
    expect(a1).toBe(a2); // long-lived cache — leaf state survives across turns
    expect(a1.getSessionId()).toBe('11111111-aaaa-bbbb-cccc-000000000001');
    // clean break: no file exists yet (pi buffers until first assistant reply)
  });

  it('reopens an existing session file found by its EXACT id portion', async () => {
    const chats = join(root, 'chats');
    mkdirSync(chats, { recursive: true });
    // a session written by a previous server run (header only)
    const header = {
      type: 'session',
      version: 3,
      id: 'existing-1',
      timestamp: new Date(0).toISOString(),
      cwd: root,
    };
    writeFileSync(
      join(chats, '2026-01-01T00-00-00-000Z_existing-1.jsonl'),
      `${JSON.stringify(header)}\n`,
    );
    // a suffix-collision decoy: id 'g-1' must NOT match 'existing-1'
    const rt = makePiRuntime(root);
    const sm = await rt.getSession('existing-1');
    expect(sm.getSessionId()).toBe('existing-1');
    const fresh = await rt.getSession('g-1');
    expect(fresh.getSessionId()).toBe('g-1'); // created fresh, not the decoy match
  });
});
