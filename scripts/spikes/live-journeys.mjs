import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { AccountListSchema, Homes, ProjectSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

// Live section-16 journeys: the real Claude runtime, real Jev decisions and real Git in an isolated home.
// Credentials come only from the environment and enter Jevellan through its own API, into the encrypted vault.
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--home', '--user-home', '--sandbox', '--origin', '--output', '--journey', '--port']) assert(option(name), `${name} is required`);
const journeys = ['J1', 'J2', 'J4', 'J5', 'J6', 'J7-off', 'J7-on', 'J13'];
const journey = z.enum(journeys).parse(option('--journey'));
const homes = new Homes(resolve(option('--home')), resolve(option('--user-home')));
const sandbox = resolve(option('--sandbox')); const origin = resolve(option('--origin')); const output = resolve(option('--output')); const port = Number(option('--port'));
assert(Number.isInteger(port) && port >= 9871 && port <= 9879, 'Use a live-acceptance port between 9871 and 9879');
const jevKey = process.env.JEVELLAN_TEST_JEV_KEY; const claudeToken = process.env.JEVELLAN_TEST_CLAUDE_TOKEN;
assert(jevKey && claudeToken, 'The dedicated Jev key and Claude token are required');
// The daemon process never keeps the test variables; agent processes get a minimal environment regardless.
for (const key of Object.keys(process.env)) if (key.startsWith('JEVELLAN_TEST_')) delete process.env[key];
assert(!existsSync(output), 'Use a new evidence directory for each attempt'); mkdirSync(output, { recursive: true, mode: 0o700 });
const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
assert.equal(JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8')).name, 'jevellan-acceptance-sandbox', 'This is not the isolated acceptance sandbox');
assert.equal(git(sandbox, 'remote', 'get-url', 'origin'), origin); assert.equal(git(sandbox, 'branch', '--show-current'), 'main');
const projectId = 'live_sandbox';

const evidence = { schema: 'live-journey-v1', journey, at: new Date().toISOString(), label: 'live', source: 'live-claude-jev', passed: false, checks: {}, screenshots: [], launches: [], observations: [] };
const app = new Application({ homes, timers: false, port, url: `http://127.0.0.1:${port}` });
let server; let browser;
const secrets = [jevKey, claudeToken];
const redact = (value) => { let text = app.hub.redactor.text(String(value)); for (const secret of secrets) text = text.split(secret).join('[redacted]'); return text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[identifier omitted]'); };
const note = (text) => { evidence.observations.push(redact(text)); console.log(redact(text)); };
const briefs = [];
try {
  await app.conversations.ready;
  const adapter = app.runtimes.get('claude'); const nativeStart = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    const observation = { conversationId: input.conversationId, stretch: input.stretch, action: input.action, permissions: input.permissions, model: input.model, effort: input.effort, account: input.account.account.id, startedAt: new Date().toISOString() };
    briefs.push({ conversationId: input.conversationId, stretch: input.stretch, brief: input.brief }); evidence.launches.push(observation);
    const run = nativeStart(input);
    void run.done.then((result) => { observation.status = result.status; if (result.error) observation.error = { kind: result.error.kind, message: redact(result.error.message).slice(0, 300) }; }).catch((error) => { observation.error = { kind: 'other', message: redact(error.message).slice(0, 300) }; });
    return run;
  };
  if (!app.auth.configured()) await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: randomBytes(32).toString('hex') });
  server = createDaemon({ application: app }); server.listen(port, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); page.setDefaultTimeout(90_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
  const call = async (method, path, body) => {
    const response = await page.request.fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { data: body }) });
    assert(response.ok(), `${method} ${path} failed (${response.status()}): ${redact(await response.text())}`); return response.json();
  };
  const capture = async (name, expected) => {
    await expect(page.getByText(/^Rendering(?:\.\.\.|…)$/)).toHaveCount(0);
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `Horizontal overflow in ${name}`);
    evidence.layout = evidence.layout ?? {}; evidence.layout[name] = await page.evaluate(() => {
      const box = (selector) => { const element = globalThis.document.querySelector(selector); if (!element) return null; const rect = element.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }; };
      const scrolled = [...globalThis.document.querySelectorAll('*')].filter((element) => element.scrollTop > 0).map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}:${Math.round(element.scrollTop)}`);
      return { scrollY: Math.round(globalThis.scrollY), documentHeight: globalThis.document.documentElement.scrollHeight, viewportHeight: globalThis.innerHeight, title: box('.conversation-heading h1'), topbar: box('header, .topbar, .top-bar'), scrolled };
    });
    const file = `${journey}-live-${name}.png`; await page.screenshot({ path: join(output, file), fullPage: false });
    evidence.screenshots.push({ file, expected });
  };

  // One-time setup through the product API: Jev key and Claude subscription token into the vault, Codex off (no dedicated login here).
  const jevSummary = await call('GET', '/hub/secrets/jev').catch(() => undefined);
  if (!jevSummary?.saved) await call('PUT', '/hub/secrets/jev', { schema: 'save-secret-v1', value: jevKey });
  let accounts = AccountListSchema.parse(await call('GET', '/hub/accounts')).accounts;
  let claude = accounts.find((view) => view.account.runtime === 'claude');
  if (!claude) claude = await call('POST', '/hub/accounts', { schema: 'add-account-v1', runtime: 'claude', label: 'Claude test subscription', kind: 'subscription', secret: claudeToken });
  const accountId = claude.account.id; evidence.accountId = accountId;
  const setCredential = async (value) => { const current = await call('GET', `/hub/accounts/${accountId}`); await call('PUT', `/hub/accounts/${accountId}/credential`, { schema: 'replace-credential-v1', revision: current.revision, secret: value }); return call('POST', `/api/accounts/${accountId}/check`, { schema: 'empty-request-v1' }); };
  if (!(await call('GET', `/hub/accounts/${accountId}`)).statuses.some((status) => status.auth === 'ready')) await setCredential(claudeToken);
  assert((await call('GET', `/hub/accounts/${accountId}`)).statuses.some((status) => status.auth === 'ready'), 'The Claude test account is not ready');
  const setConfig = async (edit) => { const current = await call('GET', '/hub/config'); const configuration = globalThis.structuredClone(current.configuration); edit(configuration['x-jevellan']); await call('PUT', '/hub/config', { schema: 'config-write-v1', revision: current.revision, configuration }); };
  let config = (await call('GET', '/hub/config')).configuration['x-jevellan'];
  if (config.runtimes.codex?.enabled || !config.runtimes.claude?.enabled) await setConfig((value) => { value.runtimes.claude = { ...value.runtimes.claude, enabled: true }; if (value.runtimes.codex) value.runtimes.codex.enabled = false; });
  config = (await call('GET', '/hub/config')).configuration['x-jevellan'];
  const menu = config.menu.filter((entry) => entry.runtime === 'claude' && entry.enabled); assert(menu.length > 0, 'No enabled Claude model after discovery');
  evidence.menu = config.menu.map(({ id, runtime, model, enabled, efforts }) => ({ id, runtime, model, enabled, efforts }));
  if (!app.hub.get('projects', projectId, ProjectSchema)) {
    await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { schema: 'project-v1', id: projectId, name: 'Live sandbox', paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'main', testCommand: 'npm test', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } } });
    for (const operation of (await app.conversations.contextPanel(projectId)).operations) await app.conversations.wait(operation.conversationId);
  }
  assert.equal(git(sandbox, 'status', '--porcelain'), '', 'The sandbox must start clean');

  // Helpers shared by the journeys.
  const view = (id) => app.conversations.view(id);
  const until = async (label, predicate, timeoutMs = 20 * 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(1000); }
  };
  const settle = async (id, timeoutMs) => {
    let quiet = 0;
    await until(`${id} to settle`, async () => { const current = await view(id); quiet = !current.busy && current.conversation.state !== 'running' ? quiet + 1 : 0; return quiet >= 3; }, timeoutMs);
    await app.conversations.wait(id); return view(id);
  };
  const running = async (id) => { const current = await view(id); return current.stretches.find((entry) => entry.status === 'running'); };
  const start = async (id, title, message) => { if (captureId) { await page.goto(`${url}/conversations/${id}`); return; } await call('POST', '/api/conversations', { schema: 'start-conversation-v1', id, projectId, title, message, clientMessageId: `${id}_request` }); await page.goto(`${url}/conversations/${id}`); };
  const record = async (id) => {
    const current = await view(id);
    evidence.conversationId = id; evidence.state = current.conversation.state; evidence.pause = current.pause ? redact(current.pause.reason) : undefined;
    evidence.steps = current.stretches.map(({ n, workId, action, modelId, model, effortRequested, effortEffective, accountId: account, status, gitBefore, gitAfter, usage }) => ({ n, workId, action, modelId, model, effortRequested, effortEffective, account, status, gitBefore, gitAfter, costUsd: usage.costUsd }));
    evidence.decisions = app.conversations.decisions(id).map((decision) => ({ n: decision.n, workId: decision.workId, trigger: decision.trigger, jevModel: decision.jev?.returnedModel, action: { chosen: decision.action.chosen, source: decision.action.source, allowed: decision.action.allowed, probabilities: decision.action.probabilities }, ...(decision.model ? { model: { chosen: decision.model.chosen, source: decision.model.source, keepCurrentP: decision.model.keepCurrentP, eligible: decision.model.eligible, excluded: decision.model.excluded } } : {}), ...(decision.effort ? { effort: decision.effort } : {}), notices: decision.notices.map((entry) => ({ kind: entry.kind, text: redact(entry.text) })), correctionsShown: decision.correctionsShown }));
    evidence.handoffs = current.handoffs.map(({ stretch, action, status, summary, changedFiles, testsRun, proposedNext }) => ({ stretch, action, status, summary: redact(summary), changedFiles, testsRun: testsRun ? { ...testsRun, summary: redact(testsRun.summary).slice(0, 400) } : undefined, proposedNext }));
    evidence.works = [...current.closedWorks, ...(current.conversation.work ? [current.conversation.work] : [])].map(({ id: work, request, baseCommit, counters, latestPlanRef, approvedPlanRef, closedAs }) => ({ id: work, request: redact(request), baseCommit, counters, latestPlanRef, approvedPlanRef, closedAs }));
    return current;
  };
  const openWhy = async (n) => { await page.locator(`#stretch-${n}`).getByRole('button', { name: 'Why', exact: true }).click(); const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); return dialog; };
  const closePanel = async () => { await page.getByRole('button', { name: 'Close panel', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); };
  const published = () => git(origin, 'rev-parse', 'main');
  const noTrailers = (from, to) => !/^(?:Co-authored-by|Generated-by|Claude-Session):/im.test(git(sandbox, 'log', '--format=%B', `${from}..${to}`));
  const effortSummary = () => (evidence.steps ?? []).map((step) => `${step.n}:${step.action}/${step.modelId}/${step.effortEffective}`).join(', ');
  // Capture mode re-checks and re-captures a finished live conversation without launching anything new.
  const captureId = option('--capture-id'); if (captureId && journey === 'J13' && !process.argv.includes('--recapture')) evidence.continuationOf = captureId; else if (captureId) { evidence.captureOnly = true; adapter.startStretch = () => { throw new Error('Capture mode never launches a stretch'); }; }
  const id = captureId ?? `live_${journey.replace('-', '_').toLowerCase()}_${Date.now()}`;
  const before = captureId ? (await view(id)).closedWorks[0].baseCommit : git(sandbox, 'rev-parse', 'HEAD'); evidence.git = { before };

  // Journeys with live interactions are only re-captured, never replayed.
  const generic = !!captureId && (!['J1', 'J2', 'J13'].includes(journey) || process.argv.includes('--recapture'));
  if (generic) { await page.goto(`${url}/conversations/${id}`); await record(id); await expect(page.locator(`#stretch-${evidence.steps.at(-1).n}`)).toBeVisible(); await capture('conversation', 'the finished conversation with its steps, chips and handoffs');
    const corrected = (await view(id)).overrides; const decision = app.conversations.decisions(id).find((entry) => corrected.length > 0 && corrected.every((override) => entry.correctionsShown.includes(override.id)));
    const step = decision && (await view(id)).stretches.find((entry) => entry.decisionId === decision.id);
    if (step) { const dialog = await openWhy(step.n); await expect(dialog.getByText('Just override', { exact: true })).toBeVisible(); await capture('why-corrections', 'the Why drawer listing the corrections used by the next decision, including Override and undo and Just override'); await closePanel(); evidence.checks.whyListsCorrections = true; } }

  if (journey === 'J1' && !generic) {
    await start(id, 'J1 · Explain sum', 'What does src/sum.ts do?');
    const current = await settle(id); await record(id);
    const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after;
    evidence.checks.workDone = current.conversation.state === 'done';
    evidence.checks.jevDecided = current.decisions.every((decision) => decision.action.source === 'jev' || decision.action.source === 'only-option') && current.decisions.some((decision) => decision.action.source === 'jev');
    evidence.checks.answered = current.handoffs.some((handoff) => handoff.action === 'reply' && handoff.status === 'done');
    evidence.checks.noGitChanges = after === before && git(sandbox, 'status', '--porcelain') === '' && published() === before;
    evidence.checks.readOnlyLaunches = evidence.launches.filter((entry) => entry.conversationId === id).every((entry) => entry.permissions === 'read-only');
    const answer = current.handoffs.find((handoff) => handoff.action === 'reply')?.result; if (answer) evidence.answer = redact(app.conversations.ledger(id).read(answer.ref)).slice(0, 2000);
    await page.reload(); await expect(page.locator('.conversation-meta .chip.state-done')).toBeVisible(); await capture('conversation', 'a finished conversation that answered what src/sum.ts does');
    const reply = current.stretches.find((entry) => entry.action === 'reply');
    const dialog = await openWhy(reply.n); await expect(dialog.locator('.why-source').first()).toHaveText('Jev'); evidence.checks.whyShowsJevDecision = true;
    await capture('why', 'the Why drawer showing the Jev decision for the answer step with action, model and effort');
    await closePanel();
  }

  if (journey === 'J2' && !generic) {
    await start(id, 'J2 · Multiply with tests', 'Add a multiply function with tests.');
    const current = await settle(id); await record(id);
    const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after; evidence.git.published = published();
    evidence.checks.workDone = current.conversation.state === 'done';
    evidence.checks.jevDecided = current.decisions.some((decision) => decision.action.source === 'jev') && current.decisions.every((decision) => ['jev', 'only-option', 'guard'].includes(decision.action.source));
    const implement = current.stretches.filter((entry) => entry.action === 'implement' && entry.status !== 'undone');
    const changes = await app.conversations.changes(id, implement.at(-1).n); const receipt = changes.verifications.filter((entry) => entry.passed).at(-1);
    evidence.verification = receipt && { command: receipt.command, commit: receipt.commit, passed: receipt.passed, treeClean: receipt.treeClean, trigger: receipt.trigger };
    evidence.checks.finalCommitVerified = !!receipt && receipt.commit === after && receipt.treeClean;
    evidence.checks.publishedToOrigin = published() === after && after !== before;
    evidence.checks.noTrailers = noTrailers(before, after);
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import assert from 'node:assert/strict'; const m = { ...await import('./src/sum.ts'), ...await import('./src/multiply.ts').catch(() => ({})) }; assert.equal(m.sum(2,3),5); assert.equal(typeof m.multiply, 'function'); assert.equal(m.multiply(3,4),12); assert.equal(m.multiply(-2,3),-6);"], { cwd: sandbox, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    evidence.checks.multiplyWorks = true; evidence.diff = git(sandbox, 'diff', before, after, '--', 'src');
    evidence.commits = git(sandbox, 'log', '--format=%H %s', `${before}..${after}`).split('\n');
    await page.reload(); await expect(page.locator('.conversation-meta .chip.state-done')).toBeVisible(); await capture('conversation', 'a finished conversation that added multiply with tests');
    await page.locator(`#stretch-${implement.at(-1).n}`).getByRole('button', { name: 'Changes', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('multiply'); await expect(dialog).toContainText('Passed'); evidence.checks.changesDrawerShowsDiffAndReceipt = true;
    await capture('changes', 'the Changes drawer with the multiply diff');
    await dialog.locator('.verification-receipt').last().scrollIntoViewIfNeeded(); await expect(dialog.locator('.verification-receipt').last()).toContainText(evidence.verification.commit);
    await capture('changes-receipt', 'the Changes drawer showing the passing Jevellan verification receipt for the final commit'); await closePanel();
    await openWhy(implement.at(-1).n); await capture('why', 'the Why drawer for the implement step with the Jev decision'); await closePanel();
  }

  if (journey === 'J4' && !generic) {
    // Part 1: invalidate only the isolated test account's token, then ask for the HTML change.
    await setCredential(`sk-ant-oat01-${randomBytes(40).toString('base64url')}`);
    const status = await call('GET', `/hub/accounts/${accountId}`); evidence.invalidatedAuth = status.statuses.map((entry) => entry.auth);
    await start(id, 'J4 · Sandbox page footer', 'On the sandbox page (index.html), add a small footer that says "Built with Jevellan" and centre the heading.');
    let current = await settle(id, 10 * 60_000); await record(id);
    evidence.part1 = { state: current.conversation.state, pause: current.pause && redact(current.pause.reason), decisionWait: current.decisionWait && { kind: current.decisionWait.kind, text: redact(current.decisionWait.text), reasons: current.decisionWait.reasons }, launches: evidence.launches.filter((entry) => entry.conversationId === id).length, notices: evidence.decisions.flatMap((decision) => decision.notices) };
    evidence.checks.preferredNeedsLoginNotice = evidence.part1.notices.some((entry) => entry.kind === 'preferred-needs-login');
    await page.reload(); await capture('invalid-token', 'the conversation waiting because the only Claude account needs login');
    // Part 2: restore the token through the same API, then continue the same work.
    await setCredential(claudeToken); assert((await call('GET', `/hub/accounts/${accountId}`)).statuses.some((entry) => entry.auth === 'ready'));
    const resume = await page.getByRole('button', { name: /^(Try automatic again|Retry)$/ }).count();
    if (current.decisionWait && resume) await page.getByRole('button', { name: /^(Try automatic again|Retry)$/ }).first().click();
    else await call('POST', `/api/conversations/${id}/messages`, { schema: 'conversation-message-v1', clientMessageId: `${id}_continue`, kind: 'message', text: 'The Claude account is logged in again. Continue.' });
    current = await settle(id); await record(id);
    const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after;
    evidence.checks.workDoneAfterLogin = current.conversation.state === 'done';
    evidence.checks.publishedToOrigin = published() === after;
    evidence.checks.htmlChanged = /Built with Jevellan/.test(readFileSync(join(sandbox, 'index.html'), 'utf8'));
    evidence.checks.noTrailers = noTrailers(before, after);
    await page.reload(); await capture('conversation', 'the finished HTML change with action, model and effort chips per step');
  }

  if (journey === 'J5' && !generic) {
    await start(id, 'J5 · Notes and corrections', 'Add three functions to src/sum.ts: subtract, divide and power. divide must throw an Error when dividing by zero. Add tests for each function in src/sum.test.ts, then run npm test.');
    const noteText = 'Note: for divide, use exactly the error message "Cannot divide by zero".';
    const correctionText = 'Correction: do not add power. Only subtract and divide are wanted; remove power if you already added it.';
    const first = await until('a running stretch', () => running(id), 5 * 60_000);
    await until('the first stretch to stream', async () => app.conversations.ledger(id).events().some((event) => event.stretch === first.n && ['text', 'tool-start'].includes(event.type)), 5 * 60_000);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(noteText); await page.getByRole('button', { name: 'Add note', exact: true }).click(); await expect(composer).toHaveValue('');
    evidence.note = { stretch: first.n, at: new Date().toISOString() }; await sleep(8000);
    const afterNote = (await view(id)).stretches.find((entry) => entry.n === first.n);
    evidence.checks.noteDidNotInterrupt = afterNote.status === 'running' && !app.conversations.ledger(id).events().some((event) => event.type === 'steer');
    await capture('note', 'a running step with the note recorded in the conversation');
    let target = await running(id);
    if (!target) target = await until('a stretch for the correction', () => running(id), 10 * 60_000);
    await composer.fill(correctionText); await page.getByRole('button', { name: 'Send correction', exact: true }).click();
    evidence.correction = { stretch: target.n, at: new Date().toISOString() };
    await until('the corrected stretch to end', async () => (await view(id)).stretches.find((entry) => entry.n === target.n).status !== 'running', 5 * 60_000);
    const next = await until('the stretch after the correction', async () => (await view(id)).stretches.find((entry) => entry.n > target.n), 10 * 60_000);
    // Reload mid-stream once the following stretch has streamed something.
    await until('streaming after the correction', async () => app.conversations.ledger(id).events().some((event) => event.stretch === next.n && ['text', 'tool-start'].includes(event.type)) || (await view(id)).stretches.find((entry) => entry.n === next.n).status !== 'running', 5 * 60_000);
    evidence.reloadedDuring = { stretch: next.n, status: (await view(id)).stretches.find((entry) => entry.n === next.n).status };
    await page.reload(); await expect(page.locator(`#stretch-${next.n}`)).toBeVisible();
    await until('the following stretch to end', async () => (await view(id)).stretches.find((entry) => entry.n === next.n).status !== 'running', 15 * 60_000);
    await sleep(2000);
    const ledger = app.conversations.ledger(id); const stretchNumbers = [...new Set(ledger.events().filter((event) => event.stretch).map((event) => event.stretch))];
    const duplicates = [];
    for (const n of stretchNumbers) {
      if (await page.locator(`article#stretch-${n}`).count() !== 1) duplicates.push(`step ${n} rendered ${await page.locator(`article#stretch-${n}`).count()} times`);
      const tools = ledger.events().filter((event) => event.stretch === n && event.type === 'tool-start').length;
      const shown = await page.locator(`#stretch-${n} .tool-call`).count(); if (shown !== tools) duplicates.push(`step ${n}: ${shown} tool calls shown, ${tools} recorded`);
    }
    evidence.streamAfterReload = { duplicates }; evidence.checks.streamResumedWithoutDuplicates = duplicates.length === 0;
    const current = await settle(id); await record(id);
    const corrected = current.stretches.find((entry) => entry.n === target.n); const correctedHandoff = current.handoffs.find((entry) => entry.stretch === target.n);
    evidence.checks.correctionEndedStretchPartial = corrected.status === 'interrupted' || correctedHandoff?.status === 'partial';
    evidence.checks.correctionSteerRecorded = ledger.events().some((event) => event.type === 'steer');
    const nextBrief = briefs.find((entry) => entry.conversationId === id && entry.stretch > first.n)?.brief ?? '';
    const everything = nextBrief.split('# Everything else you said about this work')[1]?.split('# Constraints')[0] ?? '';
    evidence.nextBriefSection = redact(everything).slice(0, 1500);
    evidence.checks.nextBriefContainsNote = everything.includes(noteText);
    evidence.checks.nextBriefContainsCorrection = briefs.filter((entry) => entry.conversationId === id && entry.stretch > target.n).every((entry) => entry.brief.includes(correctionText));
    const source = readFileSync(join(sandbox, 'src/sum.ts'), 'utf8');
    evidence.finalSource = source;
    evidence.checks.followedCorrection = /export function subtract/.test(source) && /export function divide/.test(source) && !/power/i.test(source) && /Cannot divide by zero/.test(source);
    evidence.checks.workDone = current.conversation.state === 'done'; const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after; evidence.checks.publishedToOrigin = published() === after; evidence.checks.noTrailers = noTrailers(before, after);
    await page.reload(); await capture('conversation', 'a finished conversation whose corrected step shows as interrupted and later steps continued');
  }

  if (journey === 'J6' && !generic) {
    await call('PUT', '/hub/secrets/jev', { schema: 'save-secret-v1', value: `jev-invalid-${randomBytes(16).toString('hex')}` });
    try {
      await start(id, 'J6 · Continue after Jev rejects the key', 'What does src/sum.ts do?');
      let current = await settle(id, 5 * 60_000);
      assert.equal(current.decisionWait?.kind, 'jev-unavailable', `Expected the Jev-unavailable picker, got ${current.decisionWait?.kind ?? current.conversation.state}`);
      evidence.rejection = { text: redact(current.decisionWait.text), calls: current.decisionWait.calls.map((entry) => ({ status: entry.status, error: entry.error })), launchesBeforeManual: evidence.launches.filter((entry) => entry.conversationId === id).length };
      evidence.checks.noLaunchBeforeManual = evidence.rejection.launchesBeforeManual === 0;
      await page.reload(); const picker = page.locator('.manual-picker'); await expect(picker).toBeVisible();
      await expect(picker.getByRole('combobox', { name: 'Action', exact: true })).toBeVisible(); await expect(picker.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible(); await expect(picker.getByRole('combobox', { name: 'Effort', exact: true })).toBeVisible();
      evidence.checks.pickerHasActionModelEffort = true; await capture('unavailable', 'the Jev unavailable notice with action, model and effort pickers and a Continue button');
      const model = menu.find((entry) => entry.id === 'claude-opus') ?? menu[0];
      const step = async (action) => {
        await expect(picker).toBeVisible(); await picker.getByRole('combobox', { name: 'Action', exact: true }).selectOption(action);
        if (action !== 'done') { await picker.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model.id); await picker.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(model.efforts.includes('low') ? 'low' : model.efforts[0]); }
        await picker.getByRole('button', { name: 'Continue', exact: true }).click(); await sleep(1500); return settle(id);
      };
      current = await step('reply'); assert.equal(current.stretches.at(-1)?.status, 'completed');
      await page.reload(); current = await step('done');
      await record(id);
      evidence.checks.workDone = current.conversation.state === 'done';
      evidence.checks.manualSources = current.decisions.every((decision) => decision.action.source === 'manual') && current.decisions.some((decision) => decision.notices.some((entry) => entry.kind === 'jev-unavailable'));
      evidence.checks.noGitChanges = git(sandbox, 'rev-parse', 'HEAD') === before && git(sandbox, 'status', '--porcelain') === '';
      await page.reload(); await capture('conversation', 'the finished answer after the manual picker');
      await openWhy(current.stretches[0].n); await capture('why', 'the Why drawer showing manual sources and the Jev unavailable notice'); await closePanel();
    } finally { await call('PUT', '/hub/secrets/jev', { schema: 'save-secret-v1', value: jevKey }); evidence.jevKeyRestored = true; }
  }

  if ((journey === 'J7-off' || journey === 'J7-on') && !generic) {
    const pause = journey === 'J7-on';
    await page.goto(`${url}/settings/decisions`); const toggle = page.getByRole('checkbox', { name: 'Pause after a plan' });
    if (await toggle.isChecked() !== pause) { await toggle.setChecked(pause); await page.getByRole('button', { name: 'Save decisions settings', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save decisions settings', exact: true })).toBeEnabled(); }
    await expect.poll(async () => (await call('GET', '/hub/config')).configuration['x-jevellan'].guards.pauseAfterPlan).toBe(pause);
    try {
      const request = pause
        ? 'Make the sandbox friendlier for newcomers and more consistent: tidy up how the math helpers are organised and exported, document them, and make the page reflect what the project offers. Use your judgement on the details.'
        : 'Make the sandbox a better showcase: extend the math helpers in whatever way makes sense, keep everything tested, and make index.html explain what is available. Use your judgement on the details.';
      await start(id, pause ? 'J7 · Plan pause on' : 'J7 · Plan pause off', request);
      if (pause) {
        const waiting = await settle(id, 15 * 60_000); await record(id);
        const planStep = waiting.stretches.find((entry) => entry.action === 'plan' && entry.status === 'completed');
        evidence.checks.jevPickedPlan = !!planStep && waiting.decisions.find((decision) => decision.id === planStep.decisionId)?.action.source === 'jev';
        evidence.checks.waitedAfterPlan = waiting.conversation.state === 'waiting-for-you' && waiting.stretches.at(-1)?.action === 'plan';
        const work = waiting.conversation.work; evidence.beforeApproval = { workId: work.id, request: redact(work.request), baseCommit: work.baseCommit, counters: work.counters, latestPlanRef: work.latestPlanRef };
        await page.reload(); const go = page.getByRole('button', { name: 'Go ahead', exact: true }); await expect(go).toBeVisible(); await capture('plan-waiting', 'a finished plan waiting with Go ahead and Change the plan buttons');
        await go.click(); await sleep(2000);
        const current = await settle(id); await record(id);
        const closed = current.closedWorks.find((entry) => entry.id === work.id) ?? current.conversation.work;
        evidence.afterApproval = { workId: closed.id, request: redact(closed.request), baseCommit: closed.baseCommit, counters: closed.counters, approvedPlanRef: closed.approvedPlanRef, closedAs: closed.closedAs };
        evidence.checks.sameWork = closed.id === work.id && closed.request === work.request && closed.approvedPlanRef === work.latestPlanRef;
        evidence.checks.sameBaseCommit = !work.baseCommit || closed.baseCommit === work.baseCommit;
        evidence.checks.countersContinued = closed.counters.stretches > work.counters.stretches;
        evidence.checks.implementedAfterGoAhead = current.stretches.some((entry) => entry.n > planStep.n && entry.action === 'implement' && entry.workId === work.id);
        evidence.checks.workDone = current.conversation.state === 'done';
        const brief = briefs.find((entry) => entry.conversationId === id && entry.stretch > planStep.n)?.brief ?? '';
        evidence.checks.approvedPlanInNextBrief = /# Plan[\s\S]*approved/i.test(brief);
      } else {
        const current = await settle(id); await record(id);
        const planStep = current.stretches.find((entry) => entry.action === 'plan' && entry.status === 'completed');
        evidence.checks.jevPickedPlan = !!planStep && current.decisions.find((decision) => decision.id === planStep.decisionId)?.action.source === 'jev';
        evidence.checks.implementedWithoutWaiting = !!planStep && current.stretches.some((entry) => entry.n > planStep.n && entry.action === 'implement' && entry.workId === planStep.workId) && current.decisions.filter((decision) => decision.n > 1).every((decision) => decision.trigger === 'stretch-end') && current.messages.length === 1;
        evidence.checks.oneWork = new Set(current.stretches.map((entry) => entry.workId)).size === 1;
        evidence.checks.workDone = current.conversation.state === 'done';
      }
      const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after; evidence.checks.publishedToOrigin = published() === after; evidence.checks.noTrailers = noTrailers(before, after);
      await page.reload(); await capture('conversation', pause ? 'the approved plan followed by implementation in the same work' : 'a plan followed directly by implementation');
    } finally {
      if (pause) { await setConfig((value) => { value.guards.pauseAfterPlan = false; }); evidence.pauseRestoredOff = true; }
    }
  }

  if (journey === 'J13' && !captureId) {
    await start(id, 'J13 · Correct decisions afterwards', 'Add an exported negate(a: number): number function to src/sum.ts with tests. Keep the existing functions and tests.');
    // Step 1 runs; the composer's one-time "Next step" asks for a test step, so a second step is running while step 1 is corrected.
    const first = await until('the first stretch', () => running(id), 5 * 60_000); evidence.firstStep = { n: first.n, action: first.action, modelId: first.modelId, effort: first.effortEffective };
    assert.equal(first.action, 'implement', `Jev started with ${first.action}; the journey needs an implement first step`);
    await page.locator('.composer-options > summary').click();
    await page.getByRole('group', { name: 'Choices for the next step' }).getByRole('combobox', { name: 'Next step', exact: true }).selectOption('test');
    await expect.poll(async () => (await view(id)).conversation.once?.action).toBe('test'); await page.locator('.composer-options > summary').click();
    const second = await until('the second stretch to run', async () => { const current = await view(id); return current.stretches.find((entry) => entry.n > first.n && entry.status === 'running'); }, 15 * 60_000);
    evidence.secondStep = { n: second.n, action: second.action };
    const headAtUndo = git(sandbox, 'rev-parse', 'HEAD');
    const firstRecord = (await view(id)).stretches.find((entry) => entry.n === first.n);
    const redoModel = menu.find((entry) => entry.id !== first.modelId) ?? menu[0]; const redoEffort = first.effortEffective === 'medium' ? 'low' : 'medium';
    await page.reload(); await page.getByRole('button', { name: `Change model for step ${first.n}`, exact: true }).click();
    const modal = page.getByRole('dialog'); await modal.getByRole('combobox', { name: 'Model', exact: true }).selectOption(redoModel.id); await modal.getByRole('combobox', { name: 'Effort', exact: true }).selectOption(redoEffort);
    await modal.getByRole('button', { name: 'Override and undo', exact: true }).click(); await expect(modal).toContainText('Anything outside the repository');
    await capture('undo-confirm', 'the Change this step confirmation with the Undo and redo button');
    await modal.getByRole('button', { name: 'Undo and redo', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 180_000 });
    evidence.redo = { step: first.n, model: redoModel.id, effort: redoEffort, headAtUndo, firstGitBefore: firstRecord.gitBefore };
    const redone = await until('the redo stretch', async () => { const current = await view(id); return current.stretches.find((entry) => entry.n > second.n && entry.action === 'implement'); }, 10 * 60_000);
    let current = await view(id);
    evidence.checks.runningStepStopped = current.stretches.find((entry) => entry.n === second.n).status === 'undone';
    evidence.checks.stepsUndone = current.stretches.filter((entry) => entry.n >= first.n && entry.n <= second.n).every((entry) => entry.status === 'undone');
    evidence.checks.redoUsedChoice = redone.modelId === redoModel.id && redone.effortRequested === redoEffort;
    const undoRef = `refs/jevellan/undo/${id}/${first.n}`; evidence.undoRef = { ref: undoRef, commit: git(sandbox, 'rev-parse', '--verify', '--quiet', undoRef) };
    evidence.checks.undoRefSaved = evidence.undoRef.commit === headAtUndo || git(sandbox, 'merge-base', '--is-ancestor', firstRecord.gitAfter ?? headAtUndo, undoRef) === '';
    evidence.checks.resetToStepBase = redone.gitBefore === firstRecord.gitBefore;
    // A later step: change only the effort with Just override while it runs.
    const later = redone.status === 'running' ? redone : await until('a later running stretch', async () => (await view(id)).stretches.find((entry) => entry.n > redone.n && entry.status === 'running'), 10 * 60_000);
    const justEffort = later.effortEffective === 'high' ? 'medium' : 'high';
    await page.reload(); await page.getByRole('button', { name: `Change effort for step ${later.n}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: 'Effort', exact: true }).selectOption(justEffort);
    await page.getByRole('dialog').getByRole('button', { name: 'Just override', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 });
    evidence.justOverride = { step: later.n, effort: justEffort };
    await expect(page.locator(`#stretch-${later.n} .chip.tag`)).toContainText(`corrected: effort → ${justEffort}`);
    current = await view(id); evidence.checks.justOverrideDidNotStop = current.stretches.find((entry) => entry.n === later.n).status !== 'undone' && current.stretches.find((entry) => entry.n === later.n).status !== 'interrupted';
    await capture('corrected', 'a step showing the corrected effort tag while the work continues, with undone earlier steps struck through');
    current = await settle(id); await record(id);
    const overrides = current.overrides; evidence.overrides = overrides.map((entry) => ({ id: entry.id, stretch: entry.request.stretch, mode: entry.request.mode, changes: entry.changes, context: redact(entry.context) }));
    const nextDecision = current.decisions.find((decision) => new Date(decision.at) > new Date(overrides.find((entry) => entry.request.mode === 'noted').at));
    evidence.nextDecision = nextDecision && { n: nextDecision.n, action: nextDecision.action.chosen, correctionsShown: nextDecision.correctionsShown };
    evidence.checks.bothCorrectionsUsed = !!nextDecision && overrides.every((entry) => nextDecision.correctionsShown.includes(entry.id));
    const index = await call('GET', `/hub/overrides?ids=${overrides.map((entry) => entry.id).join(',')}`);
    const indexed = JSON.stringify(index); evidence.checks.bothInOverrideIndex = overrides.every((entry) => indexed.includes(entry.id));
    if (nextDecision) {
      const step = current.stretches.find((entry) => entry.decisionId === nextDecision.id);
      if (step) { await page.reload(); const dialog = await openWhy(step.n); await expect(dialog.getByText('Override and undo', { exact: true })).toBeVisible(); await expect(dialog.getByText('Just override', { exact: true })).toBeVisible(); await capture('why-corrections', 'the Why drawer listing both corrections under Corrections used'); await closePanel(); evidence.checks.whyListsCorrections = true; }
      else evidence.checks.whyListsCorrections = overrides.every((entry) => nextDecision.correctionsShown.includes(entry.id));
    }
  }

  // Resumable second half: Override and undo on the last step of the finished, published work.
  if (journey === 'J13' && !generic) {
    let current = await record(id); if (captureId) await page.goto(`${url}/conversations/${id}`);
    evidence.checks.firstWorkDone = current.conversation.state === 'done';
    const publishedHead = git(sandbox, 'rev-parse', 'HEAD'); evidence.checks.firstWorkPublished = published() === publishedHead;
    evidence.firstWork = { head: publishedHead, published: published() };
    // Override and undo on the finished, published work's last step creates and publishes revert commits.
    const last = current.stretches.filter((entry) => entry.status !== 'undone' && ['implement', 'test'].includes(entry.action)).at(-1);
    const lastEffort = last.effortEffective === 'high' ? 'medium' : 'high';
    await page.reload(); await page.getByRole('button', { name: `Change effort for step ${last.n}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: 'Effort', exact: true }).selectOption(lastEffort);
    await page.getByRole('dialog').getByRole('button', { name: 'Override and undo', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Undo and redo', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 180_000 });
    evidence.publishedUndo = { step: last.n, effort: lastEffort };
    await sleep(3000); current = await settle(id); await record(id);
    const reverts = git(sandbox, 'log', '--format=%H %s', `${publishedHead}..${published()}`).split('\n').filter(Boolean);
    evidence.publishedUndo.commitsAfter = reverts;
    evidence.checks.revertCommitsPublished = reverts.some((line) => /revert/i.test(line));
    evidence.checks.finalDone = current.conversation.state === 'done'; const after = git(sandbox, 'rev-parse', 'HEAD'); evidence.git.after = after; evidence.checks.finalPublished = published() === after; evidence.checks.noTrailers = noTrailers(before, after);
    await page.reload(); await capture('conversation', 'the corrected conversation with undone steps struck through and the redone steps');
  }

  evidence.effortSummary = effortSummary();
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await expect(page.locator('.conversation-meta')).toBeVisible(); await expect(page.locator('.stretch-block').first()).toBeVisible(); await sleep(1500); await capture('phone', 'the same conversation on a phone');
  evidence.checks.noBrowserErrors = errors.length === 0;
  evidence.passed = Object.values(evidence.checks).every(Boolean);
  note(`${journey}: ${evidence.passed ? 'all checks passed' : `failed checks: ${Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`}. Steps: ${evidence.effortSummary}`);
} catch (error) { evidence.error = redact(error instanceof Error ? error.stack ?? error.message : 'Journey failed').slice(0, 3000); process.exitCode = 1; console.log(evidence.error); }
finally {
  const document = z.object({ schema: z.literal('live-journey-v1'), journey: z.enum(journeys), at: z.iso.datetime(), label: z.literal('live'), source: z.literal('live-claude-jev'), passed: z.boolean(), checks: z.record(z.string(), z.boolean()), screenshots: z.array(z.object({ file: z.string(), expected: z.string() })), launches: z.array(z.unknown()), observations: z.array(z.string()) }).passthrough().parse(evidence);
  const text = redact(JSON.stringify(app.hub.redactor.document(document), null, 2));
  for (const secret of secrets) assert(!text.includes(secret), 'A secret reached the evidence');
  writeFileSync(join(output, 'evidence.json'), text + '\n', { mode: 0o600 });
  await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
