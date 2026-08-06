import type { Scenario } from '../types.ts';

/**
 * THE snapshot invariant, real-model-proven: later turns carry the CURRENT
 * data, so hand edits win. Only a real model demonstrates it actually USES
 * the fresh value — "increase the cost by 1" after a hand edit to 7 must
 * yield 8 (the default is 3; a stale snapshot would give 4).
 */
export const handEditsWin: Scenario = {
  id: 'hand-edits-win',
  title: 'Hand edits survive into later turns (currentData snapshot)',
  timeoutMin: 8,
  objective:
    'In the card app at {{APP_URL}}/builder, send the chat message "rename this card to Ledger" and wait ' +
    'for the reply. Then type 7 into the COST number field in the form sidebar yourself (this is the one ' +
    'form edit you are allowed — the test is that hand edits survive). Then send the chat message ' +
    '"increase the cost by 1" and wait for the reply.',
  constraints: [
    'The ONLY form field you may touch is COST (set it to 7). Everything else goes through chat.',
    'Do not save the card.',
  ],
  criteria: [
    {
      kind: 'page',
      label: 'cost is 8 — the model incremented the HAND-EDITED 7, not a stale snapshot',
      script: '() => document.querySelector(\'aside input[type="number"]\')?.value ?? null',
      expect: (r) => r === '8',
    },
    {
      kind: 'page',
      label: 'the earlier rename held',
      script: '() => document.querySelector(\'aside input[type="text"]\')?.value ?? null',
      expect: (r) => r === 'Ledger',
    },
  ],
};
