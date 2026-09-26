import { expect, test } from './fixtures.js';

test('Git settings can be saved, reloaded and checked from Projects', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { schema: 'passphrase-input-v1', passphrase: 'jevellan-browser-fixture' } });
  await page.goto('/settings/projects');
  await page.getByRole('button', { name: 'Git settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
  await page.getByLabel('Connection method').selectOption('ssh');
  await page.getByRole('button', { name: 'Save Git settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Git settings saved');
  await page.reload(); await expect(page.getByLabel('Connection method')).toHaveValue('ssh');
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('.git-check-result')).toContainText('Connected');
  await expect(page.locator('.git-check-result')).toContainText('Push permission is checked when publishing');
  expect(await page.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/git-settings-${test.info().project.name}.png`, fullPage: true });
  await page.getByLabel('Connection method').selectOption('machine');
  await page.getByRole('button', { name: 'Save Git settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Git settings saved' })).toBeVisible();
});
