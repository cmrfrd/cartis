import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario } from '../types.ts';

/**
 * The art pipeline end-to-end on the FREE stub path (no Replicate token in
 * the harness): chat card_generate_art intent → detached client art run →
 * stub stylizer → image stored in the library → art on the card.
 */
export const artStub: Scenario = {
  id: 'art-stub',
  title: 'Chat-driven art generation lands on the card (stub pipeline)',
  timeoutMin: 8,
  objective:
    'In the card app at {{APP_URL}}/builder, use the chat sidebar to ask the assistant to ' +
    'generate art of a crystal fox in a snowy forest. The art generates AFTER the reply — ' +
    "wait until the art chip in the chat says 'art generated' (it may take a moment) before replying DONE.",
  constraints: ['Use ONLY the chat sidebar.', 'Do not save the card.'],
  criteria: [
    {
      kind: 'page',
      label: 'art strip completed',
      script:
        '() => document.querySelector(\'[data-testid="tool-card-art"]\')?.textContent ?? null',
      expect: (r) => typeof r === 'string' && r.includes('art generated'),
    },
    {
      kind: 'page',
      label: 'the card preview shows the generated image',
      script:
        "() => Array.from(document.querySelectorAll('main > div:not(.hidden) img')).some((i) => i.src.includes('/files/images/'))",
      expect: (r) => r === true,
    },
    {
      kind: 'fs',
      label: 'a real image file + sidecar in the scratch library',
      check: (dataRoot) => {
        try {
          const dir = join(dataRoot, 'images');
          const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'));
          return pngs.some(
            (f) =>
              statSync(join(dir, f)).size > 1_000 &&
              readdirSync(dir).includes(f.replace(/\.png$/, '.json')),
          );
        } catch {
          return false;
        }
      },
    },
  ],
};
