import { expect, type Page } from '@playwright/test';

export const COMPOSER = 'textarea[placeholder="Message the assistant…"]';

/** Send a chat message and wait for the turn to settle (Send visible again). */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.fill(COMPOSER, text);
  await page.click('[data-testid="composer-send"]');
  await expect(page.locator('[data-testid="composer-send"]')).toBeVisible({ timeout: 20_000 });
}
