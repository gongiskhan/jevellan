import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { AccountSchema, Homes, ProjectSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

// An opt-in live demonstration. It uses only the explicitly named prepared test home.
const option = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
for (const name of ['--home', '--account', '--output', '--sandbox']) assert(option(name), `${name} is required`);
const homes = new Homes(option('--home'));
assert(existsSync(join(homes.root, 'homes/codex', option('--account'), 'auth.json')), 'Dedicated login missing');
const output = resolve(option('--output')); const projectPath = resolve(option('--sandbox'));
const captureId = option('--capture-id');
assert(captureId ? existsSync(projectPath) : !existsSync(projectPath), 'Use a new disposable sandbox, or explicitly capture an existing run');
mkdirSync(output, { recursive: true });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const origin = `${projectPath}-origin.git`;
if (!captureId) {
mkdirSync(projectPath, { recursive: true }); mkdirSync(join(projectPath, 'src')); assert(!existsSync(origin));
git(projectPath, 'init', '--bare', '--initial-branch=main', origin);
git(projectPath, 'init', '--initial-branch=main'); git(projectPath, 'remote', 'add', 'origin', origin);
writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'jevellan-progress-sandbox', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2) + '\n');
writeFileSync(join(projectPath, 'vitest.config.ts'), 'export default { test: { globals: true } };\n');
writeFileSync(join(projectPath, 'src/sum.ts'), 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n');
writeFileSync(join(projectPath, 'src/sum.test.ts'), "import { sum } from './sum';\n\ntest('adds two numbers', () => { expect(sum(2, 3)).toBe(5); });\n");
writeFileSync(join(projectPath, 'AGENTS.md'), '# Progress sandbox\nUse TypeScript and Vitest with globals enabled. Run npm test. Preserve existing behavior. Do not install dependencies.\n');
writeFileSync(join(projectPath, '.gitignore'), 'node_modules/\n');
symlinkSync(resolve('node_modules'), join(projectPath, 'node_modules'), 'dir');
git(projectPath, 'add', '-A'); git(projectPath, 'commit', '-m', 'Seed Jevellan progress sandbox'); git(projectPath, 'push', '-u', 'origin', 'main');
}
const before = git(projectPath, 'rev-list', '--max-parents=0', 'HEAD');
const app = new Application({ homes, timers: false }); let server; let browser;
const conversationId = captureId ?? `progress_${Date.now()}`;
const evidence = { schema: 'progress-demo-v1', at: new Date().toISOString(), evidence: 'live-Codex-manual-selection-local-origin', conversationId, classification: { source: 'manual', jevCalled: false, reason: 'Phase 3 is not implemented; the dedicated Jev test key is absent.' }, screenshots: [], checks: {}, steps: [] };
try {
  const adapter = app.runtimes.get('codex'); const start = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    const run = start(input);
    void run.done.then((result) => { evidence.runtimeResult = app.hub.redactor.document(result); if (result.error) console.log(app.hub.redactor.text(result.error.message)); });
    return run;
  };
  await app.conversations.ready;
  const accountId = option('--account');
  if (!app.hub.get('accounts', accountId, AccountSchema)) app.hub.put('accounts', accountId, AccountSchema, AccountSchema.parse({ schema: 'account-v1', id: accountId, runtime: 'codex', label: 'Dedicated Codex test account', kind: 'subscription', enabled: true, credential: 'per-device' }), 0);
  if (!captureId) {
    console.log('Checking the dedicated Codex account.');
    assert.equal((await app.accounts.check(accountId)).auth, 'ready', 'Dedicated Codex login is not ready');
    await app.accounts.discover(accountId);
  }
  const model = app.hub.configuration.current().configuration['x-jevellan'].menu.find((item) => item.runtime === 'codex' && item.enabled);
  assert(model, 'No available Codex model'); evidence.model = model.model;
  if (!captureId) await app.applyRigging();
  if (!captureId) await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: conversationId, name: 'Live progress sandbox', paths: { [app.device.deviceId]: projectPath }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
  if (!app.auth.configured()) await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: randomBytes(32).toString('hex') });
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(30_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const request = async (path, body) => {
    const response = await page.request.post(`${url}${path}`, { data: body });
    assert(response.ok(), `API request failed (${response.status()}): ${await response.text()}`); return response.json();
  };
  if (!captureId) await request('/api/conversations', { schema: 'start-conversation-v1', id: conversationId, projectId: conversationId, title: 'Live demo · multiply with tests', message: 'Add an exported multiply(a: number, b: number) function to src/sum.ts. Preserve sum. Add Vitest tests covering positive numbers, negative numbers and zero. Run npm test. Keep the change small, install nothing, and hand off when finished.', clientMessageId: `message_${Date.now()}` });
  await page.goto(`${url}/conversations/${conversationId}`);
  const picker = page.locator('.manual-picker');
  const capture = async (name) => { await expect(page.getByText(/^Rendering(?:\.\.\.|…)$/)).toHaveCount(0); if (['conversation', 'phone'].includes(name)) await expect(page.locator('.stretch-block .markdown').first()).toBeVisible(); assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'Horizontal overflow'); await page.screenshot({ path: join(output, `${name}.png`), fullPage: await page.getByRole('dialog').count() === 0 }); evidence.screenshots.push(`${name}.png`); };
  if (!captureId) {
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('implement');
  await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id);
  await picker.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(model.efforts.includes('low') ? 'low' : model.efforts[0]);
  await capture('manual-choice');
  console.log('Launching an actual Codex implementation through the UI.');
  await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible({ timeout: 90_000 });
  await capture('running');
  await app.conversations.wait(conversationId);
  }
  let view = (await app.conversations.view(conversationId));
  assert.equal(view.stretches[0]?.status, 'completed', `Implementation did not complete: ${view.notices?.at(-1)?.text ?? view.conversation.state}`);
  assert.equal(view.handoffs[0]?.status, 'done', 'Runtime handoff did not report completion');
  if (!captureId) {
  console.log('The model handed off. Running Jevellan verification and local publication.');
  await page.reload(); await expect(picker).toBeVisible();
  await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption('done');
  await picker.getByRole('button', { name: 'Continue', exact: true }).click();
  await app.conversations.wait(conversationId);
  }
  await expect(page.locator('.conversation-page > .muted')).toContainText('Done', { timeout: 90_000 });
  view = (await app.conversations.view(conversationId));
  assert.equal(view.conversation.state, 'done');
  const after = git(projectPath, 'rev-parse', 'HEAD');
  assert.notEqual(after, before); assert.equal(git(projectPath, 'rev-parse', 'origin/main'), after); assert.equal(git(projectPath, 'status', '--porcelain'), '');
  const verification = (await app.conversations.changes(conversationId, 1)).verifications.at(-1); assert(verification?.passed && verification.commit === after && verification.treeClean);
  evidence.checks = { realRuntime: true, structuredHandoff: true, independentVerification: true, publishedToLocalOrigin: true, cleanTree: true, browserErrors: errors.length };
  evidence.before = before; evidence.after = after; evidence.verification = verification;
  evidence.diff = git(projectPath, 'diff', before, after, '--', 'src');
  evidence.steps = view.stretches.map(({ n, action, model, effortRequested, effortEffective, status, usage, startedAt, endedAt }) => ({ n, action, model, effortRequested, effortEffective, status, usage, startedAt, endedAt }));
  evidence.handoffs = view.handoffs; evidence.decisions = app.conversations.decisions(conversationId);
  evidence.events = app.conversations.ledger(conversationId).events().filter((event) => ['text', 'tool-start', 'tool-end', 'verification', 'publication'].includes(event.type)).map(({ t, type, data }) => ({ t, type, data: app.hub.redactor.document(data) }));
  await page.reload(); await capture('conversation');
  await page.getByRole('button', { name: 'Changes', exact: true }).first().click(); await expect(page.getByRole('dialog')).toContainText('Passed'); await capture('changes');
  await page.getByRole('dialog').evaluate((dialog) => { dialog.scrollTop = dialog.scrollHeight; }); await capture('verification');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Why', exact: true }).first().click(); await capture('why-manual');
  await page.getByRole('button', { name: 'Close panel' }).click();
  for (const path of ['projects', 'rigging', 'decisions']) { await page.goto(`${url}/settings/${path}`); await expect(page.getByRole('heading', { name: path === 'projects' ? 'Projects' : path === 'rigging' ? 'Rigging' : 'Decisions', exact: true }).first()).toBeVisible(); await capture(path); }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${url}/conversations/${conversationId}`); await expect(page.getByRole('heading', { name: 'Step 1 · Implement' })).toBeVisible(); await capture('phone');
  assert.equal(errors.length, 0); evidence.passed = true;
  console.log('Live implementation, independent verification, local publication and UI capture passed.');
} catch (error) {
  evidence.passed = false; evidence.error = app.hub.redactor.text(error instanceof Error ? error.message : 'Live demo failed'); console.log(evidence.error); process.exitCode = 1;
} finally {
  const data = z.object({ schema: z.literal('progress-demo-v1'), passed: z.boolean(), classification: z.object({ source: z.literal('manual'), jevCalled: z.literal(false) }) }).passthrough().parse(evidence);
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(app.hub.redactor.document(data), null, 2) + '\n', { mode: 0o600 });
  await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
