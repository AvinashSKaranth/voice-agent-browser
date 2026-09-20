import { expect, test } from '@playwright/test';
import { seedSettings } from './helpers';

// FIXME (real app bug, not a test bug): src/storage/db.ts's initDb() awaits the sqlite worker's
// 'ready' message before running its CREATE TABLE migrations, but db.exec/db.query only await that
// same 'ready' signal too - not migration completion - so any db write that fires while the app is
// still booting (e.g. Documents mounting straight from a fresh navigation) races the CREATE TABLE
// statements and reliably hits "no such table: documents". Reproduced deterministically (3/3 runs).
test('documents: upload a .txt, see it listed with a char count, then find it via search', async ({ page }) => {
  await seedSettings(page);
  await page.goto('/#/documents');

  const content = 'hello world from a small test document about kangaroos';
  await page.locator('input[type=file]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(content),
  });

  const row = page.locator('.doc-list li', { hasText: 'note.txt' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`${content.length}`); // chars count rendered via toLocaleString()

  await page.locator('input.input[placeholder="Search documents…"]').fill('kangaroos');
  await page.getByRole('button', { name: 'Search' }).click();

  const resultsCard = page.locator('.card', { has: page.getByRole('heading', { name: 'Search results' }) });
  await expect(resultsCard.locator('li', { hasText: 'note.txt' })).toContainText('kangaroos');
});
