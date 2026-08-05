/**
 * Deep-link reload restores the card + conversation with ZERO ghost messages
 * (the SSE-replay ghost class, live-caught twice in the opencode era).
 */

import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

test('rename → save → reload restores card + chat, no ghosts', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'rename this card to Probe');
  // the fake's card_patch applied to the form
  await expect(page.locator('aside input[type="text"]').first()).toHaveValue('Probe');
  // save through the document bar
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/\/builder\/[0-9a-f-]+$/);
  const url = page.url();

  await page.reload();
  await expect(page).toHaveURL(url);
  // form restored
  await expect(page.locator('aside input[type="text"]').first()).toHaveValue('Probe');
  // conversation rehydrated
  const panel = page.locator('[data-testid="chat-panel"]');
  await expect(panel).toContainText('rename this card to Probe');
  // ZERO ghosts: the FIRST message group is the user's own bubble
  const groups = panel.locator('.group');
  await expect(groups.first()).toContainText('rename this card to Probe');
  expect(await groups.count()).toBeGreaterThanOrEqual(2);
});
