import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { Homes, ProjectSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--home', '--account', '--sandbox', '--output']) assert(option(name), `${name} is required`);
const homes = new Homes(option('--home')); const accountId = option('--account'); const sandbox = resolve(option('--sandbox')); const output = resolve(option('--output'));
const captureId = option('--capture-id'); const projectId = 'acceptance_integration'; const projectName = 'Integration acceptance sandbox'; const origin = `${sandbox}-origin.git`; const peer = `${sandbox}-peer`;
assert(existsSync(homes.at('homes/codex', accountId, 'auth.json')), 'Dedicated Codex login missing');
assert(!existsSync(output), 'Use a new evidence directory'); mkdirSync(output, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!existsSync(sandbox)) {
  assert(!captureId && !existsSync(origin) && !existsSync(peer)); mkdirSync(sandbox, { recursive: true }); mkdirSync(join(sandbox, 'src'));
  git(sandbox, 'init', '--bare', '--initial-branch=main', origin); git(sandbox, 'init', '--initial-branch=main'); git(sandbox, 'remote', 'add', 'origin', origin);
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'jevellan-integration-acceptance-sandbox', private: true, type: 'module', scripts: { test: 'vitest run --configLoader runner' } }, null, 2) + '\n');
  writeFileSync(join(sandbox, 'vitest.config.ts'), 'export default { test: { globals: true } };\n');
  writeFileSync(join(sandbox, 'src/greet.ts'), "export function greet(name: string): string { return 'Hello, ' + name + '!'; }\n");
  writeFileSync(join(sandbox, 'src/greet.test.ts'), "import { greet } from './greet';\ntest('greets by name', () => expect(greet('Sky')).toBe('Hello, Sky!'));\n");
  writeFileSync(join(sandbox, 'AGENTS.md'), '# Integration acceptance sandbox\nUse TypeScript. Run npm test. Preserve both sides of a publication conflict. Do not install dependencies. Use the Jevellan integration tool when the action is integrate.\n');
  writeFileSync(join(sandbox, '.gitignore'), 'node_modules/\n'); symlinkSync(resolve('node_modules'), join(sandbox, 'node_modules'), 'dir');
  git(sandbox, 'add', '-A'); git(sandbox, 'commit', '-m', 'Seed integration acceptance sandbox'); git(sandbox, 'push', '-u', 'origin', 'main'); git(sandbox, 'clone', origin, peer);
}
assert.equal(JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8')).name, 'jevellan-integration-acceptance-sandbox');
assert.equal(git(sandbox, 'remote', 'get-url', 'origin'), origin); assert.equal(git(peer, 'remote', 'get-url', 'origin'), origin); assert.equal(git(sandbox, 'branch', '--show-current'), 'main'); assert.equal(git(sandbox, 'status', '--porcelain'), '');
const evidence = { schema: 'manual-integration-acceptance-v1', at: new Date().toISOString(), passed: false, source: 'live-codex-manual-selection', jevCalled: false, checks: {}, screenshots: [], launches: [] };
const app = new Application({ homes, timers: false }); let server; let browser;
try {
  await app.conversations.ready;
  if (!captureId) assert.equal((await app.accounts.check(accountId)).auth, 'ready');
  const model = app.hub.configuration.current().configuration['x-jevellan'].menu.find((item) => item.runtime === 'codex' && item.enabled); assert(model); evidence.model = model.model;
  const adapter = app.runtimes.get('codex'); const nativeStart = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    assert(!captureId, 'Capture mode must not launch a runtime'); assert.equal(input.account.account.id, accountId); assert.equal(input.account.home, homes.at('homes/codex', accountId)); assert.equal(input.cwd, sandbox);
    const launch = { stretch: input.stretch, action: input.action, permissions: input.permissions, beforeHead: git(sandbox, 'rev-parse', 'HEAD') }; evidence.launches.push(launch);
    const run = nativeStart(input); void run.done.then((result) => { launch.status = result.status; }).catch(() => { launch.status = 'failed'; }); return run;
  };
  const existing = app.hub.get('projects', projectId, ProjectSchema); assert(!existing || captureId, 'This acceptance project already exists; inspect its saved work before retrying');
  if (!existing) {
    await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { schema: 'project-v1', id: projectId, name: projectName, paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } } });
    for (const operation of (await app.conversations.contextPanel(projectId)).operations) await app.conversations.wait(operation.conversationId);
  }
  assert.equal(app.hub.get('projects', projectId, ProjectSchema).document.paths[app.device.deviceId], sandbox); assert(app.auth.configured());
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]); const page = await context.newPage(); page.setDefaultTimeout(90_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const id = captureId ?? `acceptance_integration_${Date.now()}`; evidence.conversationId = id;
  const request = async (path, body) => { const response = await page.request.post(`${url}${path}`, { data: body }); assert(response.ok(), `Request failed (${response.status()})`); return response.json(); };
  const step = async (action) => {
    const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
    if (action !== 'done') { await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id); await picker.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(model.efforts.includes('low') ? 'low' : model.efforts[0]); }
    const response = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/conversations/${id}/manual`);
    await picker.getByRole('button', { name: 'Continue', exact: true }).click(); assert.equal((await response).status(), 202); await app.conversations.wait(id);
  };
  const capture = async (name, fullPage = false) => { assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'Horizontal overflow'); await page.screenshot({ path: join(output, `${name}.png`), fullPage, animations: 'disabled' }); evidence.screenshots.push(`${name}.png`); };
  if (!captureId) await request('/api/conversations', { schema: 'start-conversation-v1', id, projectId, title: 'Preserve both sides of a publication conflict', message: 'Add an optional excited boolean parameter, defaulting to false, to greet(name) in src/greet.ts. When excited is true, append one extra exclamation mark to the normal greeting. Keep the greeting prefix and default behavior otherwise. Add tests for both modes and run npm test. Do not install dependencies.', clientMessageId: `${id}_request` });
  await page.goto(`${url}/conversations/${id}`);
  let checkpoint;
  if (!captureId) {
    console.log('Running the actual implementation before introducing an independent upstream conflict.');
    await step('implement'); const implemented = (await app.conversations.view(id)); assert.equal(implemented.stretches.at(-1)?.status, 'completed', implemented.pause?.reason); assert.equal(implemented.handoffs.at(-1)?.status, 'done'); assert.equal(git(sandbox, 'status', '--porcelain'), ''); checkpoint = git(sandbox, 'rev-parse', 'HEAD'); evidence.checkpoint = checkpoint;
    assert.equal(git(peer, 'status', '--porcelain'), ''); writeFileSync(join(peer, 'src/greet.ts'), "export function greet(name: string): string { return 'Hi, ' + name + '!'; }\n");
    writeFileSync(join(peer, 'src/greet.test.ts'), "import { greet } from './greet';\ntest('greets by name', () => expect(greet('Sky')).toBe('Hi, Sky!'));\n"); writeFileSync(join(peer, 'upstream.txt'), 'Keep the independently published upstream work.\n');
    git(peer, 'add', '-A'); git(peer, 'commit', '-m', 'Use a shorter greeting and preserve upstream work'); git(peer, 'push', 'origin', 'main');
    await page.reload(); console.log('Publishing through the UI; Jevellan must start the integration stretch itself.'); await step('done');
  }
  const view = (await app.conversations.view(id)); assert.equal(view.conversation.state, 'done', view.pause?.reason); assert.deepEqual(view.stretches.map(({ action, status }) => [action, status]), [['implement', 'completed'], ['integrate', 'completed']]);
  checkpoint ??= git(sandbox, 'rev-parse', `refs/jevellan/pre-integration/${id}/2`); const after = git(sandbox, 'rev-parse', 'HEAD'); const upstream = git(peer, 'rev-parse', 'HEAD');
  assert.equal(git(sandbox, 'status', '--porcelain'), ''); assert.equal(git(origin, 'rev-parse', 'main'), after); git(sandbox, 'merge-base', '--is-ancestor', upstream, after);
  assert.equal(git(sandbox, 'rev-parse', `refs/jevellan/pre-integration/${id}/2`), checkpoint); assert.equal(readFileSync(join(sandbox, 'upstream.txt'), 'utf8'), 'Keep the independently published upstream work.\n');
  for (const path of ['rebase-merge', 'rebase-apply']) assert(!existsSync(resolve(sandbox, git(sandbox, 'rev-parse', '--git-path', path))));
  assert(!/^(?:<{7}|={7}|>{7})/m.test(readFileSync(join(sandbox, 'src/greet.ts'), 'utf8')));
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import assert from 'node:assert/strict';const{greet}=await import('./src/greet.ts');assert.equal(greet('Sky'),'Hi, Sky!');assert.equal(greet('Sky',false),'Hi, Sky!');assert.equal(greet('Sky',true),'Hi, Sky!!');"], { cwd: sandbox, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const ledger = app.conversations.ledger(id); const events = ledger.events(); const toolStarts = events.filter((event) => event.type === 'tool-start' && event.stretch === 2).map((event) => ledger.data(event)).filter((event) => event.name?.endsWith('jevellan_integrate'));
  const calls = toolStarts.map((event) => ({ command: event.input.command, ok: events.filter((end) => end.type === 'tool-end' && end.stretch === 2).map((end) => ledger.data(end)).some((end) => end.id === event.id && end.ok) }));
  assert(calls.some((call) => call.command === 'start' && call.ok)); assert(calls.some((call) => call.command === 'continue' && call.ok));
  const rewrites = events.filter((event) => event.type === 'git').map((event) => ledger.data(event)).filter((event) => event.schema === 'git-rewrite-receipt-v1'); assert(rewrites.some((receipt) => receipt.plan.before === checkpoint && receipt.pairs.length > 0));
  const verifications = events.filter((event) => event.type === 'verification').map((event) => ledger.data(event)); assert(verifications.some((receipt) => receipt.commit === checkpoint && receipt.trigger === 'done-gate' && receipt.passed)); assert(verifications.some((receipt) => receipt.commit === after && receipt.trigger === 'publication' && receipt.passed && receipt.treeClean && receipt.headStable));
  const project = app.hub.get('projects', projectId, ProjectSchema).document; assert.equal((await app.conversations.ownership.current(project))?.held, false);
  evidence.checks = { realRuntime: true, ownerStartedIntegration: true, nativeIntegrationTool: true, savedPreIntegrationRef: true, nativeRewriteMapping: true, bothSidesPreserved: true, verifiedBeforeAndAfterRebase: true, cleanPublishedTree: true, ownershipReleased: true, noAttributionTrailers: !/^(?:Co-authored-by|Generated-by):/im.test(git(sandbox, 'log', '--format=%B', `${view.closedWorks.at(-1).baseCommit}..${after}`)) };
  assert(Object.values(evidence.checks).every(Boolean)); evidence.checkpoint = checkpoint; evidence.upstream = upstream; evidence.after = after; evidence.integrationCalls = calls; evidence.rewrites = rewrites.map(({ plan, after, pairs }) => ({ before: plan.before, upstream: plan.upstream, after, pairs })); evidence.verifications = verifications.map(({ command, commit, trigger, passed, treeClean }) => ({ command, commit, trigger, passed, treeClean })); evidence.diff = git(sandbox, 'diff', view.closedWorks.at(-1).baseCommit, after, '--', 'src', 'upstream.txt');
  await page.reload(); await expect(page.locator('.conversation-page > .muted')).toContainText('Done'); await capture('conversation', true); const integration = page.locator('.stretch-block').filter({ has: page.getByRole('heading', { name: 'Step 2 · Integrate', exact: true }) });
  await integration.getByRole('button', { name: 'Changes', exact: true }).click(); const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Passed'); await dialog.getByRole('heading', { name: 'Jevellan verification', exact: true }).scrollIntoViewIfNeeded(); await capture('verification'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => globalThis.scrollTo(0, 0)); await expect.poll(() => page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0); await capture('phone', true); assert.equal(errors.length, 0); evidence.passed = true; console.log('Live integration passed: native bridge calls, conflict resolution, rewrite mapping, verification and publication.');
} catch (error) { evidence.error = app.hub.redactor.text(error instanceof Error ? error.message : 'Acceptance failed').replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[identifier omitted]'); process.exitCode = 1; console.log(evidence.error); }
finally {
  const document = z.object({ schema: z.literal('manual-integration-acceptance-v1'), at: z.iso.datetime(), passed: z.boolean(), source: z.literal('live-codex-manual-selection'), jevCalled: z.literal(false), checks: z.record(z.string(), z.boolean()), screenshots: z.array(z.string()), launches: z.array(z.unknown()) }).passthrough().parse(evidence);
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(app.hub.redactor.document(document), null, 2) + '\n', { mode: 0o600 }); await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
