import { expect, test } from '@playwright/test';
import { blockModelDownloads, mockRateLimited, mockToolCallThenAnswer, seedSettings } from './helpers';

// FIXME (real app bug, not a test bug - same root cause as e2e/documents.spec.ts): src/storage/db.ts
// lets db.exec/query proceed as soon as the sqlite worker is "ready", racing initDb()'s own
// CREATE TABLE migrations. orchestrator.runTurn()'s ensureSession() hits this immediately
// ("no such table: sessions"), so a turn run right after navigating to #/assistant fails before
// ever calling the provider. Reproduced deterministically.
test('typed turn: calculator tool call then a spoken/text answer', async ({ page }) => {
  await seedSettings(page);
  await blockModelDownloads(page);
  const requests = await mockToolCallThenAnswer(page, '18 percent of 4250 is 765.');

  await page.goto('/#/assistant');
  await page.getByPlaceholder('Type instead of speaking…').fill('What is 18% of 4250?');
  await page.getByPlaceholder('Type instead of speaking…').press('Enter');

  await expect(page.locator('.msg-user', { hasText: 'What is 18% of 4250?' })).toBeVisible();
  await expect(page.locator('.tool-chip', { hasText: 'calculator' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.tool-chip', { hasText: 'calculator' })).toContainText('done: 765');
  await expect(page.locator('.msg-assistant', { hasText: '765' })).toBeVisible({ timeout: 15000 });

  await expect.poll(() => requests.length).toBe(2);
  const secondRequestHasToolMessage = requests[1]?.messages?.some((m) => m.role === 'tool');
  expect(secondRequestHasToolMessage).toBe(true);
});

// FIXME: same db-ready race as above (src/storage/db.ts) - ensureSession() throws "no such table:
// sessions" before the provider is ever called, so the retry/give-up feedback never fires.
test('error path: rate-limited provider retries then gives up', async ({ page }) => {
  test.setTimeout(45000);
  await seedSettings(page);
  await blockModelDownloads(page);
  await mockRateLimited(page);

  await page.goto('/#/assistant');
  await page.getByPlaceholder('Type instead of speaking…').fill('hello there');
  await page.getByPlaceholder('Type instead of speaking…').press('Enter');

  await expect(page.locator('.msg-feedback', { hasText: 'That broke, trying again' }).first()).toBeVisible({ timeout: 40000 });
  await expect(page.locator('.msg-feedback', { hasText: 'I will stop trying now' })).toBeVisible({ timeout: 40000 });
});
