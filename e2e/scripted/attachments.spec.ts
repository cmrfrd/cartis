/**
 * Attachment gating in a real browser: policy rejection notes, the 6-cap,
 * and thumb removal (chat-panel-maturity spec §1).
 */

import { expect, test } from '@playwright/test';

const attachInput = '[data-testid="composer-attach"] input[type="file"]';

test('rejects unsupported types with a note', async ({ page }) => {
  await page.goto('/builder');
  await page.setInputFiles(attachInput, {
    name: 'art.psd',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('x'),
  });
  await expect(page.locator('[data-testid="note-strip"]')).toContainText(
    'unsupported attachment type: art.psd',
  );
});

test('caps at 6 attachments and removes by thumb ×', async ({ page }) => {
  await page.goto('/builder');
  await page.setInputFiles(
    attachInput,
    Array.from({ length: 7 }, (_, i) => ({
      name: `f${String(i)}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })),
  );
  await expect(page.locator('[data-testid="note-strip"]')).toContainText(
    'too many attachments (max 6)',
  );
  await expect(page.locator('[data-testid="composer-attachment"]')).toHaveCount(6);
  await page.locator('[data-testid="attachment-remove"]').first().click();
  await expect(page.locator('[data-testid="composer-attachment"]')).toHaveCount(5);
});
