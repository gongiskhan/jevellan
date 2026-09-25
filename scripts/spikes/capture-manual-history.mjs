import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { Homes } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--home', '--id', '--output']) assert(option(name), `${name} is required`);
const id = option('--id'); const output = resolve(option('--output')); assert(!existsSync(output)); mkdirSync(output, { recursive: true, mode: 0o700 });
const app = new Application({ homes: new Homes(option('--home')), timers: false }); let server; let browser;
const evidence = { schema: 'history-capture-v1', at: new Date().toISOString(), conversationId: id, passed: false, newModelCalls: 0, screenshots: [] };
try {
  await app.conversations.ready; const view = (await app.conversations.view(id)); assert.equal(view.conversation.state, 'done'); assert(view.stretches.length > 0 && view.stretches.every((step) => step.runtime === 'codex')); assert(app.auth.configured());
  for (const adapter of app.runtimes.values()) adapter.startStretch = () => { throw new Error('History capture must not launch a runtime'); };
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]); const page = await context.newPage(); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const capture = async (name, fullPage = false) => { assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)); await page.screenshot({ path: join(output, `${name}.png`), fullPage, animations: 'disabled' }); evidence.screenshots.push(`${name}.png`); };
  await page.goto(`${url}/conversations/${id}`); await expect(page.locator('.conversation-page > .muted')).toContainText('Done'); await expect(page.getByText(/^Rendering(?:\.\.\.|…)$/)).toHaveCount(0); await capture('conversation', true);
  const dialog = page.getByRole('dialog'); await page.getByRole('button', { name: 'Why', exact: true }).first().click(); await expect(dialog).toContainText('This step was picked manually.'); await capture('why'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  if (view.stretches.some((step) => step.action === 'implement')) {
    await page.getByRole('button', { name: 'Changes', exact: true }).first().click(); await expect(dialog).toContainText('Passed'); await capture('changes');
    await dialog.getByRole('heading', { name: 'Jevellan verification', exact: true }).scrollIntoViewIfNeeded(); await capture('verification'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => globalThis.scrollTo(0, 0));
  await expect.poll(() => page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0); await capture('phone', true);
  assert.equal(errors.length, 0); evidence.passed = true; console.log('Completed-history captures passed without runtime launches.');
} catch (error) { evidence.error = app.hub.redactor.text(error instanceof Error ? error.message : 'Capture failed'); process.exitCode = 1; console.log(evidence.error); }
finally {
  const document = z.object({ schema: z.literal('history-capture-v1'), at: z.iso.datetime(), conversationId: z.string(), passed: z.boolean(), newModelCalls: z.literal(0), screenshots: z.array(z.string()), error: z.string().optional() }).parse(evidence);
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(document, null, 2) + '\n', { mode: 0o600 }); await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
