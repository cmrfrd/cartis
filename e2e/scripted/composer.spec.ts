/**
 * Composer morphing through a full slow turn: Send disabled → enabled →
 * busy strip + Stop → settled back to Send (SLOW_TURN_PLEASE trigger).
 */

import { expect, test } from '@playwright/test';
import { COMPOSER } from './helpers.ts';

test('send/stop swap + busy strip across a slow turn', async ({ page }) => {
  await page.goto('/builder');
  const send = page.locator('[data-testid="composer-send"]');
  await expect(send).toBeDisabled();
  await page.fill(COMPOSER, 'SLOW_TURN_PLEASE');
  await expect(send).toBeEnabled();
  await send.click();
  // while running: Stop + the always-on busy strip
  await expect(page.locator('[data-testid="composer-cancel"]')).toBeVisible();
  await expect(page.locator('[data-testid="busy-strip"]')).toBeVisible();
  await expect(page.locator(COMPOSER)).toBeDisabled();
  // settles
  await expect(send).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="busy-strip"]')).toHaveCount(0);
});
