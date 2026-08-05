import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario } from '../types.ts';

const cardSidecars = (dataRoot: string): Array<{ name?: string; chatSessionId?: string }> => {
  try {
    return readdirSync(join(dataRoot, 'cards'))
      .filter((f) => f.endsWith('.json'))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(dataRoot, 'cards', f), 'utf8')) as {
            name?: string;
            chatSessionId?: string;
          },
      );
  } catch {
    return [];
  }
};

/** The agent's document powers, end to end through a real conversation. */
export const docPowers: Scenario = {
  id: 'doc-powers',
  title: 'Rename, save, export print, switch to full art — all by conversation',
  timeoutMin: 10,
  objective:
    'In the card app at {{APP_URL}}/builder, use the chat sidebar to ask the assistant — in one or ' +
    "several messages — to rename the card to 'Canary Knight', save it, export a print PNG, and " +
    'switch to the full art layout. Wait for each reply to finish before the next message.',
  constraints: ['Use ONLY the chat sidebar — do not click Save or the export buttons yourself.'],
  criteria: [
    {
      kind: 'fs',
      label: 'one card sidecar named Canary Knight with a chatSessionId',
      check: (dataRoot) => {
        const cards = cardSidecars(dataRoot).filter((c) => c.name === 'Canary Knight');
        return cards.length === 1 && typeof cards[0]?.chatSessionId === 'string';
      },
    },
    {
      kind: 'fs',
      label: 'a pi session file exists for that chatSessionId',
      check: (dataRoot) => {
        const card = cardSidecars(dataRoot).find((c) => c.name === 'Canary Knight');
        const id = card?.chatSessionId;
        if (id === undefined) return false;
        try {
          return readdirSync(join(dataRoot, 'chats')).some((f) => f.endsWith(`_${id}.jsonl`));
        } catch {
          return false;
        }
      },
    },
    {
      kind: 'fs',
      label: 'an export PNG > 100 KB with a sidecar',
      check: (dataRoot) => {
        try {
          const dir = join(dataRoot, 'exports');
          const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'));
          return pngs.some(
            (f) =>
              statSync(join(dir, f)).size > 100_000 &&
              readdirSync(dir).includes(f.replace(/\.png$/, '.json')),
          );
        } catch {
          return false;
        }
      },
    },
    {
      kind: 'page',
      label: 'layout select shows Full Art',
      // The layout picker is a NATIVE <select> (live-caught: it is neither a
      // <button> nor matched by [role="combobox"]).
      script:
        "() => Array.from(document.querySelectorAll('select')).some((s) => (s.selectedOptions[0]?.textContent ?? '').includes('Full Art'))",
      expect: (r) => r === true,
    },
    {
      kind: 'page',
      label: 'at least 3 doc-action chips',
      script: '() => document.querySelectorAll(\'[data-testid="tool-doc-action"]\').length',
      expect: (r) => typeof r === 'number' && r >= 3,
    },
  ],
};
