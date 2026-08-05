/**
 * Render parity (the UA-leak class, live-caught 2026-08-03): the card face
 * must compute identical text styles in the builder and inside the gallery
 * tile's <button> wrapper. Plus ONE screenshot baseline of the builder face.
 */

import { expect, test } from '@playwright/test';
import { sendChat } from './helpers.ts';

const ABILITY_TEXT = 'When Nyra enters play, deal 2 damage to any target.';

const styleOf = `(root) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = root;
  while (node) {
    // skip form controls — the aside's textarea carries the same text as its
    // value (live-caught: the walker matched it before the card face)
    if (
      !['TEXTAREA', 'INPUT'].includes(node.tagName) &&
      (node.textContent ?? '').trim() === ${JSON.stringify(ABILITY_TEXT)} &&
      node.children.length === 0
    ) {
      const s = getComputedStyle(node);
      return { textAlign: s.textAlign, fontFamily: s.fontFamily };
    }
    node = walker.nextNode();
  }
  return null;
}`;

test('ability text computes identical styles in builder and gallery tile', async ({ page }) => {
  await page.goto('/builder');
  // save the default card so the gallery has a tile
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/\/builder\/[0-9a-f-]+$/);

  const builderStyle = await page.evaluate(
    `(${styleOf})(document.querySelector('main > div:not(.hidden)'))`,
  );
  expect(builderStyle).not.toBeNull();

  await page.getByRole('tab', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/gallery$/);
  await expect(page.locator('[data-testid="card-tile"]').first()).toBeVisible();
  // Scope to the TILE's rendered card face — the pane also shows the ability
  // text as plain info copy (which legitimately differs).
  const galleryStyle = await page.evaluate(
    `(${styleOf})(document.querySelector('[data-testid="card-tile"]'))`,
  );
  expect(galleryStyle).not.toBeNull();
  expect(galleryStyle).toEqual(builderStyle); // the UA-leak class stays dead
});

test('builder card face matches the visual baseline', async ({ page }) => {
  await page.goto('/builder');
  const face = page.locator('[data-testid="card-surface"], main > div:not(.hidden) > div').first();
  await expect(face).toHaveScreenshot('builder-card-face.png', { maxDiffPixelRatio: 0.02 });
});
