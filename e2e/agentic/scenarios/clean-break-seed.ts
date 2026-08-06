import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario } from '../types.ts';

const LEGACY_ID = 'ses_0378oldopencodeid42XYZ';

/**
 * The migration's clean-break promise, mechanically checked: a seeded card
 * carries an opencode-era chatSessionId with NO session file. Opening it
 * starts a FRESH conversation, and the first turn mints a pi session file
 * UNDER THE SAME id (missing file → fresh session, same pointer).
 */
export const cleanBreakSeed: Scenario = {
  id: 'clean-break-seed',
  title: 'Old opencode-id cards open fresh; first turn mints a pi session under the same id',
  timeoutMin: 8,
  seed: 'legacy-card',
  objective:
    "In the card app at {{APP_URL}}, open the Gallery tab, open the card named 'Legacy Hero', " +
    'then send the chat message "rename this card to Reborn" and wait for the reply.',
  constraints: ['Use ONLY the chat sidebar for the rename.'],
  criteria: [
    {
      kind: 'page',
      label: 'the rename landed (chat works on the legacy card)',
      script: '() => document.querySelector(\'aside input[type="text"]\')?.value ?? null',
      expect: (r) => r === 'Reborn',
    },
    {
      kind: 'page',
      label: 'fresh conversation — no ghost history before the user bubble',
      script:
        '() => { const groups = Array.from(document.querySelectorAll(\'[data-testid="chat-panel"] .group\')); return { count: groups.length, firstHasUserText: (groups[0]?.textContent ?? "").includes("rename this card to Reborn") }; }',
      expect: (r) => {
        const v = r as { count?: number; firstHasUserText?: boolean };
        return (v.count ?? 0) >= 2 && v.firstHasUserText === true;
      },
    },
    {
      kind: 'fs',
      label: 'a pi session file was minted UNDER THE LEGACY id',
      check: (dataRoot) => {
        try {
          return readdirSync(join(dataRoot, 'chats')).some((f) =>
            f.endsWith(`_${LEGACY_ID}.jsonl`),
          );
        } catch {
          return false;
        }
      },
    },
    {
      kind: 'fs',
      label: 'the seeded sidecar still points at the same chatSessionId',
      check: (dataRoot) => {
        try {
          const card = JSON.parse(
            readFileSync(join(dataRoot, 'cards', 'legacy-hero-abc123.json'), 'utf8'),
          ) as { chatSessionId?: string };
          return card.chatSessionId === LEGACY_ID;
        } catch {
          return false;
        }
      },
    },
  ],
};
