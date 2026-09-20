import { expect, test } from '@playwright/test';
import { seedSettings } from './helpers';

const SECTION_HEADINGS = ['Brain', 'Providers', 'Local models', 'Voice', 'Wake word', 'Spoken feedback', 'Bridge', 'Memory', 'Data'];

test('settings page renders every section heading', async ({ page }) => {
  await seedSettings(page);
  await page.goto('/#/settings');
  for (const heading of SECTION_HEADINGS) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
});

test('changing heartbeat and reloading persists the value', async ({ page }) => {
  await seedSettings(page);
  await page.goto('/#/settings');

  const slider = page.locator('label.field', { hasText: 'Heartbeat every' }).locator('input[type=range]');
  await slider.focus();
  await slider.press('End'); // jumps the range input to its max (120), firing input + change

  await expect(page.locator('label.field', { hasText: 'Heartbeat every 120s' })).toBeVisible();

  await page.reload();
  await expect(page.locator('label.field', { hasText: 'Heartbeat every 120s' })).toBeVisible();

  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('va.settings') || '{}'));
  expect(settings.feedback.heartbeatSec).toBe(120);
});
