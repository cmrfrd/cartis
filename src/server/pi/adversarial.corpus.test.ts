/**
 * Adversarial tool-call corpus (test-hardening spec §Track A, revised).
 *
 * THE BUG→FIXTURE RULE: every live-caught model misbehavior is appended here
 * as a scripted faux sequence with a `caught` date — permanent, verbatim in
 * spirit, running through the REAL pi agent loop (real tool validation, real
 * persistence, real event mapping). Entries assert the STRUCTURED outcome
 * (toolCalls, toolErrors, reply, persisted entries) — never just "doesn't
 * throw".
 *
 * The v1 JSON-transport corpus this replaces had samples like unescaped
 * quotes breaking the transport — that whole class is structural now (no
 * model output is parsed as JSON), and the unicode/quotes entry below proves
 * it STAYS structural.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatTurnRequestT } from '@/contracts/api';
import { mapSessionEntries } from './entries';
import { fauxAssistantMessage, fauxRuntime, fauxText, fauxToolCall } from './faux';
import { makePiRuntime, type PiRuntime } from './runtime';
import { runTurn, type TurnResult } from './turn';

const root = mkdtempSync(join(tmpdir(), 'pi-corpus-test-'));
let rt: PiRuntime;
let faux: Awaited<ReturnType<typeof fauxRuntime>>;

beforeAll(async () => {
  faux = await fauxRuntime();
  rt = makePiRuntime(root, { modelRuntime: faux.modelRuntime });
  process.env.CARTIS_MODEL = 'faux/faux-model';
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const req = (over: Partial<ChatTurnRequestT> = {}): ChatTurnRequestT => ({
  sessionId: undefined,
  themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
  fields: [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    { kind: 'select', key: 'essence', label: 'Essence', options: ['ember', 'tide'] },
    { kind: 'toggle', key: 'showStats', label: 'Stats' },
  ],
  currentData: { name: 'Nyra' },
  currentArtFileName: undefined,
  userPrompt: 'corpus entry',
  ...over,
});

const io = { emit: () => {}, log: () => {} };

// A ~50KB reply — size classes have broken transports before; prove the
// tool-call world carries them intact through persistence.
const HUGE_REPLY = `The saga begins. ${'Lore and legend, verse upon verse. '.repeat(1500)}The end.`;

// Quote/unicode-heavy strings — the OLD goblin class (live-caught 2026-08-03
// as a transport-JSON killer). Structural non-event now; this entry keeps it
// one forever.
const HOSTILE_TEXT = `He said "I meant to do that." — then 'laughed' \\ hard {"reply": "fake"} 🜲✶🎏`;

interface CorpusEntry {
  name: string;
  /** Date the class was live-caught, when it was. */
  caught?: string;
  responses: Parameters<typeof faux.setResponses>[0];
  reqOver?: Partial<ChatTurnRequestT>;
  expect: (out: TurnResult) => void | Promise<void>;
}

const ENTRIES: CorpusEntry[] = [
  {
    name: 'off-range number arg → toolError, valid retry applies (the Tinker class)',
    caught: '2026-08-03',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 999 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 5 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Cost set.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([{ name: 'card_patch', args: { cost: 5 } }]);
      expect(out.toolErrors.length).toBeGreaterThan(0);
      expect(out.toolErrors[0]?.name).toBe('card_patch');
    },
  },
  {
    name: 'unknown patch key (additionalProperties) → rejected, retry lands',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { hacker: 'x', name: 'Vorak' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('card_patch', { name: 'Vorak' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Renamed.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([{ name: 'card_patch', args: { name: 'Vorak' } }]);
      expect(out.toolErrors.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'wrong-type args (string cost, string holo) → rejected',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 'five' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Hm, that did not work.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([]);
      expect(out.toolErrors.length).toBeGreaterThan(0);
      expect(out.reply).toBe('Hm, that did not work.');
    },
  },
  {
    name: 'off-list select value → rejected (essence: plasma)',
    caught: '2026-08-03',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { essence: 'plasma' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('card_patch', { essence: 'tide' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Tide it is.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([{ name: 'card_patch', args: { essence: 'tide' } }]);
      expect(out.toolErrors.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'invalid layoutId → rejected (Literal-union schema)',
    reqOver: {
      docContext: {
        themeId: 'arcane',
        themeOptions: ['arcane'],
        layoutId: 'classic',
        layoutOptions: ['classic', 'fullart'],
        holo: false,
        artAspect: 'auto',
        aspectOptions: ['auto', '1:1', '3:2'],
      },
    },
    responses: [
      fauxAssistantMessage([fauxToolCall('card_set_layout', { layoutId: 'landscape' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('card_set_layout', { layoutId: 'fullart' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Switched.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([{ name: 'card_set_layout', args: { layoutId: 'fullart' } }]);
      expect(out.toolErrors.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'tool-only turn with an EMPTY final reply is valid',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_save', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([{ name: 'card_save', args: {} }]);
      expect(out.reply).toBe('');
      expect(out.toolErrors).toEqual([]);
    },
  },
  {
    name: 'reply-only turn (no tools) is valid',
    responses: [fauxAssistantMessage([fauxText('Just thinking out loud.')])],
    expect: (out) => {
      expect(out.toolCalls).toEqual([]);
      expect(out.reply).toBe('Just thinking out loud.');
    },
  },
  {
    name: 'the same tool twice in one turn → both intents in canonical order',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { name: 'First' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('card_patch', { cost: 2 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('Two edits.')]),
    ],
    expect: (out) => {
      expect(out.toolCalls).toEqual([
        { name: 'card_patch', args: { name: 'First' } },
        { name: 'card_patch', args: { cost: 2 } },
      ]);
    },
  },
  {
    name: 'a ~50KB reply survives persistence + rehydration intact',
    responses: [fauxAssistantMessage([fauxText(HUGE_REPLY)])],
    expect: async (out) => {
      expect(out.reply).toBe(HUGE_REPLY.trim());
      const messages = mapSessionEntries(await rt.getSession(out.sessionId));
      const assistant = messages.at(-1);
      expect(assistant?.parts.some((p) => p._tag === 'Text' && p.text === HUGE_REPLY.trim())).toBe(
        true,
      );
    },
  },
  {
    name: 'quote/unicode/JSON-lookalike text intact end-to-end (the goblin class)',
    caught: '2026-08-03',
    responses: [
      fauxAssistantMessage([fauxToolCall('card_patch', { name: HOSTILE_TEXT.slice(0, 20) })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText(HOSTILE_TEXT)]),
    ],
    expect: async (out) => {
      expect(out.reply).toBe(HOSTILE_TEXT.trim());
      expect(out.toolCalls[0]?.args.name).toBe(HOSTILE_TEXT.slice(0, 20));
      const messages = mapSessionEntries(await rt.getSession(out.sessionId));
      const assistant = messages.at(-1);
      expect(
        assistant?.parts.some((p) => p._tag === 'Text' && p.text === HOSTILE_TEXT.trim()),
      ).toBe(true);
    },
  },
  {
    name: 'a model-side error stop finishes the turn without phantom intents',
    responses: [
      fauxAssistantMessage([fauxText('partial…')], {
        stopReason: 'error',
        errorMessage: 'model exploded',
      }),
    ],
    expect: (out) => {
      // No tools ran; the turn resolves with whatever text landed. The
      // incomplete status is the ENTRY-level record (stopReason persists).
      expect(out.toolCalls).toEqual([]);
    },
  },
];

describe('adversarial tool-call corpus (full loop, faux provider)', () => {
  for (const entry of ENTRIES) {
    it(entry.name, async () => {
      faux.setResponses(entry.responses);
      const out = await runTurn(rt, req(entry.reqOver), io);
      await entry.expect(out);
    });
  }
});
