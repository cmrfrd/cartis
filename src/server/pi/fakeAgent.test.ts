/**
 * The scripted fake agent, full loop (Track B seam): the REAL agent loop +
 * REAL tool validation over the keyword-rule faux model. Also the canary for
 * the two 0.83.0 assumptions the seam rests on — the response factory
 * receives the conversation Context, and appendResponses re-arming keeps a
 * long-lived server supplied.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatTurnRequestT } from '@/contracts/api';
import { fakeAgentRuntime } from './fakeAgent';
import { makePiRuntime, type PiRuntime } from './runtime';
import { runTurn } from './turn';

const root = mkdtempSync(join(tmpdir(), 'pi-fake-agent-test-'));
let rt: PiRuntime;

beforeAll(async () => {
  rt = makePiRuntime(root, { modelRuntime: await fakeAgentRuntime() });
  process.env.CARTIS_MODEL = 'faux/faux-model';
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const req = (userPrompt: string, over: Partial<ChatTurnRequestT> = {}): ChatTurnRequestT => ({
  sessionId: undefined,
  themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
  fields: [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
  ],
  currentData: { name: 'Nyra' },
  currentArtFileName: undefined,
  userPrompt,
  docContext: {
    themeId: 'arcane',
    themeOptions: ['arcane'],
    layoutId: 'classic',
    layoutOptions: ['classic', 'fullart'],
    holo: false,
    artAspect: 'auto',
    aspectOptions: ['auto', '1:1'],
  },
  ...over,
});

const io = { emit: () => {}, log: () => {} };

describe('fakeAgentRuntime (full loop)', () => {
  it('rename rule extracts the name into a REAL validated card_patch', async () => {
    const out = await runTurn(rt, req('rename this card to Probe'), io);
    expect(out.toolCalls).toEqual([{ name: 'card_patch', args: { name: 'Probe' } }]);
    expect(out.reply).toBe('Done — applied your changes.');
    expect(out.toolErrors).toEqual([]);
  });

  it('rules compose: rename + save + export print + full art in one prompt', async () => {
    const out = await runTurn(
      rt,
      req('rename this card to Keeper, save it and export print, full art please'),
      io,
    );
    expect(out.toolCalls).toEqual([
      { name: 'card_patch', args: { name: 'Keeper' } },
      { name: 'card_save', args: {} },
      { name: 'card_export', args: { target: 'print' } },
      { name: 'card_set_layout', args: { layoutId: 'fullart' } },
    ]);
  });

  it('INVALID_ARGS_PLEASE hits REAL validation: toolErrors, turn completes', async () => {
    const out = await runTurn(rt, req('INVALID_ARGS_PLEASE'), io);
    expect(out.toolCalls).toEqual([]); // rejected — never a validated intent
    expect(out.toolErrors.length).toBeGreaterThan(0);
    expect(out.toolErrors[0]?.name).toBe('card_patch');
    expect(out.reply).toContain('out of range');
  });

  it('re-arms forever: sequential turns in one session all answer', async () => {
    const first = await runTurn(rt, req('hello there'), io);
    expect(first.reply).toBe('Understood.');
    const second = await runTurn(
      rt,
      req('rename this card to Again', { sessionId: first.sessionId as never }),
      io,
    );
    expect(second.toolCalls).toEqual([{ name: 'card_patch', args: { name: 'Again' } }]);
    const third = await runTurn(
      rt,
      req('and hello again', { sessionId: first.sessionId as never }),
      io,
    );
    expect(third.reply).toBe('Understood.');
  });

  it('SLOW_TURN_PLEASE takes ≥1s (busy strip observable)', async () => {
    const start = Date.now();
    const out = await runTurn(rt, req('SLOW_TURN_PLEASE'), io);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
    expect(out.reply).toBe('Understood.');
  });
});
