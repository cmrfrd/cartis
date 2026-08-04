/**
 * Full-loop turn tests (migration spec §8.2): scripted faux provider drives
 * the REAL pi agent loop + REAL tool validation + REAL SessionManager
 * persistence. Deterministic, no network.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatTurnRequestT } from '@/contracts/api';
import type { ThreadEventT } from '@/contracts/thread';
import { fauxAssistantMessage, fauxRuntime, fauxText, fauxToolCall } from './faux';
import { makePiRuntime, type PiRuntime } from './runtime';
import { runTurn, TurnBusyError } from './turn';

const root = mkdtempSync(join(tmpdir(), 'pi-turn-test-'));
let rt: PiRuntime;
let faux: Awaited<ReturnType<typeof fauxRuntime>>;

beforeAll(async () => {
  faux = await fauxRuntime();
  rt = makePiRuntime(root, { modelRuntime: faux.modelRuntime });
  process.env.CARTIS_MODEL = 'faux/faux-model';
});
afterAll(() => {
  process.env.CARTIS_MODEL = undefined as unknown as string;
  rmSync(root, { recursive: true, force: true });
});

const req = (over: Partial<ChatTurnRequestT> = {}): ChatTurnRequestT => ({
  sessionId: undefined,
  themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
  fields: [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
  ],
  currentData: { name: 'Nyra' },
  currentArtFileName: undefined,
  userPrompt: 'rename him to Tinker',
  ...over,
});

const io = (events: ThreadEventT[] = [], logs: string[] = []) => ({
  emit: (e: ThreadEventT) => void events.push(e),
  log: (m: string) => void logs.push(m),
});

describe('runTurn (full loop, faux provider)', () => {
  it('happy turn: validated calls in canonical order, entry ids from the branch tail', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('card_patch', { name: 'Tinker' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('card_save', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Renamed and saved.')]),
    ]);
    const events: ThreadEventT[] = [];
    const out = await runTurn(rt, req(), io(events));
    expect(out.reply).toBe('Renamed and saved.');
    expect(out.toolCalls).toEqual([
      { name: 'card_patch', args: { name: 'Tinker' } },
      { name: 'card_save', args: {} },
    ]);
    expect(out.toolErrors).toEqual([]);
    expect(out.userEntryId).toMatch(/^[0-9a-f]{8}$/); // pi 8-hex entry ids
    expect(out.assistantEntryId).toMatch(/^[0-9a-f]{8}$/);
    // live SSE mapping ran: a TurnStarted + at least one ToolCall part
    expect(events.some((e) => e._tag === 'TurnStarted')).toBe(true);
    expect(events.some((e) => e._tag === 'PartDelta' && e.part._tag === 'ToolCall')).toBe(true);
    // turn_meta persisted, keyed to the user entry
    const sm = await rt.getSession(out.sessionId);
    const meta = (
      sm.getBranch() as unknown as {
        type: string;
        customType?: string;
        data?: { userEntryId?: string };
      }[]
    )
      .filter((e) => e.type === 'custom' && e.customType === 'turn_meta')
      .at(-1);
    expect(meta?.data?.userEntryId).toBe(out.userEntryId);
  });

  it('validation failure: invalid args become toolErrors, valid retry still applies', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 999 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 5 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Cost set.')]),
    ]);
    const out = await runTurn(rt, req(), io());
    expect(out.toolCalls).toEqual([{ name: 'card_patch', args: { cost: 5 } }]);
    expect(out.toolErrors.length).toBeGreaterThan(0);
    expect(out.toolErrors[0]?.name).toBe('card_patch');
  });

  it('a reply-only turn is valid (no tools called)', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('Which essence should he have?')])]);
    const out = await runTurn(rt, req({ userPrompt: 'thoughts?' }), io());
    expect(out.reply).toBe('Which essence should he have?');
    expect(out.toolCalls).toEqual([]);
  });

  it('busy gate: a second concurrent turn on the same session is rejected', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage([fauxText('slow reply')]);
      },
      fauxAssistantMessage([fauxText('second')]),
    ]);
    const sessionId = crypto.randomUUID();
    const first = runTurn(rt, req({ sessionId: sessionId as never }), io());
    await new Promise((r) => setTimeout(r, 50)); // let the first turn register
    await expect(runTurn(rt, req({ sessionId: sessionId as never }), io())).rejects.toBeInstanceOf(
      TurnBusyError,
    );
    release?.();
    const out = await first;
    expect(out.reply).toBe('slow reply');
  });

  it('turns accumulate in ONE session file (same id across turns)', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('one')])]);
    const first = await runTurn(rt, req(), io());
    faux.setResponses([fauxAssistantMessage([fauxText('two')])]);
    const second = await runTurn(rt, req({ sessionId: first.sessionId as never }), io());
    expect(second.sessionId).toBe(first.sessionId);
    const sm = await rt.getSession(first.sessionId);
    const users = (
      sm.getBranch() as unknown as { type: string; message?: { role?: string } }[]
    ).filter((e) => e.type === 'message' && e.message?.role === 'user');
    expect(users.length).toBe(2);
  });
});
