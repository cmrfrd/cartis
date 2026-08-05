import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario } from '../types.ts';

/** Rename → save → hard reload: URL identity, rehydration, ZERO SSE ghosts. */
export const persistenceReload: Scenario = {
  id: 'persistence-reload',
  title: 'Save + hard reload restores the card and its conversation, no ghosts',
  timeoutMin: 8,
  objective:
    "In the card app at {{APP_URL}}/builder, send the chat message 'rename this card to Reload Probe' " +
    'and wait for the reply. Click Save in the document bar. Note the URL. Reload the page ' +
    '(navigate to the same URL again). Then confirm what you see and reply DONE.',
  constraints: [],
  criteria: [
    {
      kind: 'page',
      label: 'deep-link URL (/builder/<id>)',
      script: '() => location.pathname',
      expect: (r) => typeof r === 'string' && /^\/builder\/[0-9a-f-]+$/.test(r),
    },
    {
      kind: 'page',
      label: 'conversation rehydrated (Reload Probe present in chat)',
      script:
        '() => (document.querySelector(\'[data-testid="chat-panel"]\')?.textContent ?? "").includes("Reload Probe")',
      expect: (r) => r === true,
    },
    {
      kind: 'page',
      label: 'ZERO ghost messages before the first user bubble',
      script:
        '() => { const groups = Array.from(document.querySelectorAll(\'[data-testid="chat-panel"] .group\')); return { count: groups.length, firstHasUserText: (groups[0]?.textContent ?? "").includes("rename this card to Reload Probe") }; }',
      expect: (r) => {
        const v = r as { count?: number; firstHasUserText?: boolean };
        return (v.count ?? 0) >= 2 && v.firstHasUserText === true;
      },
    },
    {
      kind: 'fs',
      label: 'sidecar named Reload Probe with a chatSessionId',
      check: (dataRoot) => {
        try {
          return readdirSync(join(dataRoot, 'cards'))
            .filter((f) => f.endsWith('.json'))
            .map(
              (f) =>
                JSON.parse(readFileSync(join(dataRoot, 'cards', f), 'utf8')) as {
                  name?: string;
                  chatSessionId?: string;
                },
            )
            .some((c) => c.name === 'Reload Probe' && typeof c.chatSessionId === 'string');
        } catch {
          return false;
        }
      },
    },
  ],
};
