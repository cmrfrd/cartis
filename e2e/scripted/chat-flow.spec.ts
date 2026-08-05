/**
 * Chat → card pipeline in a real browser: patch applies to the form with an
 * EDITED chip; the setLayout knob flips the layout select through the REAL
 * tool pipeline.
 */

import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

test('rename turn patches the form and renders the EDITED chip', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'rename this card to Chip Probe');
  await expect(page.locator('aside input[type="text"]').first()).toHaveValue('Chip Probe');
  await expect(page.locator('[data-testid="tool-card-patch"]')).toContainText('name');
});

test('full art message flips the layout select', async ({ page }) => {
  await page.goto('/builder');
  await sendChat(page, 'switch to full art please');
  // the layout picker is a NATIVE select — assert its selected option text
  const layoutText = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('select')).find((s) =>
        (s.selectedOptions[0]?.textContent ?? '').includes('Full Art'),
      )?.selectedOptions[0]?.textContent ?? null,
  );
  expect(layoutText).toContain('Full Art');
  await expect(page.locator('[data-testid="tool-doc-action"]')).toContainText('fullart');
});
