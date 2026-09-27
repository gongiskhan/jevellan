import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { AccountListSchema, Homes, ImproverRunSchema, ImproverStateSchema, OverrideRecordSchema, ProjectSchema } from '../../packages/core/dist/index.js';
import { Application, createDaemon } from '../../apps/daemon/dist/index.js';

// Live J10/J12: the improver's Run now against real Jev and a real Claude draft runtime, in an isolated home.
// The sandbox notes and the J10 corrections are seeded the way scripts/test-server.mjs seeds them; everything the
// improver does with them (judging, drafting, checking, publishing, Apply and Undo) is live.
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
for (const name of ['--root', '--output', '--port']) assert(option(name), `${name} is required`);
const root = resolve(option('--root')); const output = resolve(option('--output')); const port = Number(option('--port'));
assert(Number.isInteger(port) && port >= 9871 && port <= 9879, 'Use a live-acceptance port between 9871 and 9879');
const jevKey = process.env.JEVELLAN_TEST_JEV_KEY; const claudeToken = process.env.JEVELLAN_TEST_CLAUDE_TOKEN;
assert(jevKey && claudeToken, 'The dedicated Jev key and Claude token are required');
for (const key of Object.keys(process.env)) if (key.startsWith('JEVELLAN_TEST_')) delete process.env[key];
assert(!existsSync(output), 'Use a new evidence directory for each attempt'); mkdirSync(output, { recursive: true, mode: 0o700 });
mkdirSync(join(root, 'user'), { recursive: true });
const environment = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Disposable sandbox with a bare origin, seeded like the improver fixture.
const sandbox = join(root, 'improver-sandbox'); const origin = join(root, 'improver-origin.git'); const projectId = 'improver_sandbox';
if (!existsSync(sandbox)) {
  git(root, 'init', '--bare', '-b', 'main', origin); git(root, 'clone', origin, sandbox);
  const memory = join(sandbox, '.jevellan/memory'); mkdirSync(memory, { recursive: true });
  writeFileSync(join(sandbox, 'AGENTS.md'), '# Improver sandbox\n\nRun npm test.\n');
  writeFileSync(join(memory, 'old-caching-idea.md'), '---\ntitle: Old caching idea\n---\nWe once considered caching builds in S3.\n');
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();
  git(sandbox, 'add', '-A'); execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Seed improver sandbox'], { cwd: sandbox, stdio: 'ignore', env: { ...environment, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  writeFileSync(join(memory, 'test-conventions.md'), '---\ntitle: Test conventions\n---\nUse Vitest with globals enabled.\n');
  writeFileSync(join(memory, 'test-conventions-2.md'), '---\ntitle: Test Conventions\n---\nTests run with Vitest and globals are on.\n');
  writeFileSync(join(memory, 'deploy.md'), '---\ntitle: Deploy notes\nstatus: unresolved\n---\nDeploy with npm run deploy. See [[Missing guide]].\n\n## Merged from laptop on 2026-09-20\n\nDeploy by hand from the release branch.\n');
  if (!process.argv.includes('--no-rule-notes')) for (const [name, title] of [['push-tests.md', 'Run tests before pushing'], ['ci-green.md', 'Always run the tests before a push'], ['pre-push.md', 'Tests must pass before pushing']]) writeFileSync(join(memory, name), `---\ntitle: ${title}\n---\n${title}. Never push with failing tests.\n`);
  git(sandbox, 'add', '-A'); git(sandbox, 'commit', '-m', 'Improver memory notes'); git(sandbox, 'push', '-u', 'origin', 'main');
}

const evidence = { schema: 'live-improver-v1', at: new Date().toISOString(), label: 'live', source: 'live-claude-jev', passed: {}, checks: {}, screenshots: [], observations: [], drafts: [], jevCalls: 0 };
const secrets = [jevKey, claudeToken];
const homes = new Homes(join(root, 'home'), join(root, 'user'));
const app = new Application({ homes, timers: false, port, url: `http://127.0.0.1:${port}`, decisionFetch: async (input, init) => { evidence.jevCalls++; return fetch(input, init); } });
const redact = (value) => { let text = app.hub.redactor.text(String(value)); for (const secret of secrets) text = text.split(secret).join('[redacted]'); return text; };
const note = (text) => { evidence.observations.push(redact(text)); console.log(redact(text)); };
let server; let browser; let restoreCeiling;
try {
  await app.conversations.ready;
  // Drafts run through the Claude adapter; their reported cost is summed from the usage events.
  const adapter = app.runtimes.get('claude'); const nativeStart = adapter.startStretch.bind(adapter);
  adapter.startStretch = (input) => {
    const draft = { stretch: input.stretch, action: input.action, model: input.model, effort: input.effort, permissions: input.permissions, costUsd: 0, startedAt: new Date().toISOString() };
    evidence.drafts.push(draft); const run = nativeStart(input);
    void run.done.then((result) => { draft.status = result.status; if (result.error) draft.error = redact(result.error.message).slice(0, 300); });
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
    for (const toast of await page.locator('.toast').all()) await toast.getByRole('button').click().catch(() => undefined);
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `Horizontal overflow in ${name}`);
    const file = `live-improver-${name}.png`; await page.screenshot({ path: join(output, file) }); evidence.screenshots.push({ file, expected });
  };
  const state = async () => ImproverStateSchema.parse(await call('GET', '/api/improver'));
  const setConfig = async (edit) => { const current = await call('GET', '/hub/config'); const configuration = globalThis.structuredClone(current.configuration); edit(configuration['x-jevellan']); await call('PUT', '/hub/config', { schema: 'config-write-v1', revision: current.revision, configuration }); };

  // Credentials go into the vault through the product API; Codex stays off (no dedicated login on this machine).
  const jev = await page.request.get(`${url}/hub/secrets/jev`); if (!jev.ok() || !(await jev.json()).saved) await call('PUT', '/hub/secrets/jev', { schema: 'save-secret-v1', value: jevKey });
  if (!AccountListSchema.parse(await call('GET', '/hub/accounts')).accounts.some((view) => view.account.runtime === 'claude')) await call('POST', '/hub/accounts', { schema: 'add-account-v1', runtime: 'claude', label: 'Claude test subscription', kind: 'subscription', secret: claudeToken });
  // The user chose to let this run use the test account up to 98% of its weekly window; it is restored to 90% at the end.
  const accountId = AccountListSchema.parse(await call('GET', '/hub/accounts')).accounts.find((view) => view.account.runtime === 'claude').account.id;
  const setCeiling = async (ceilingPct) => { const current = await call('GET', `/hub/accounts/${accountId}`); await call('PATCH', `/hub/accounts/${accountId}`, { schema: 'update-account-v1', revision: current.revision, label: current.account.label, enabled: current.account.enabled, ceilingPct }); await call('POST', `/api/accounts/${accountId}/check`, { schema: 'empty-request-v1' }); return (await call('GET', `/hub/accounts/${accountId}`)).statuses.map(({ auth, usage }) => ({ auth, weeklyPct: usage?.weeklyPct, fiveHourPct: usage?.fiveHourPct })); };
  restoreCeiling = async () => { evidence.ceiling.restored = { at: new Date().toISOString(), ceilingPct: 90, status: await setCeiling(90) }; };
  evidence.ceiling = { raised: { at: new Date().toISOString(), from: 90, ceilingPct: 98, status: await setCeiling(98) } };
  await setConfig((value) => { value.runtimes.claude = { enabled: true }; if (value.runtimes.codex) value.runtimes.codex.enabled = false; value.improver.schedule.enabled = false; });
  evidence.menu = (await call('GET', '/hub/config')).configuration['x-jevellan'].menu.map(({ id, model, enabled }) => ({ id, model, enabled }));
  if (!app.hub.get('projects', projectId, ProjectSchema)) {
    await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: ProjectSchema.parse({ schema: 'project-v1', id: projectId, name: 'Improver sandbox', paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'main', testCommand: 'test -f AGENTS.md', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }) });
    for (const operation of (await app.conversations.contextPanel(projectId)).operations) await app.conversations.wait(operation.conversationId);
  }

  const openImprover = async () => { await page.goto(`${url}/settings/improver`); await expect(page.getByRole('heading', { name: 'Improver', exact: true })).toBeVisible(); await expect(page.getByText('Loading suggestions…')).toHaveCount(0); };
  const setJobs = async (jobs) => {
    const panel = page.getByRole('region', { name: 'Schedule and jobs' });
    await panel.getByRole('checkbox', { name: 'Routing suggestions', exact: true }).setChecked(jobs.routing);
    await panel.getByRole('checkbox', { name: 'Memory care', exact: true }).setChecked(jobs.memory);
    await panel.getByRole('checkbox', { name: 'Context suggestions for AGENTS.md', exact: true }).setChecked(jobs.context);
    if (jobs.mode) await panel.getByRole('combobox', { name: 'Memory care mode' }).selectOption(jobs.mode);
    const save = panel.getByRole('button', { name: 'Save schedule and jobs', exact: true }); if (await save.isEnabled()) { await save.click(); await expect(save).toBeDisabled(); }
    const saved = (await call('GET', '/hub/config')).configuration['x-jevellan'].improver;
    assert.deepEqual({ routing: saved.routing.enabled, memory: saved.memory.enabled, context: saved.context.enabled }, { routing: jobs.routing, memory: jobs.memory, context: jobs.context }, 'The improver jobs were not saved');
  };
  const runNow = async (label) => {
    const response = page.waitForResponse((value) => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/improver' && (value.request().postData() ?? '').includes('"run-now"'));
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    const run = ImproverRunSchema.parse(await (await response).json()); const started = Date.now();
    for (;;) {
      const jobs = (await state()).jobs.filter((job) => job.scope.cycle.kind === 'manual' && job.scope.cycle.id === run.id);
      if (jobs.length && jobs.every((job) => job.status !== 'running')) break;
      if (Date.now() - started > 25 * 60_000) throw new Error(`${label}: the improver run did not finish in 25 minutes`);
      await sleep(3000);
    }
    const current = await state(); const jobs = current.jobs.filter((job) => job.scope.cycle.kind === 'manual' && job.scope.cycle.id === run.id);
    const logs = [];
    for (const job of jobs) {
      const log = await call('POST', '/api/improver', { schema: 'improver-request-v1', operation: 'log', jobId: job.id }).catch((error) => ({ error: error.message }));
      logs.push({ job: { id: job.id, scope: job.scope.kind, status: job.status, note: redact(job.note) }, log: JSON.parse(redact(JSON.stringify(log))) });
    }
    note(`${label}: ${jobs.map((job) => `${job.scope.kind}=${job.status}`).join(', ')} in ${Math.round((Date.now() - started) / 1000)} s`);
    await page.reload(); await expect(page.getByText('Loading suggestions…')).toHaveCount(0);
    return { run, jobs: logs, state: current };
  };
  // Draft cost comes from the usage events each draft's own ledger recorded.
  const cost = () => {
    const folder = join(root, 'home', 'improver', 'conversations'); if (!existsSync(folder)) return 0; let total = 0;
    for (const entry of readdirSync(folder)) for (const file of existsSync(join(folder, entry, 'ledger')) ? readdirSync(join(folder, entry, 'ledger')) : []) {
      for (const line of readFileSync(join(folder, entry, 'ledger', file), 'utf8').split('\n').filter(Boolean)) { const event = JSON.parse(line); if (event.type === 'usage' && event.data?.costUsd) total += event.data.costUsd; }
    }
    return total;
  };
  const card = (title) => page.locator('article.suggestion-card:not(.report-card)').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

  // J12: memory care (apply and tell) and the AGENTS.md context suggestion, in one Run now.
  // Background drafts take the first eligible model in menu order and do not record runtime limits (reported as a bug),
  // so a model at its own usage limit fails every draft. When --without-model is given, that model is switched off in
  // Settings for the J12 drafts only and switched back on before J10.
  const without = option('--without-model');
  if (without) { await setConfig((value) => { value.menu.find((entry) => entry.id === without).enabled = false; }); evidence.menuWorkaround = { disabled: without, at: new Date().toISOString() }; }
  await openImprover(); await setJobs({ routing: false, memory: true, context: true, mode: 'apply-and-tell' });
  const start = git(origin, 'rev-parse', 'main');
  let j12 = await runNow('J12 run'); evidence.j12 = { jobs: j12.jobs };
  // One retry when a draft fails (for example on a model's own usage limit, which then cools only that model).
  if (j12.jobs.some((entry) => entry.job.status === 'failed')) { evidence.j12.firstAttempt = j12.jobs; j12 = await runNow('J12 retry'); evidence.j12.jobs = j12.jobs; }
  const published = git(origin, 'log', '--format=%H %s', `${start}..main`).split('\n').filter(Boolean); evidence.j12.published = published;
  const reports = j12.state.reports; evidence.j12.reports = JSON.parse(redact(JSON.stringify(reports)));
  const contextCards = j12.state.cards.filter((entry) => entry.kind === 'context'); evidence.j12.contextCards = contextCards.map(({ title, reason, status, evidence: cited }) => ({ title, reason: redact(reason), status, notes: cited.kind === 'notes' ? cited.notes.map((entry) => entry.title) : [] }));
  evidence.j12.memoryCards = j12.state.cards.filter((entry) => entry.kind === 'memory-care').map(({ title, status, reason }) => ({ title, status, reason: redact(reason) }));
  evidence.checks.j12Published = published.some((line) => / memory: nightly care \(/.test(line));
  evidence.checks.j12TreeClean = git(sandbox, 'status', '--porcelain') === '' && git(sandbox, 'rev-parse', 'HEAD') === git(origin, 'rev-parse', 'main');
  evidence.checks.j12AgentsUntouched = git(origin, 'show', 'main:AGENTS.md') === '# Improver sandbox\n\nRun npm test.';
  await capture('j12-run', 'Settings → Improver after a memory-care run, with the morning card and any AGENTS.md suggestion');
  const report = page.locator('article.report-card').first();
  if (evidence.checks.j12Published && await report.count()) {
    evidence.j12.morningCard = redact(await report.innerText()).slice(0, 1500);
    await report.getByRole('button', { name: 'View changes', exact: true }).click(); await expect(report.getByLabel('Memory care changes')).toBeVisible();
    evidence.j12.diff = redact(await report.getByLabel('Memory care changes').innerText()).slice(0, 4000);
    await report.scrollIntoViewIfNeeded(); await capture('j12-view-changes', 'the memory-care report with its diff open');
    const applied = git(origin, 'rev-parse', 'main');
    await report.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(report.getByText('Undone', { exact: true })).toBeVisible({ timeout: 180_000 });
    evidence.j12.afterUndo = git(origin, 'log', '-1', '--format=%s', 'main');
    evidence.checks.j12Undo = /^Revert "memory: nightly care/.test(evidence.j12.afterUndo) && git(origin, 'rev-parse', 'main^') === applied;
  }
  if (contextCards.length) {
    const rule = card(contextCards[0].title); await rule.scrollIntoViewIfNeeded(); evidence.j12.contextDiff = redact(await rule.getByLabel('Suggested change').innerText()).slice(0, 2000);
    await capture('j12-context', 'the AGENTS.md suggestion card with its evidence and diff');
  }
  evidence.checks.j12ContextSuggested = contextCards.length > 0;
  evidence.costAfterJ12 = cost(); note(`Draft cost after J12: $${cost().toFixed(2)}; Jev calls ${evidence.jevCalls}`);
  if (cost() > 8) throw new Error('Stopping before J10: the draft cost is near the $10 cap.');

  if (without) { await setConfig((value) => { value.menu.find((entry) => entry.id === without).enabled = true; }); evidence.menuWorkaround.restoredAt = new Date().toISOString(); }
  if (process.argv.includes('--skip-j10')) throw Object.assign(new Error('J10 skipped for this attempt.'), { skipped: true });
  // J10: two groups of three consistent Model corrections, seeded in the hub the way the browser fixture seeds them.
  const correction = (group, n, action, from, to, context) => {
    const id = `live_${group}_${n}`; const mode = n > 3 ? 'redo' : 'noted';
    if (!app.hub.get('overrides', id, OverrideRecordSchema)) app.hub.put('overrides', id, OverrideRecordSchema, { schema: 'override-v1', id, request: { schema: 'correct-step-v1', clientRequestId: `request_${id}`, generation: 0, stretch: 1, mode, choices: { modelId: to } },
      conversationId: `live_improver_${group}_${n}`, projectId, workId: `work_${id}`, decisionId: `decision_${id}`, at: new Date(Date.now() - (10 - n) * 60_000).toISOString(), action, context, changes: [{ field: 'model', from, to }] }, 0);
  };
  for (const n of [1, 2, 3, 4, 5]) {
    correction('ui', n, 'implement', 'claude-opus', 'claude-fable', `implement in Improver sandbox, a UI change to the page layout judged by eye (${n}), small change, no risky areas recorded`);
    correction('review', n, 'review', 'claude-fable', 'claude-opus', `review in Improver sandbox, small change ${n}, no risky areas recorded`);
  }
  await openImprover(); await setJobs({ routing: true, memory: false, context: false });
  let j10 = await runNow('J10 run'); evidence.j10 = { jobs: j10.jobs };
  if (j10.jobs.some((entry) => entry.job.status === 'failed')) { evidence.j10.firstAttempt = j10.jobs; j10 = await runNow('J10 retry'); evidence.j10.jobs = j10.jobs; }
  const routing = j10.state.cards.filter((entry) => entry.kind === 'routing' && !entry.decided);
  evidence.j10.cards = routing.map(({ title, reason, status, evidence: cited }) => ({ title, reason: redact(reason), status, corrections: cited.kind === 'corrections' ? cited.total : null }));
  evidence.j10.suggestions = j10.state.suggestions.map((row) => JSON.parse(redact(JSON.stringify({ title: row.suggestion.draft.title, field: row.suggestion.draft.field ?? null, check: row.suggestion.check ?? null, status: row.suggestion.status ?? null }))));
  evidence.checks.j10Suggested = routing.length > 0;
  await capture('j10-suggestions', 'Settings → Improver with routing suggestion cards, their evidence and diffs');
  if (routing.length) {
    const first = card(routing[0].title); await first.scrollIntoViewIfNeeded();
    evidence.j10.firstDiff = redact(await first.getByLabel('Suggested change').innerText()).slice(0, 2000);
    const before = await call('GET', '/hub/config');
    await first.getByRole('button', { name: 'Apply', exact: true }).click(); await expect(card(routing[0].title).getByText('Applied.', { exact: true })).toBeVisible();
    const after = await call('GET', '/hub/config');
    const diff = (a, b, path = '') => JSON.stringify(a) === JSON.stringify(b) ? [] : a && b && typeof a === 'object' && typeof b === 'object' ? [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => diff(a[key], b[key], `${path}/${key}`)) : [path];
    evidence.j10.applied = { revision: [before.revision, after.revision], source: after.changedBy?.source, paths: diff(before.configuration, after.configuration) };
    evidence.checks.j10AppliedOneField = after.revision === before.revision + 1 && evidence.j10.applied.paths.length === 1;
    await capture('j10-applied', 'a routing suggestion applied, with its Undo control');
    await card(routing[0].title).getByRole('button', { name: /^Undo/ }).click(); await expect(card(routing[0].title).getByText('Undone', { exact: true })).toBeVisible();
    const undone = await call('GET', '/hub/config');
    evidence.checks.j10UndoRestored = diff(before.configuration, undone.configuration).length === 0;
    await capture('j10-undo', 'the routing suggestion after Undo');
  }
  await page.evaluate(() => globalThis.scrollTo(0, 0)); await capture('desktop', 'Settings → Improver on desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await expect(page.getByRole('heading', { name: 'Improver', exact: true })).toBeVisible(); await capture('phone', 'Settings → Improver on a phone');
  evidence.checks.noBrowserErrors = errors.length === 0;
  evidence.passed = { J12: !!(evidence.checks.j12Published && evidence.checks.j12Undo && evidence.checks.j12ContextSuggested && evidence.checks.j12TreeClean), J10: !!(evidence.checks.j10Suggested && evidence.checks.j10AppliedOneField && evidence.checks.j10UndoRestored) };
  evidence.draftCostUsd = cost(); note(`Done. Draft cost $${cost().toFixed(2)}; Jev calls ${evidence.jevCalls}. Checks: ${JSON.stringify(evidence.checks)}`);
} catch (error) { if (error?.skipped) { evidence.skippedJ10 = true; evidence.draftCostUsd = evidence.costAfterJ12; } else { evidence.error = redact(error instanceof Error ? error.stack ?? error.message : 'Run failed').slice(0, 3000); process.exitCode = 1; console.log(evidence.error); } }
finally {
  try { await restoreCeiling?.(); } catch (error) { evidence.ceilingRestoreError = redact(error instanceof Error ? error.message : 'Restore failed'); }
  const document = z.object({ schema: z.literal('live-improver-v1'), label: z.literal('live'), checks: z.record(z.string(), z.boolean()) }).passthrough().parse(evidence);
  const text = redact(JSON.stringify(app.hub.redactor.document(document), null, 2)); for (const secret of secrets) assert(!text.includes(secret), 'A secret reached the evidence');
  writeFileSync(join(output, 'evidence.json'), text + '\n', { mode: 0o600 });
  await browser?.close(); await app.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
