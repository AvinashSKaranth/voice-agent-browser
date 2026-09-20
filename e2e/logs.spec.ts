import { expect, test } from '@playwright/test';
import { blockModelDownloads, mockToolCallThenAnswer, seedSettings } from './helpers';

// The Logs page (src/ui/Logs.tsx) exists but was not wired into App.tsx's router/nav as of writing
// this test (owned by a concurrently-running task). Skip at runtime if that's still the case; once
// it's wired in, this starts exercising the real page.
//
// FIXME (real app bug, not a test bug - same root cause as e2e/documents.spec.ts and
// e2e/assistant.spec.ts): src/storage/db.ts's db.exec/query race initDb()'s CREATE TABLE
// migrations, so running a turn immediately after navigating to #/assistant throws "no such
// table: sessions" before the provider is ever called. Once that's fixed, this test should be
// runnable (remove test.fixme, keep the nav-link runtime skip guard).
test('logs page shows entries after a turn', async ({ page }) => {
  await seedSettings(page);
  await blockModelDownloads(page);
  await mockToolCallThenAnswer(page, 'done.');

  await page.goto('/#/assistant');
  const logsLink = page.locator('nav.topnav a', { hasText: 'Logs' });
  test.skip((await logsLink.count()) === 0, 'Logs route is not wired into App.tsx yet');

  await page.getByPlaceholder('Type instead of speaking…').fill('what is 18% of 4250');
  await page.getByPlaceholder('Type instead of speaking…').press('Enter');
  await expect(page.locator('.msg-assistant')).toBeVisible({ timeout: 15000 });

  await logsLink.click();
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
  await expect
    .poll(async () => page.locator('table.data-table tbody tr').count())
    .toBeGreaterThan(0);
});
