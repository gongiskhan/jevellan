import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { ConversationPublicSchema } from '../../packages/core/dist/index.js';

export async function installationBrowser({ origin, project, remote, root, layout, theme }) {
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), headless: true });
  const context = await browser.newContext({ viewport: layout === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(30_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const passphrase = `fixture-${randomUUID()}`;
  const skippedJev = layout === 'phone';
  const connectJev = async () => {
    await page.getByLabel('Jev key', { exact: true }).fill(`fixture-${randomUUID()}`);
    await page.getByRole('button', { name: 'Save key', exact: true }).click(); await expect(page.getByText('Jev key saved.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Jev key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Test connection', exact: true }).click(); await expect(page.getByText('Connected to Jev.', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Latency: \d+ ms\.$/)).toBeVisible(); await expect(page.getByText(/Returned models: jev-1\.13\.0/)).toBeVisible();
  };
  const capture = async name => {
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await page.screenshot({ path: join(root, `first-run-${name}-${layout}-${theme}.png`), animations: 'disabled', fullPage: !['verified', 'why'].includes(name), mask: [page.locator('.saved-secret')] });
  };
  try {
    await page.goto(origin); await expect(page.getByRole('heading', { name: 'Set your passphrase', exact: true })).toBeVisible(); await capture('welcome');
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase); await page.getByRole('button', { name: 'Set passphrase', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect Jev', exact: true })).toBeVisible();
    await expect(page.getByLabel('Setup progress').locator('li')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled(); await capture('jev');
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add your first account', exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: 'Add your first account', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    if (!skippedJev) {
      await page.getByRole('button', { name: 'Back', exact: true }).click(); await connectJev();
      await capture('connected'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Add your first account', exact: true })).toBeVisible(); await capture('account');
    const claude = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
    await claude.getByRole('button', { name: 'Add account', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Label', { exact: true }).fill('Simulated installation account');
    await dialog.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('api-key');
    await dialog.getByLabel('API key', { exact: true }).fill(`fixture-${randomUUID()}`);
    await dialog.getByLabel('When may Jevellan use this key?').selectOption('always');
    await dialog.getByRole('button', { name: 'Add account', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await expect(claude.locator('.account').filter({ hasText: 'Simulated installation account' }).locator('.status')).toHaveText('Ready');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add your first project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Add a project on this device before continuing.');
    await page.getByRole('button', { name: 'Dismiss message', exact: true }).click(); await capture('project');
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Installation fixture'); await dialog.getByLabel(/^Path on /).fill(project);
    await dialog.getByLabel('Remote URL', { exact: true }).fill(remote); await dialog.getByLabel('Test command', { exact: true }).fill('node --test value.test.mjs');
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click(); await expect(dialog).not.toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Start your first conversation', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Installation fixture' }); await capture('conversation');
    await page.getByPlaceholder('What should we build or fix?').fill('Installation acceptance: change the value to two.'); await page.getByRole('button', { name: 'Start', exact: true }).click();
    if (skippedJev) {
      await expect(page.locator('.manual-picker')).toBeVisible(); await expect(page.locator('.stretch-block')).toHaveCount(0); await capture('manual');
      const startedPath = new URL(page.url()).pathname;
      await page.goto(`${origin}/settings/decisions`); await connectJev(); await capture('connected');
      await page.goto(`${origin}${startedPath}`); await page.getByRole('button', { name: 'Try automatic again', exact: true }).click();
    }
    await expect(page.locator('.stretch-block')).toContainText('Simulated provider: the installation conversation is running.', { timeout: 90_000 });
    const conversationPath = new URL(page.url()).pathname; await capture('running');
    return {
      page, passphrase, conversationPath, skippedJev, close: () => browser.close(),
      verifyCompleted: async () => {
        await page.goto(`${origin}${conversationPath}`); await expect(page.getByLabel('Conversation details', { exact: true })).toContainText('Done', { timeout: 90_000 });
        const response = await page.request.get(`${origin}/api${conversationPath}`); expect(response.ok()).toBe(true);
        const conversation = ConversationPublicSchema.parse(await response.json());
        expect(conversation.decisions.map(decision => decision.action.chosen)).toEqual(['implement', 'done']); expect(conversation.stretches).toHaveLength(1);
        await page.locator('.stretch-block').getByRole('button', { name: 'Changes', exact: true }).click();
        await expect(dialog).toContainText('Jevellan verification'); await expect(dialog).toContainText('Passed'); await capture('verified');
        await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
        await page.locator('.stretch-block').getByRole('button', { name: 'Why', exact: true }).click();
        await expect(dialog).toContainText('jev-installation-simulated'); await capture('why'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
        expect(errors).toEqual([]);
      },
    };
  } catch (error) {
    console.error('First-run page errors:', errors, 'Alerts:', await page.getByRole('alert').allTextContents());
    await page.screenshot({ path: join(root, `first-run-failure-${layout}-${theme}.png`), animations: 'disabled', fullPage: true, mask: [page.locator('input[type="password"]')] }).catch(() => undefined);
    await browser.close(); throw error;
  }
}
