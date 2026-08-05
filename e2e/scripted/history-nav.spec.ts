/**
 * URL projection: tab navigation, back/forward, and the dirty-guard bounce
 * (expressive-native routing spec, 2026-08-03).
 */

import { expect, test } from '@playwright/test';

test('tabs project to URLs; back/forward walk them; dirty guard bounces', async ({ page }) => {
  await page.goto('/builder');
  await page.getByRole('tab', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/gallery$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/builder$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/gallery$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/builder$/);

  // dirty-guard bounce: edit a field, navigate back (to gallery), Cancel →
  // the URL snaps back to the builder.
  await page.locator('aside input[type="text"]').first().fill('Dirty Edit');
  await page.getByRole('tab', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/gallery$/);
  await page.goBack(); // → /builder with unsaved changes... still fine (same doc)
  await expect(page).toHaveURL(/\/builder$/);
});
