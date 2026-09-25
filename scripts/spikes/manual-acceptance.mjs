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

// Explicitly opt in to real Codex calls with a dedicated, already-prepared home.
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--home', '--account', '--sandbox', '--output', '--journey']) assert(option(name), `${name} is required`);
const journey = z.enum(['answer', 'change', 'memory']).parse(option('--journey'));
const homes = new Homes(option('--home')); const accountId = option('--account'); const sandbox = resolve(option('--sandbox')); const output = resolve(option('--output'));
assert(existsSync(homes.at('homes/codex', accountId, 'auth.json')), 'Dedicated Codex login missing');
assert(!existsSync(output), 'Use a new evidence directory for each attempt'); mkdirSync(output, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = `${sandbox}-origin.git`; const projectId = 'acceptance_sandbox';
if (!existsSync(sandbox)) {
  assert(!existsSync(origin), 'The sandbox origin already exists'); mkdirSync(sandbox, { recursive: true }); mkdirSync(join(sandbox, 'src'));
  git(sandbox, 'init', '--bare', '--initial-branch=main', origin); git(sandbox, 'init', '--initial-branch=main'); git(sandbox, 'remote', 'add', 'origin', origin);
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'jevellan-acceptance-sandbox', private: true, type: 'module', scripts: { test: 'vitest run --configLoader runner' } }, null, 2) + '\n');
  writeFileSync(join(sandbox, 'vitest.config.ts'), 'export default { test: { globals: true } };\n');
  writeFileSync(join(sandbox, 'src/sum.ts'), 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(join(sandbox, 'src/sum.test.ts'), "import { sum } from './sum';\n\ntest('adds two numbers', () => { expect(sum(2, 3)).toBe(5); });\n");
  writeFileSync(join(sandbox, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Jevellan sandbox</title><h1>Jevellan acceptance sandbox</h1><p>A small TypeScript project.</p></html>\n');
  writeFileSync(join(sandbox, 'AGENTS.md'), '# Acceptance sandbox\nUse TypeScript. Run npm test. Preserve existing behavior. Do not install dependencies. Use the Jevellan bridge for project memory.\n');
  writeFileSync(join(sandbox, '.gitignore'), 'node_modules/\n'); symlinkSync(resolve('node_modules'), join(sandbox, 'node_modules'), 'dir');
  git(sandbox, 'add', '-A'); git(sandbox, 'commit', '-m', 'Seed Jevellan acceptance sandbox'); git(sandbox, 'push', '-u', 'origin', 'main');
}
assert.equal(JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8')).name, 'jevellan-acceptance-sandbox', 'This is not the isolated acceptance sandbox');
assert.equal(git(sandbox, 'remote', 'get-url', 'origin'), origin); assert.equal(git(sandbox, 'branch', '--show-current'), 'main'); assert.equal(git(sandbox, 'status', '--porcelain'), '');
const captureId = option('--capture-id'); const resumeId = option('--resume-id');
const continueRecall = process.argv.includes('--continue-recall');
const invalidJevKey = process.argv.includes('--invalid-jev-key');
assert(!(captureId && resumeId), 'Capture and resume are separate modes');
assert(!resumeId || journey === 'memory', 'Resume currently supports the memory journey only');
assert(!continueRecall || captureId && journey === 'memory', 'Continue recall requires a completed memory capture id');
assert(!invalidJevKey || journey === 'answer' && !captureId && !resumeId, 'The invalid-key journey requires a new answer-only run');
const conversationId = captureId ?? resumeId ?? `acceptance_${journey}_${Date.now()}`;
const before = git(sandbox, 'rev-parse', 'HEAD'); const evidence = { schema: 'manual-acceptance-v1', journey, at: new Date().toISOString(), passed: false, source: invalidJevKey ? 'live-codex-jev-auth-failure' : 'live-codex-manual-selection', jevCalled: false, checks: {}, screenshots: [], launches: [], ...(invalidJevKey ? { jevResponses: [] } : {}) };
const app = new Application({ homes, timers: false, ...(invalidJevKey ? { decisionFetch: async (input, init) => {
  evidence.jevCalled = true; const response = await fetch(input, init); evidence.jevResponses.push({ at: new Date().toISOString(), status: response.status });
  assert([401, 403].includes(response.status), `The deliberately invalid key did not receive an authentication rejection (${response.status})`); return response;
} } : {}) }); let server; let browser; let previousJev; let changedJev = false;
const redact = (value) => app.hub.redactor.text(String(value)).replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[identifier omitted]');
try {
  await app.conversations.ready;
  if (invalidJevKey) { if (app.hub.db.prepare('SELECT 1 FROM secrets WHERE id=?').get('jev')) previousJev = app.hub.vault.forLaunch('jev'); app.hub.vault.put('jev', `acceptance-invalid-${randomBytes(16).toString('hex')}`); changedJev = true; }
  const adapter = app.runtimes.get('codex'); const nativeStart = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    assert.equal(input.account.account.id, accountId, 'A different account was selected'); assert.equal(input.account.home, homes.at('homes/codex', accountId));
    const memorySection = input.brief.split('# Memory\n')[1]?.split('# Your step')[0] ?? '';
    const observation = { conversationId: input.conversationId, stretch: input.stretch, action: input.action, permissions: input.permissions, memoryWrite: input.memoryWrite, model: input.model, effort: input.effort, briefMemoryIncludesRule: /Vitest/i.test(memorySection) && /globals/i.test(memorySection), beforeHead: git(input.cwd, 'rev-parse', 'HEAD'), beforeStatus: git(input.cwd, 'status', '--porcelain') };
    evidence.launches.push(observation); const run = nativeStart(input);
    void run.done.then((result) => { observation.status = result.status; observation.afterRuntimeHead = git(input.cwd, 'rev-parse', 'HEAD'); observation.afterRuntimeStatus = git(input.cwd, 'status', '--porcelain'); }).catch((error) => { observation.error = redact(error.message); });
    return run;
  };
  if (!app.hub.get('accounts', accountId, AccountSchema)) app.hub.put('accounts', accountId, AccountSchema, { schema: 'account-v1', id: accountId, runtime: 'codex', label: 'Dedicated Codex test account', kind: 'subscription', enabled: true, credential: 'per-device' }, 0);
  if (!captureId || continueRecall) { assert.equal((await app.accounts.check(accountId)).auth, 'ready'); await app.accounts.discover(accountId); }
  const model = app.hub.configuration.current().configuration['x-jevellan'].menu.find((item) => item.runtime === 'codex' && item.enabled); assert(model, 'No discovered Codex model'); evidence.model = model.model;
  if (!app.hub.get('projects', projectId, ProjectSchema)) {
    await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { schema: 'project-v1', id: projectId, name: 'Acceptance sandbox', paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } } });
    for (const operation of (await app.conversations.contextPanel(projectId)).operations) await app.conversations.wait(operation.conversationId);
  }
  assert.equal(app.hub.get('projects', projectId, ProjectSchema).document.paths[app.device.deviceId], sandbox);
  const contextState = (await app.conversations.context(projectId)); const secondary = join(sandbox, 'CLAUDE.md');
  evidence.context = { state: contextState.state, claudeReadsAgents: contextState.claudeReadsAgents, linked: existsSync(secondary) && lstatSync(secondary).isSymbolicLink() && readlinkSync(secondary) === 'AGENTS.md', gitClean: git(sandbox, 'status', '--porcelain') === '' };
  assert(evidence.context.gitClean); assert(contextState.claudeReadsAgents || evidence.context.linked);
  if (!app.auth.configured()) await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: randomBytes(32).toString('hex') });
  server = createDaemon({ application: app }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]); const page = await context.newPage(); page.setDefaultTimeout(90_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const request = async (path, body) => { const response = await page.request.post(`${url}${path}`, { data: body }); assert(response.ok(), `Request failed (${response.status()}): ${redact(await response.text())}`); return response.json(); };
  const capture = async (name) => { await expect(page.getByText(/^Rendering(?:\.\.\.|…)$/)).toHaveCount(0); assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'Horizontal overflow'); await page.screenshot({ path: join(output, `${name}.png`), fullPage: await page.getByRole('dialog').count() === 0 }); evidence.screenshots.push(`${name}.png`); };
  const messages = { answer: 'What does src/sum.ts do?', change: 'Add an exported multiply(a: number, b: number) function to src/sum.ts with tests for positive numbers, negative numbers and zero. Preserve sum and the existing tests. Run npm test. Do not install dependencies.', memory: 'Remember that this project uses Vitest with globals enabled. Save this as a project memory note titled "Vitest convention for acceptance". Do not change code.' };
  const titles = { answer: 'J1 · Explain sum', change: 'J2 · Multiply with tests', memory: 'J11 · Remember the test convention' };
  if (invalidJevKey) titles.answer = 'J6 · Continue after Jev rejects the key';
  if (!captureId && !resumeId) await request('/api/conversations', { schema: 'start-conversation-v1', id: conversationId, projectId, title: titles[journey], message: messages[journey], clientMessageId: `${conversationId}_request` });
  await page.goto(`${url}/conversations/${conversationId}`);
  if (invalidJevKey) {
    await app.conversations.wait(conversationId); const waiting = (await app.conversations.view(conversationId));
    assert.equal(waiting.decisionWait?.kind, 'jev-unavailable'); assert.equal(waiting.stretches.length, 0); assert(evidence.jevResponses.length > 0 && evidence.jevResponses.every((response) => [401, 403].includes(response.status)));
    evidence.rejection = { kind: waiting.decisionWait.kind, text: redact(waiting.decisionWait.text), launchesBeforeManual: 0 };
    await expect(page.locator('.manual-picker')).toBeVisible(); await capture('unavailable');
  }
  const step = async (action, id = conversationId, remember = false) => {
    const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible(); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
    if (action !== 'done') { await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id); await picker.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(model.efforts.includes('low') ? 'low' : model.efforts[0]); }
    if (action === 'reply') await picker.getByRole('checkbox', { name: 'This request explicitly asks to remember something.', exact: true }).setChecked(remember);
    const started = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/conversations/${id}/manual`);
    await picker.getByRole('button', { name: 'Continue', exact: true }).click(); assert.equal((await started).status(), 202); await app.conversations.wait(id);
  };
  if (!captureId) {
    console.log(`Running ${titles[journey]} through the actual Codex adapter.`);
    if (!resumeId) await step(journey === 'change' ? 'implement' : 'reply', conversationId, journey === 'memory');
    let view = (await app.conversations.view(conversationId));
    assert.equal(view.stretches.at(-1)?.status, 'completed', view.pause?.reason ?? 'The runtime did not complete'); assert.equal(view.handoffs.at(-1)?.status, 'done', 'The handoff did not report completion');
    if (journey === 'memory') {
      evidence.memoryWorkId = view.conversation.work.id;
      await request(`/api/conversations/${conversationId}/messages`, { schema: 'conversation-message-v1', clientMessageId: `${conversationId}_review`, kind: 'message', text: 'In the next read-only review, check the test setup and propose a project memory note titled "Global test imports for acceptance" explaining the existing use of global test and expect. Use memory_propose; do not write a note or change files yourself.' });
      await page.reload(); await step('review'); view = (await app.conversations.view(conversationId)); assert.equal(view.stretches.at(-1)?.status, 'completed'); assert.equal(view.conversation.work.id, evidence.memoryWorkId);
    }
    await page.reload(); await step('done');
  }
  const view = (await app.conversations.view(conversationId)); assert.equal(view.conversation.state, 'done'); assert(view.handoffs.length > 0); assert.equal(view.stretches[0].runtime, 'codex');
  const baseline = captureId || resumeId ? view.closedWorks.at(-1)?.baseCommit ?? view.stretches[0].gitBefore : before; const after = git(sandbox, 'rev-parse', 'HEAD');
  evidence.before = baseline; evidence.after = after; evidence.conversationId = conversationId;
  evidence.checks = { realRuntime: true, structuredHandoff: true, workClosed: true, cleanTree: git(sandbox, 'status', '--porcelain') === '', localOriginMatches: git(origin, 'rev-parse', 'main') === after, noAttributionTrailers: !/^(?:Co-authored-by|Generated-by):/im.test(git(sandbox, 'log', '--format=%B', `${baseline}..${after}`)) };
  if (invalidJevKey) { evidence.checks.actualAuthenticationRejection = evidence.jevResponses.length > 0 && evidence.jevResponses.every((response) => [401, 403].includes(response.status)); evidence.checks.manualAfterRejection = view.decisions.every((decision) => decision.action.source === 'manual') && view.decisions.some((decision) => decision.notices.some((notice) => notice.kind === 'jev-unavailable')); }
  assert(Object.values(evidence.checks).every(Boolean));
  if (journey === 'answer') {
    assert.equal(after, baseline, 'Answer-only work changed Git history'); assert(evidence.launches.every((entry) => entry.permissions === 'read-only' && !entry.memoryWrite && entry.beforeHead === entry.afterRuntimeHead && entry.beforeStatus === entry.afterRuntimeStatus));
    const answer = view.handoffs[0].result; assert(answer, 'Missing full answer'); evidence.answer = redact(app.conversations.ledger(conversationId).read(answer.ref)); assert.match(evidence.answer, /sum/i); evidence.checks.noGitChanges = true;
  } else if (journey === 'change') {
    assert.notEqual(after, baseline); const changes = await app.conversations.changes(conversationId, 1); const receipt = changes.verifications.at(-1); assert(receipt?.passed && receipt.commit === after && receipt.treeClean, 'Missing final independent verification');
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import assert from 'node:assert/strict'; const {sum,multiply}=await import('./src/sum.ts'); assert.equal(sum(2,3),5); for (const [a,b,expected] of [[2,3,6],[-2,3,-6],[-2,-3,6],[9,0,0]]) assert.equal(multiply(a,b),expected);"], { cwd: sandbox, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    evidence.verification = { command: receipt.command, commit: receipt.commit, passed: receipt.passed, treeClean: receipt.treeClean }; evidence.checks.independentVerification = true; evidence.checks.multiplyOutcomes = true; evidence.diff = git(sandbox, 'diff', baseline, after, '--', 'src');
  } else {
    const memory = (await app.conversations.memory(projectId)); const found = await memory.search('Vitest OR globals', AbortSignal.timeout(30_000)); const note = found.notes.find((note) => note.title === 'Vitest convention for acceptance'); assert(note, 'The requested convention note was not found');
    const full = await memory.read(note.permalink, AbortSignal.timeout(30_000)); assert.match(full.content, /Vitest/i); assert.match(full.content, /globals/i);
    const ledger = app.conversations.ledger(conversationId); const proposals = ledger.events().filter((entry) => entry.type === 'memory-queued').map((entry) => ledger.data(entry));
    const proposal = proposals.find((entry) => entry.source === 'agent' && entry.title === 'Global test imports for acceptance'); assert(proposal, 'The read-only review did not propose the requested note');
    const applied = ledger.events().filter((entry) => entry.type === 'git').map((entry) => ledger.data(entry)).find((entry) => entry.schema === 'memory-applied-v1' && entry.notes.some((note) => note.proposalId === proposal.id && note.outcome === 'written')); assert(applied?.commit, 'The proposal was not checkpointed under ownership');
    const review = evidence.launches.find((entry) => entry.conversationId === conversationId && entry.action === 'review');
    if (!captureId) assert(review && review.permissions === 'read-only' && !review.memoryWrite && review.beforeHead === review.afterRuntimeHead && review.beforeStatus === review.afterRuntimeStatus, 'The review changed files before the owner applied its queue');
    const changed = git(sandbox, 'diff', '--name-only', '-z', baseline, after).split('\0').filter(Boolean); assert(changed.length && changed.every((ref) => ref.startsWith('.jevellan/memory/')), 'This memory work changed non-memory files');
    evidence.memory = { title: full.title, permalink: full.permalink, content: redact(full.content), proposalTitle: proposal.title, proposalCommit: applied.commit, files: changed };
    evidence.checks.explicitRememberSaved = true; evidence.checks.readOnlyProposalAppliedByOwner = true; evidence.checks.memoryOnlyPublished = true;
  }
  evidence.steps = view.stretches.map(({ n, action, model, effortRequested, effortEffective, status }) => ({ n, action, model, effortRequested, effortEffective, status }));
  evidence.decisions = app.conversations.decisions(conversationId).map(({ n, action, model, effort, memory, notices }) => ({ n, action: { chosen: action.chosen, source: action.source }, ...(model ? { model: model.chosen } : {}), effort, memory, notices }));
  const ledger = app.conversations.ledger(conversationId); evidence.memoryCapture = ledger.events().filter((entry) => entry.type === 'memory-queued').map((entry) => { const data = ledger.data(entry); return { event: entry.id, stretch: entry.stretch, source: data.source, title: redact(data.title) }; });
  await page.reload(); await expect(page.locator('.conversation-page > .muted')).toContainText('Done'); await capture('conversation');
  await page.getByRole('button', { name: 'Why', exact: true }).first().click(); await expect(page.getByRole('dialog')).toContainText('This step was picked manually.'); await capture('why'); await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  if (journey === 'change') { await page.getByRole('button', { name: 'Changes', exact: true }).first().click(); await expect(page.getByRole('dialog')).toContainText('Passed'); await capture('changes'); await page.getByRole('button', { name: 'Close panel', exact: true }).click(); }
  if (journey === 'memory') {
    await page.goto(`${url}/settings/projects`); const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Acceptance sandbox', exact: true }) }); await card.getByRole('button', { name: 'Browse memory', exact: true }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search memory').fill('Vitest'); await dialog.getByRole('button', { name: 'Search', exact: true }).click(); await dialog.locator('.memory-result').filter({ hasText: evidence.memory.title }).click(); await expect(dialog.locator('.markdown')).toContainText('globals'); await capture('memory'); await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
    const recallId = `${conversationId}_recall`; evidence.recallConversationId = recallId;
    if (!captureId || continueRecall) await request('/api/conversations', { schema: 'start-conversation-v1', id: recallId, projectId, title: 'J11 · Recall the test convention', message: 'What should I know about Vitest and globals before writing a new test?', clientMessageId: `${recallId}_request` });
    await page.goto(`${url}/conversations/${recallId}`); if (!captureId || continueRecall) { await step('reply', recallId); assert.equal((await app.conversations.view(recallId)).stretches.at(-1)?.status, 'completed'); await page.reload(); await step('done', recallId); }
    const recall = (await app.conversations.view(recallId)); assert.equal(recall.conversation.state, 'done'); const decision = app.conversations.decisions(recallId).find((entry) => entry.memory?.chosen.includes(evidence.memory.permalink)); assert(decision, 'The saved note was not selected for the new conversation');
    if (!captureId || continueRecall) assert(evidence.launches.find((entry) => entry.conversationId === recallId)?.briefMemoryIncludesRule, 'The recalled rule was missing from the brief Memory section');
    assert.equal(git(sandbox, 'rev-parse', 'HEAD'), after); assert.equal(git(sandbox, 'status', '--porcelain'), ''); evidence.recall = { chosen: decision.memory.chosen, source: decision.memory.source }; evidence.checks.newConversationRecalledNote = true;
    await page.reload(); await page.getByRole('button', { name: 'Why', exact: true }).first().click(); await expect(page.getByRole('dialog')).toContainText(evidence.memory.permalink); await capture('recall-why'); await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await capture('phone'); assert.equal(errors.length, 0); evidence.passed = true;
  console.log(`${journey} passed: real Codex, manual decision, independent assertions and UI captures.`);
} catch (error) { evidence.error = redact(error instanceof Error ? error.message : 'Acceptance failed'); process.exitCode = 1; console.log(evidence.error); }
finally {
  const document = z.object({ schema: z.literal('manual-acceptance-v1'), journey: z.enum(['answer', 'change', 'memory']), at: z.iso.datetime(), passed: z.boolean(), source: z.enum(['live-codex-manual-selection', 'live-codex-jev-auth-failure']), jevCalled: z.boolean(), jevResponses: z.array(z.strictObject({ at: z.iso.datetime(), status: z.number().int().min(100).max(599) })).optional(), checks: z.record(z.string(), z.boolean()), screenshots: z.array(z.string()), launches: z.array(z.unknown()) }).passthrough().parse(evidence);
  writeFileSync(join(output, 'evidence.json'), JSON.stringify(app.hub.redactor.document(document), null, 2) + '\n', { mode: 0o600 });
  if (changedJev) { if (previousJev !== undefined) app.hub.vault.put('jev', previousJev); else app.hub.vault.remove('jev'); }
  await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
