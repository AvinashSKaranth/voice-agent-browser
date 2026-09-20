import { expect, test } from '@playwright/test';
import { seedSettings } from './helpers';

test('extensions: five tabs render; Skills lists the starters; Tools lists the built-ins', async ({ page }) => {
  await seedSettings(page);
  await page.goto('/#/extensions');

  const tabs = ['Skills', 'MCP servers', 'Custom tools', 'Marketplace', 'Tools'];
  for (const label of tabs) {
    await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible();
  }

  // Skills tab is active by default; OPFS seeds the three starter skills on first list().
  await expect(page.locator('.doc-list li strong', { hasText: 'summarise' })).toBeVisible();
  await expect(page.locator('.doc-list li strong', { hasText: 'translate' })).toBeVisible();
  await expect(page.locator('.doc-list li strong', { hasText: 'code_review' })).toBeVisible();

  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(page.locator('.doc-list li strong', { hasText: 'calculator' })).toBeVisible();
  await expect(page.locator('.doc-list li strong', { hasText: 'web_search' })).toBeVisible();
});
