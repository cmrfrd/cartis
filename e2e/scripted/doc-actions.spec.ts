/**
 * Doc actions land as REAL files: card sidecar + pi session file + export
 * PNG in the scratch data root.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

const DATA_ROOT = 'e2e/.scratch/scripted/data';

test('save + export print produce real files and chips', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'rename this card to Keeper, save it and export print');
  // chips for save + export (patch chip is separate)
  await expect(page.locator('[data-testid="tool-doc-action"]')).toHaveCount(2);
  // the sidecar with its chatSessionId
  await expect
    .poll(
      () => {
        try {
          return readdirSync(join(DATA_ROOT, 'cards'))
            .filter((f) => f.endsWith('.json'))
            .map(
              (f) =>
                JSON.parse(readFileSync(join(DATA_ROOT, 'cards', f), 'utf8')) as {
                  name?: string;
                  chatSessionId?: string;
                },
            )
            .some((c) => c.name === 'Keeper' && typeof c.chatSessionId === 'string');
        } catch {
          return false;
        }
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  // the pi session file for it
  const card = readdirSync(join(DATA_ROOT, 'cards'))
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) =>
        JSON.parse(readFileSync(join(DATA_ROOT, 'cards', f), 'utf8')) as {
          name?: string;
          chatSessionId?: string;
        },
    )
    .find((c) => c.name === 'Keeper');
  expect(
    readdirSync(join(DATA_ROOT, 'chats')).some((f) =>
      f.endsWith(`_${card?.chatSessionId ?? '?'}.jsonl`),
    ),
  ).toBe(true);
  // the export PNG (fake/stub art — modest but real)
  await expect
    .poll(
      () => {
        try {
          const dir = join(DATA_ROOT, 'exports');
          return readdirSync(dir).some(
            (f) => f.endsWith('.png') && statSync(join(dir, f)).size > 10_000,
          );
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});
