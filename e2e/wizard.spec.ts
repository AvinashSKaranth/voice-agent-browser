import { expect, test } from '@playwright/test';
import { blockModelDownloads } from './helpers';

test('wizard: walk steps 1-8 choosing cloud + a custom endpoint, finishes at the assistant', async ({ page }) => {
  await blockModelDownloads(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Get started' }).click();

  // Step 1: Welcome
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2: Brain -> choose Cloud
  await expect(page.getByRole('heading', { name: 'Choose your brain' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose cloud' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 3: Provider -> add a custom endpoint named Mock
  await expect(page.getByRole('heading', { name: 'Add a cloud provider' })).toBeVisible();
  await page.getByRole('heading', { name: 'Custom endpoint' }).scrollIntoViewIfNeeded();
  await page.getByLabel('Name').fill('Mock');
  await page.getByLabel('Base URL').fill('https://mock.local/v1');
  // No Test button on this form (only preset cards get one); saving with an unreachable-in-test
  // URL is expected to work regardless of whether a live connection would succeed.
  await page.getByRole('button', { name: 'Save custom endpoint' }).click();
  await expect(page.getByText('Custom endpoint saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 4: Download models (no downloads triggered, just pass through)
  await expect(page.getByRole('heading', { name: 'Download models' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 5: TinyFish (skippable)
  await expect(page.getByRole('heading', { name: 'TinyFish key' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  // Step 6: Voice
  await expect(page.locator('.voice-settings')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 7: Wake word (skippable)
  await expect(page.getByRole('heading', { name: 'Wake word' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  // Step 8: Done
  await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible();
  await page.getByRole('button', { name: 'Open assistant' }).click();

  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/assistant');
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('va.settings') || '{}'));
  expect(settings.setupDone).toBe(true);
  expect(settings.mode).toBe('cloud');
  expect(settings.providers.some((p: { label: string; baseUrl: string }) => p.label === 'Mock' && p.baseUrl === 'https://mock.local/v1')).toBe(true);
});
