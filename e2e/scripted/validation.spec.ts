/**
 * Validation-failure UX (the Tinker class, scripted): INVALID_ARGS_PLEASE
 * makes the fake call card_patch {cost:999} — REAL typebox validation
 * rejects it; the turn still lands with a note, never a crash.
 */

import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

test('invalid tool args surface a note; the turn completes', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'INVALID_ARGS_PLEASE');
  await expect(page.locator('[data-testid="note-strip"]')).toContainText(
    'failed validation: card_patch',
  );
  // the reply rendered; the cost field did NOT take 999
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('out of range');
  await expect(page.locator('aside input[type="number"]').first()).not.toHaveValue('999');
});
