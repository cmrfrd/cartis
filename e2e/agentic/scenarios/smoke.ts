import type { Scenario } from '../types.ts';

/** The lifecycle smoke: boots everything, drives one navigation, judges one
 * page criterion mechanically. */
export const smoke: Scenario = {
  id: 'smoke',
  title: 'App boots and the builder renders',
  timeoutMin: 3,
  objective: 'Navigate to {{APP_URL}}/builder and confirm the app is showing, then reply DONE.',
  constraints: [],
  criteria: [
    {
      kind: 'page',
      label: 'builder heading',
      script: '() => document.querySelector("h1")?.textContent ?? null',
      expect: (r) => r === 'CARTIS',
    },
  ],
};
