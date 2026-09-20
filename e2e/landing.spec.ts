import { expect, test } from '@playwright/test';

test('fresh origin shows the landing hero and Get started', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Talk to your computer.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
});

test('#/assistant redirects to landing when setup has not run', async ({ page }) => {
  await page.goto('/#/assistant');
  await expect(page.getByRole('heading', { name: 'Talk to your computer.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
});
