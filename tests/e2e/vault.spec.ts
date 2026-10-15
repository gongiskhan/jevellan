import { expect, test } from './fixtures.js';

// Phase 5: Settings → Projects shows the vault, and adding a project whose origin has a vault folder offers to restore it.
test('Projects shows the vault and offers Restore from the vault for an origin it holds', async ({ page }, info) => {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Runtimes', exact: true })).toBeVisible();
  await page.route('**/api/vault', route => route.fulfill({ json: { schema: 'vault-view-v1', remote: 'https://github.com/gongiskhan/jevellan-vault.git', lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
    lastError: null, pending: false, folders: ['gongiskhan__ekoa-code'] } }));
  await page.goto('/settings/projects');
  const card = page.getByRole('region', { name: 'Vault' });
  await expect(card).toContainText('https://github.com/gongiskhan/jevellan-vault.git'); await expect(card).toContainText('Synced');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const restore = page.getByRole('checkbox', { name: 'Restore from the vault' });
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/ekoa-code.git');
  await expect(restore).toBeChecked();
  await expect(page.getByText('come back from gongiskhan__ekoa-code')).toBeVisible();
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/other.git');
  await expect(restore).toHaveCount(0);
  await page.getByLabel('Remote URL').fill('https://github.com/gongiskhan/ekoa-code.git');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`vault-restore-${info.project.name}.png`) });
});
