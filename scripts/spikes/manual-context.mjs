import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { AccountSchema, Homes, ProjectSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--home', '--account', '--sandbox', '--output']) assert(option(name), `${name} is required`);
const homes = new Homes(option('--home')); const accountId = option('--account'); const sandbox = resolve(option('--sandbox')); const output = resolve(option('--output'));
const resume = process.argv.includes('--resume'); const projectId = 'acceptance_context'; const projectName = 'Context acceptance sandbox'; const origin = `${sandbox}-origin.git`;
assert(existsSync(homes.at('homes/codex', accountId, 'auth.json')), 'Dedicated Codex login missing');
assert(!existsSync(output), 'Use a new evidence directory'); mkdirSync(output, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const git = (...args) => execFileSync('git', args, { cwd: sandbox, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!existsSync(sandbox)) {
  assert(!resume && !existsSync(origin)); mkdirSync(sandbox, { recursive: true }); mkdirSync(join(sandbox, 'src'));
  git('init', '--bare', '--initial-branch=main', origin); git('init', '--initial-branch=main'); git('remote', 'add', 'origin', origin);
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'jevellan-context-acceptance-sandbox', private: true, type: 'module', scripts: { test: 'vitest run --configLoader runner' } }, null, 2) + '\n');
  writeFileSync(join(sandbox, 'vitest.config.ts'), 'export default { test: { globals: true } };\n');
  writeFileSync(join(sandbox, 'src/sum.ts'), 'export function sum(a: number, b: number): number { return a + b; }\n');
  writeFileSync(join(sandbox, 'src/sum.test.ts'), "import { sum } from './sum';\ntest('sum adds numbers', () => expect(sum(2, 3)).toBe(5));\n");
  writeFileSync(join(sandbox, 'AGENTS.md'), '# Project instructions\nUse TypeScript. Run npm test. Do not install dependencies.\n');
  writeFileSync(join(sandbox, 'CLAUDE.md'), '# Additional project instructions\nPrefer named exports. Keep existing tests. Do not install dependencies.\n');
  writeFileSync(join(sandbox, '.gitignore'), 'node_modules/\n'); writeFileSync(join(sandbox, '.git/info/exclude'), 'CLAUDE.md\n');
  symlinkSync(resolve('node_modules'), join(sandbox, 'node_modules'), 'dir'); git('add', '-A'); git('commit', '-m', 'Seed context acceptance sandbox'); git('push', '-u', 'origin', 'main');
}
assert.equal(JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8')).name, 'jevellan-context-acceptance-sandbox');
assert.equal(git('remote', 'get-url', 'origin'), origin); assert.equal(git('branch', '--show-current'), 'main'); assert.equal(git('status', '--porcelain'), '');
const evidence = { schema: 'manual-context-acceptance-v1', at: new Date().toISOString(), passed: false, source: 'live-codex-manual-selection', jevCalled: false, checks: {}, screenshots: [], launches: [] };
const app = new Application({ homes, timers: false }); let server; let browser;
try {
  await app.conversations.ready; assert(app.hub.get('accounts', accountId, AccountSchema)); assert.equal((await app.accounts.check(accountId)).auth, 'ready');
  const model = app.hub.configuration.current().configuration['x-jevellan'].menu.find((item) => item.runtime === 'codex' && item.enabled); assert(model); evidence.model = model.model;
  const adapter = app.runtimes.get('codex'); const nativeStart = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    assert.equal(input.account.account.id, accountId); assert.equal(input.account.home, homes.at('homes/codex', accountId)); assert.equal(input.cwd, sandbox);
    const launch = { action: input.action, permissions: input.permissions, memoryWrite: input.memoryWrite, beforeHead: git('rev-parse', 'HEAD'), beforeStatus: git('status', '--porcelain') }; evidence.launches.push(launch);
    const run = nativeStart(input); void run.done.then((result) => { launch.status = result.status; launch.afterHead = git('rev-parse', 'HEAD'); launch.afterStatus = git('status', '--porcelain'); }).catch(() => { launch.status = 'failed'; }); return run;
  };
  const existing = app.hub.get('projects', projectId, ProjectSchema); assert(!existing || resume, 'Use --resume for this existing acceptance project');
  if (!existing) await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { schema: 'project-v1', id: projectId, name: projectName, paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } } });
  assert.equal(app.hub.get('projects', projectId, ProjectSchema).document.paths[app.device.deviceId], sandbox);
  if (!app.auth.configured()) await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: randomBytes(32).toString('hex') });
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]); const page = await context.newPage(); page.setDefaultTimeout(90_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const capture = async (name) => { assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'Horizontal overflow'); await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' }); evidence.screenshots.push(`${name}.png`); };
  await page.goto(`${url}/settings/projects`); const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: projectName, exact: true }) }); await card.getByRole('button', { name: 'Context', exact: true }).click(); const dialog = page.getByRole('dialog');
  let operation = (await app.conversations.contextPanel(projectId)).operations.at(-1);
  if (!operation) {
    assert((await app.conversations.context(projectId)).files.every((file) => file.kind === 'file')); await expect(dialog).toContainText('has both AGENTS.md and CLAUDE.md'); await capture('choice');
    await dialog.getByLabel('Draft model').selectOption(model.id); const response = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/projects/${projectId}/context/operations`);
    await dialog.getByRole('button', { name: 'Merge them into AGENTS.md', exact: true }).click(); assert((await response).ok()); operation = (await app.conversations.contextPanel(projectId)).operations.at(-1); assert(operation); await app.conversations.wait(operation.conversationId); operation = (await app.conversations.contextPanel(projectId)).operations.at(-1);
  }
  assert(operation); evidence.conversationId = operation.conversationId;
  if (operation.status !== 'completed') {
    assert.equal(operation.status, 'draft-ready', operation.reason); assert.match(operation.draft, /TypeScript/i); assert.match(operation.draft, /named exports/i); assert.match(operation.draft, /existing tests/i); assert.match(operation.draft, /npm test/i);
    assert.equal((await app.conversations.context(projectId)).fingerprint, operation.before.fingerprint, 'Drafting changed the source files'); assert.equal(git('status', '--porcelain'), '');
    if (!resume) assert(evidence.launches.length === 1 && evidence.launches.every((entry) => entry.permissions === 'read-only' && !entry.memoryWrite && entry.status === 'completed' && entry.beforeHead === entry.afterHead && entry.beforeStatus === entry.afterStatus));
    evidence.checks.readOnlyDraftPreservedFiles = true; await expect(dialog.getByLabel('Context merge diff')).toContainText('named exports'); await capture('draft');
    await page.setViewportSize({ width: 390, height: 844 }); await capture('draft-phone'); await page.setViewportSize({ width: 1440, height: 900 });
    const response = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/projects/${projectId}/context/continue`);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); assert((await response).ok()); await app.conversations.wait(operation.conversationId); operation = (await app.conversations.contextPanel(projectId)).operations.at(-1);
  }
  assert.equal(operation.status, 'completed', operation.reason); assert(operation.approved && operation.applied); assert.equal((await app.conversations.context(projectId)).state, 'linked');
  const merged = readFileSync(join(sandbox, 'AGENTS.md'), 'utf8'); assert.equal(merged, operation.draft); assert(lstatSync(join(sandbox, 'CLAUDE.md')).isSymbolicLink()); assert.equal(readlinkSync(join(sandbox, 'CLAUDE.md')), 'AGENTS.md');
  assert.equal(git('status', '--porcelain'), ''); const after = git('rev-parse', 'HEAD'); assert.equal(git('rev-parse', 'origin/main'), after);
  const changes = await app.conversations.changes(operation.conversationId, operation.draftStretch); const receipt = changes.verifications.at(-1); assert(receipt?.passed && receipt.commit === after && receipt.treeClean);
  evidence.checks = { ...evidence.checks, approvedDraftApplied: true, compatibilityLinkCreated: true, independentVerification: true, cleanPublishedTree: true, noAttributionTrailers: !/^(?:Co-authored-by|Generated-by):/im.test(git('log', '-1', '--format=%B')) };
  assert(Object.values(evidence.checks).every(Boolean)); evidence.after = after; evidence.draft = merged; evidence.verification = { command: receipt.command, commit: receipt.commit, passed: receipt.passed, treeClean: receipt.treeClean };
  await expect(dialog).toContainText('Context change completed.'); await expect(dialog).toContainText('Linked: CLAUDE.md'); await capture('linked'); assert.equal(errors.length, 0); evidence.passed = true; console.log('Live Codex context merge passed: read-only draft, UI Apply, independent verification and local publication.');
} catch (error) { evidence.error = app.hub.redactor.text(error instanceof Error ? error.message : 'Acceptance failed').replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[identifier omitted]'); process.exitCode = 1; console.log(evidence.error); }
finally {
  const document = z.object({ schema: z.literal('manual-context-acceptance-v1'), at: z.iso.datetime(), passed: z.boolean(), source: z.literal('live-codex-manual-selection'), jevCalled: z.literal(false), checks: z.record(z.string(), z.boolean()), screenshots: z.array(z.string()), launches: z.array(z.unknown()) }).passthrough().parse(evidence);
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(app.hub.redactor.document(document), null, 2) + '\n', { mode: 0o600 }); await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
