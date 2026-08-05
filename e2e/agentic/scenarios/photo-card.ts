import type { Scenario } from '../types.ts';

/**
 * The reproduced killer flow (live-caught 2026-08-03 as a turn-killer in the
 * JSON-transport era): attach a photo, ask for a creative multi-field card
 * with "no might/ward stuff". Fixture: e2e/agentic/fixtures/subject.jpg — an
 * AI-generated face (thispersondoesnotexist.com), no real person's likeness.
 *
 * Stat-badge selector recorded from ArcaneStatBadge:
 * `[data-testid="stat-badge"]` (src/cards/arcane/parts.tsx).
 */
export const photoCard: Scenario = {
  id: 'photo-card',
  title: 'Photo attach + creative multi-field card by conversation',
  timeoutMin: 8,
  stage: ['e2e/agentic/fixtures/subject.jpg'],
  objective:
    'There is a photo at {{STAGE_DIR}}/subject.jpg. In the card app at {{APP_URL}}/builder, ' +
    "attach that photo in the chat sidebar and ask the assistant to make the card a spell card called 'Tinker' " +
    'in a steampunk style featuring the person in the photo, with a funny caption and no might/ward stuff. ' +
    'Wait for it to finish.',
  constraints: [
    'Use ONLY the chat sidebar for the card changes — do not edit the form fields directly.',
    'Do not save the card.',
  ],
  criteria: [
    {
      kind: 'page',
      label: 'name field is Tinker',
      script: '() => document.querySelector(\'aside input[type="text"]\')?.value ?? null',
      expect: (r) => r === 'Tinker',
    },
    {
      kind: 'page',
      label: 'stat badge absent (no might/ward)',
      script:
        '() => document.querySelector(\'main > div:not(.hidden) [data-testid="stat-badge"]\') === null',
      expect: (r) => r === true,
    },
    {
      kind: 'page',
      label: 'the change went through a real tool call (patch chip)',
      script: '() => document.querySelectorAll(\'[data-testid="tool-card-patch"]\').length',
      expect: (r) => typeof r === 'number' && r >= 1,
    },
    {
      kind: 'page',
      label: 'composer settled (Send visible again)',
      script: '() => document.querySelector(\'[data-testid="composer-send"]\') !== null',
      expect: (r) => r === true,
    },
    {
      kind: 'page',
      label: 'no validation-failure note',
      script: '() => document.querySelector(\'[data-testid="note-strip"]\')?.textContent ?? ""',
      expect: (r) => typeof r === 'string' && !r.includes('failed validation'),
    },
  ],
};
