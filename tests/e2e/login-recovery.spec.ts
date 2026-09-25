import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function openLogin(page: Page) {
  await page.goto('/');
  await page.getByLabel('Passphrase').fill('jevellan-browser-fixture');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const claude = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await claude.getByRole('button', { name: 'Add account', exact: true }).click();
  const panel = page.getByRole('dialog'); const label = `Login recovery ${randomUUID()}`;
  await panel.getByLabel('Label', { exact: true }).fill(label);
  await panel.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(panel.getByRole('heading')).toHaveText(`Log in · ${label}`);
  return { panel, account: claude.locator('.account').filter({ hasText: label }) };
}

test('Claude sign-in reports failure and starts a fresh login in the same panel', async ({ page }) => {
  const { panel, account } = await openLogin(page);
  await panel.getByLabel('Authorization code').fill('fixture-rejected');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Claude reported a sign-in error');
  await expect(panel.getByRole('link', { name: 'Open sign-in page' })).not.toBeVisible();
  await expect(account).not.toContainText('Saved');
  await panel.getByRole('button', { name: 'Start again', exact: true }).click();
  await expect(panel.getByRole('alert')).not.toBeVisible();
  await expect(panel.getByLabel('Authorization code')).toHaveValue('');
  await panel.getByLabel('Authorization code').fill('fixture-approval');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Signed in as fixture@example.test');
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(account.getByText('Ready', { exact: true })).toBeVisible();
  await expect(account).toContainText('Saved');
});

test('Claude sign-in shows pending progress and resumes polling after a connection error', async ({ page }, info) => {
  const { panel, account } = await openLogin(page);
  let submitted = false; let interrupted = false;
  await page.route('**/api/logins/*', async route => {
    if (route.request().method() === 'POST') submitted = true;
    if (submitted && !interrupted && route.request().method() === 'GET') { interrupted = true; await route.abort('failed'); }
    else await route.continue();
  });
  await panel.getByLabel('Authorization code').fill('fixture-delayed');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Code sent. Waiting for sign-in to finish…');
  await expect(panel.getByRole('alert')).toContainText('Can’t reach Jevellan');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `docs/acceptance/screenshots/login-recovery-${info.project.name}.png` });
  await expect(panel.getByRole('status')).toContainText('Signed in as fixture@example.test', { timeout: 15_000 });
  await expect(panel.getByRole('alert')).not.toBeVisible();
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(account.getByText('Ready', { exact: true })).toBeVisible();
  expect(interrupted).toBe(true);
});
