import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, readdir, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { Homes, AccountListSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';
import { createRuntime as createClaude } from '../../runtimes/claude/dist/index.js';
import { createRuntime as createCodex } from '../../runtimes/codex/dist/index.js';

const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
if (!option('--root') || !option('--account')) throw new Error('An explicit dedicated --root and --account are required.');
const sourceHomes = new Homes(option('--root')); const source = sourceHomes.account('codex', option('--account'));
await access(join(source, 'auth.json'));
const root = await mkdtemp(join(tmpdir(), 'jevellan-live-settings-')); const user = join(root, 'user'); await mkdir(user);
const homes = new Homes(join(user, '.jevellan'), user);
let borrowed; let browser; let server; let app; let restored = false;
const evidence = { schema: 'live-settings-v1', evidence: 'live-Codex-readiness-with-simulated-browser-approval', accountAddedInUi: false, readyInUi: false, modelsDiscovered: false, skillDelivered: false, loginReturnedToSource: false };
try {
  app = new Application({ homes, timers: false, runtimes: (context) => {
    const codex = createCodex(context);
    // Section 16 permits the prepared test login to stand in for browser approval.
    // Move the entire home; never duplicate a rotating refresh credential.
    codex.beginLogin = async (_account, target) => {
      assert(!borrowed, 'This fixture permits only one login.');
      await rename(target, join(root, 'empty-account-home'));
      await rename(source, target); borrowed = target;
      return { instructions: 'Using the dedicated test login; browser approval is simulated.', poll: async () => 'done', cancel: async () => {} };
    };
    return new Map([['claude', createClaude(context)], ['codex', codex]]);
  } });
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}); const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page.setDefaultTimeout(30_000);
  const errors = []; page.on('pageerror', () => errors.push('Browser script error.'));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Passphrase').fill(randomBytes(24).toString('hex')); await page.getByRole('button', { name: 'Set passphrase', exact: true }).click();
  const codex = page.locator('.runtime-card').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) });
  await codex.getByRole('button', { name: 'Add account', exact: true }).click();
  const form = page.getByRole('dialog'); await form.getByLabel('Label', { exact: true }).fill('Dedicated live test'); await form.getByRole('button', { name: 'Add account', exact: true }).click();
  evidence.accountAddedInUi = true;
  await expect(form.getByRole('status')).toContainText('Signed in', { timeout: 60_000 });
  await form.getByRole('button', { name: 'Close panel' }).click(); await expect(form).not.toBeVisible();
  const account = codex.locator('.account').filter({ hasText: 'Dedicated live test' });
  await expect(account.getByText('Ready', { exact: true }).first()).toBeVisible();
  const response = await page.request.get(`http://127.0.0.1:${server.address().port}/hub/accounts`);
  const accounts = AccountListSchema.parse(await response.json());
  assert(accounts.accounts.length === 1 && accounts.accounts[0].statuses.some((status) => status.auth === 'ready'));
  evidence.readyInUi = true; evidence.modelsDiscovered = (await app.accounts.offered()).some((entry) => entry.runtime === 'codex' && entry.models.length > 0);
  assert(evidence.modelsDiscovered);
  await page.screenshot({ path: 'docs/acceptance/screenshots/phase1-live-codex-ready.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Rigging', exact: true }).click();
  await page.getByRole('button', { name: 'Add local item' }).click(); await form.getByLabel('Name', { exact: true }).fill('Live fixture skill');
  await form.getByRole('textbox', { name: 'Content', exact: true }).fill('## Live fixture\nThis skill was delivered through the Jevellan UI.');
  await form.getByRole('button', { name: 'Add item', exact: true }).click(); await expect(form).not.toBeVisible();
  async function delivered(path) {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && await delivered(file)) return true;
      if (entry.isFile() && entry.name === 'SKILL.md' && (await readFile(file, 'utf8')).includes('This skill was delivered through the Jevellan UI.')) return true;
    }
    return false;
  }
  await expect.poll(() => delivered(join(borrowed, 'skills')), { timeout: 30_000 }).toBe(true);
  evidence.skillDelivered = true; assert.equal(errors.length, 0);
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await app?.close();
  if (borrowed) {
    assert(!await access(source).then(() => true, () => false), 'The original login destination unexpectedly exists; the borrowed home is preserved for recovery.');
    await rename(borrowed, source); evidence.loginReturnedToSource = true;
  }
  restored = true;
  await rm(root, { recursive: true, force: true });
}
assert(restored);
console.log(JSON.stringify({ ...evidence, passed: Object.entries(evidence).filter(([, value]) => typeof value === 'boolean').every(([, value]) => value) }, null, 2));
