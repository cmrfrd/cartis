/**
 * The durable-branch class, scripted: edit → sibling branch → ‹ n/m ›
 * arrows → switch → RELOAD → selection retained (leaf_switch durability in
 * a real browser; blocker-1 of the pi migration).
 */

import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

test('edit creates a branch; switch is durable across reload', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'rename this card to First Name');
  // save so the session binds to a card (reload needs the deep link)
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/\/builder\/[0-9a-f-]+$/);

  // edit the user bubble → sibling branch
  const userBubble = page.locator('[data-testid="chat-panel"] .group').first();
  await userBubble.hover();
  await userBubble.locator('[data-testid="action-edit"]').click();
  await page.fill('[data-testid="edit-box"] textarea', 'rename this card to Second Name');
  await page.click('[data-testid="edit-submit"]');
  await expect(page.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 20_000 });

  // arrows show 2/2; the form carries the edited branch's name
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('2/2');
  await expect(page.locator('aside input[type="text"]').first()).toHaveValue('Second Name');

  // switch back to branch 1 — the original conversation returns
  await page.click('[data-testid="branch-prev"]');
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('1/2');
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('First Name');

  // RELOAD — the selection survives (leaf_switch durability)
  await page.reload();
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('1/2');
  await expect(page.locator('[data-testid="chat-panel"]')).toContainText('First Name');
});
