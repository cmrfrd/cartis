/**
 * Full-loop history/tree tests (spec §8.2): real turns via the faux provider,
 * then mapping + anchors + durable switching against the REAL persisted tree.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatTurnRequestT } from '@/contracts/api';
import { computeAnchors, mapSessionEntries, switchBranch } from './entries';
import { fauxAssistantMessage, fauxRuntime, fauxText, fauxToolCall } from './faux';
import { makePiRuntime, type PiRuntime } from './runtime';
import { runTurn } from './turn';

const root = mkdtempSync(join(tmpdir(), 'pi-entries-test-'));
let rt: PiRuntime;
let faux: Awaited<ReturnType<typeof fauxRuntime>>;

beforeAll(async () => {
  faux = await fauxRuntime();
  rt = makePiRuntime(root, { modelRuntime: faux.modelRuntime });
  process.env.CARTIS_MODEL = 'faux/faux-model';
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const req = (over: Partial<ChatTurnRequestT> = {}): ChatTurnRequestT => ({
  sessionId: undefined,
  themeContext: { lookAndFeel: 'oil', palette: '', argumentSummary: 'name' },
  fields: [{ kind: 'text', key: 'name', label: 'Name' }],
  currentData: { name: 'Nyra' },
  currentArtFileName: undefined,
  userPrompt: 'first message',
  ...over,
});

const io = { emit: () => {}, log: () => {} };

describe('mapSessionEntries + anchors + durable switch (full loop)', () => {
  it('maps a tool turn into one merged assistant message with joined results', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('card_patch', { name: 'Tinker' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('Renamed.')]),
    ]);
    const out = await runTurn(rt, req(), io);
    const sm = await rt.getSession(out.sessionId);
    const messages = mapSessionEntries(sm);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'first message' });
    expect(messages[0]?.id).toBe(out.userEntryId);
    const assistant = messages[1];
    expect(assistant?.id).toBe(out.assistantEntryId); // re-key agreement
    const tool = assistant?.parts.find((p) => p._tag === 'ToolCall');
    expect(tool?._tag === 'ToolCall' ? tool.status : undefined).toBe('completed');
    expect(assistant?.parts.some((p) => p._tag === 'Text' && p.text === 'Renamed.')).toBe(true);
  });

  it('strips inlined <file> blocks and renders File parts from turn_meta', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('Read it.')])]);
    const lore = Buffer.from('ancient lore here', 'utf8').toString('base64');
    const out = await runTurn(
      rt,
      req({
        userPrompt: 'use this lore',
        attachments: [
          {
            name: 'lore.txt' as never,
            mime: 'text/plain' as never,
            dataUrl: `data:text/plain;base64,${lore}` as never,
          },
        ],
      }),
      io,
    );
    const messages = mapSessionEntries(await rt.getSession(out.sessionId));
    const user = messages[0];
    expect(user?.parts.map((p) => p._tag)).toEqual(['File', 'Text']);
    expect(user?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'use this lore' });
  });

  it('edit creates a sibling branch; anchors expose ‹n/m›; switch is DURABLE across reopen', async () => {
    // Turn 1 on a fresh session.
    faux.setResponses([fauxAssistantMessage([fauxText('reply one')])]);
    const first = await runTurn(rt, req({ userPrompt: 'original message' }), io);
    // Edit that user message → sibling branch.
    faux.setResponses([fauxAssistantMessage([fauxText('reply two')])]);
    const second = await runTurn(
      rt,
      req({ sessionId: first.sessionId as never, userPrompt: 'edited message' }),
      io,
      { kind: 'edit', targetUserEntryId: first.userEntryId },
    );
    const sm = await rt.getSession(first.sessionId);
    // Active branch is the EDITED one.
    let messages = mapSessionEntries(sm);
    expect(messages[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'edited message' });
    // Anchors: 2 siblings, active is #2 (file order).
    const anchors = computeAnchors(sm);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.count).toBe(2);
    expect(anchors[0]?.index).toBe(2);
    expect(anchors[0]?.messageId).toBe(second.userEntryId);
    // Switch to sibling #1 and REOPEN the file — the blocker-1 regression.
    const originalLeaf = anchors[0]?.siblingLeafIds[0] as string;
    switchBranch(sm, originalLeaf);
    messages = mapSessionEntries(sm);
    expect(messages[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'original message' });
    const { pi } = await rt.deps();
    const reopened = pi.SessionManager.open(sm.getSessionFile() as string, rt.chatsDir, root);
    const reopenedMessages = mapSessionEntries(reopened);
    expect(reopenedMessages[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'original message' });
    const reopenedAnchors = computeAnchors(reopened);
    expect(reopenedAnchors[0]?.index).toBe(1); // now on sibling #1, durably
  });

  it('regenerate replays the stored user text on a new branch', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('take one')])]);
    const first = await runTurn(rt, req({ userPrompt: 'make him cooler' }), io);
    faux.setResponses([fauxAssistantMessage([fauxText('take two')])]);
    const second = await runTurn(
      rt,
      req({ sessionId: first.sessionId as never, userPrompt: 'IGNORED' }),
      io,
      { kind: 'regenerate' },
    );
    const messages = mapSessionEntries(await rt.getSession(first.sessionId));
    // Same user text replayed; new assistant reply active.
    expect(messages[0]?.parts.at(-1)).toEqual({ _tag: 'Text', text: 'make him cooler' });
    expect(messages[1]?.parts.some((p) => p._tag === 'Text' && p.text === 'take two')).toBe(true);
    expect(second.userEntryId).not.toBe(first.userEntryId); // duplicated on a new branch
  });
});
