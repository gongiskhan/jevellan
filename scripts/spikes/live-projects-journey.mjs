import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LiveAuthenticationSchema, LiveAuthenticationGapSchema, LiveAuthenticationVariablesSchema, resolveLiveAuthentication } from './live-projects-auth.mjs';

// PJ-live (BRIEF-projects.md section 13, phase 8), started through live-journeys.mjs --journey PJ-live: the coordinator starts a
// thread that adds a small file with a test, the pull request opens on a disposable GitHub repository, Jevellan reads its checks
// and the owner merges it from the Projects page. Everything runs in isolated homes; the owner's native homes, Git configuration,
// keychain and SSH agent are never used. --github-auth gh explicitly uses the owner's authorized gh login before isolation.
//
// Credentials, read once here and removed from this process's environment before anything else runs. Receipts record only
// whether each one is present:
//   JEVELLAN_TEST_JEV_KEY       required (ENV-JEV): the dedicated Jev key, so placement asks the real Jev.
//   JEVELLAN_TEST_CODEX_KEY     required (ENV-CODEX): an OpenAI API key of a dedicated test project. It enters Jevellan as a Codex
//                               API-key account (paid use: always) through POST /hub/accounts, so it lives only in the encrypted
//                               vault and the account home Codex logs in to. --codex-subscription instead opens the product's
//                               sign-in UI for an isolated subscription account; no API key or native Codex login is used.
//   JEVELLAN_TEST_GITHUB_TOKEN  required (ENV-GITHUB): a fine-grained token for the disposable repository only, with Contents read
//                               and write (the push and the merge), Pull requests read and write, Checks read and Commit statuses
//                               read (Jevellan reads check runs and commit statuses). It is saved as Jevellan's GitHub token and
//                               held for Git pushes by an in-memory credential cache of the isolated user home, never in a file.
//                               --github-auth gh resolves the explicitly authorized CLI login in memory instead.
//   JEVELLAN_TEST_GITHUB_REPO   required (ENV-GITHUB): owner/repository of that disposable repository. Its default branch is main
//                               and its root package.json is named jevellan-acceptance-sandbox, with an npm test that needs no
//                               install. --github-repo owner/repository supplies it explicitly. Its pull requests are merged
//                               into main. Never point it at a repository that matters.
//   JEVELLAN_TEST_CLAUDE_TOKEN  optional (ENV-CLAUDE): the dedicated Claude token; without it Claude stays off and only Codex runs.
//
// Without a required credential: node scripts/spikes/live-journeys.mjs --journey PJ-live [--output <new directory>]
//   writes a blocked receipt (docs/acceptance/PJ-live.json, or <output>/evidence.json) and exits 0. No Jevellan home is created
//   and no daemon or browser starts. A blocked receipt is never a pass.
// Live: node scripts/spikes/live-journeys.mjs --journey PJ-live --home <new directory> --user-home <directory>
//   --sandbox <new path> --output <new directory> --port <9871-9879>
//   clones the repository into --sandbox, runs the journey and writes <output>/evidence.json with screenshots, judged afterwards
//   by live-vision.mjs. A run whose checks do not all pass exits 1.
const option = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const RECEIPT = fileURLToPath(new URL('../../docs/acceptance/PJ-live.json', import.meta.url));
const SANDBOX_NAME = 'jevellan-acceptance-sandbox';
const PROJECT_ID = 'live_projects';
const PROJECT_NAME = 'PJ-live sandbox';
const REQUEST = 'Start one thread for this: add a small file with one exported function that returns a greeting for a name, and a test for that function that npm test runs. Keep the change to those two files. I will review and merge the pull request myself.';

const { authentication, values, variables, blockedBy, optionalMissing } = resolveLiveAuthentication(process.argv.slice(2));
// No agent, worker or Git process may inherit a test credential; Jevellan receives them only through its own API.
for (const key of Object.keys(process.env)) if (key.startsWith('JEVELLAN_TEST_')) delete process.env[key];
// live-journey-v3 records explicit authentication sources and resolved input status, never credential values.
const GapSchema = LiveAuthenticationGapSchema;
const head = { schema: z.literal('live-journey-v3'), journey: z.literal('PJ-live'), at: z.iso.datetime(), authentication: LiveAuthenticationSchema };
const VariablesSchema = LiveAuthenticationVariablesSchema;
const BlockedEvidenceSchema = z.strictObject({ ...head, label: z.literal('blocked'), source: z.enum(['credential-preflight', 'subscription-login']), passed: z.literal(false),
  blockedBy: z.array(GapSchema).min(1), optionalMissing: z.array(GapSchema), variables: VariablesSchema, daemonStarted: z.boolean(),
  checks: z.strictObject({}), screenshots: z.tuple([]), observations: z.array(z.string()) }).superRefine((value, context) => {
  if (value.daemonStarted !== (value.source === 'subscription-login')) context.addIssue({ code: 'custom', message: 'The blocked source must match whether the daemon started.' });
});
const LiveEvidenceSchema = z.object({ ...head, label: z.literal('live'), source: z.literal('live-codex-jev-github'), passed: z.boolean(),
  optionalMissing: z.array(GapSchema), variables: VariablesSchema, checks: z.record(z.string(), z.boolean()),
  screenshots: z.array(z.object({ file: z.string(), expected: z.string() })), launches: z.array(z.unknown()), observations: z.array(z.string()) }).passthrough();

if (blockedBy.length) writeBlocked(); else await runLive();

function writeBlocked() {
  const output = option('--output');
  if (output) { assert(!existsSync(resolve(output)), 'Use a new evidence directory for each attempt'); mkdirSync(resolve(output), { recursive: true, mode: 0o700 }); }
  const receipt = output ? join(resolve(output), 'evidence.json') : RECEIPT;
  const evidence = BlockedEvidenceSchema.parse({ schema: 'live-journey-v3', journey: 'PJ-live', at: new Date().toISOString(), authentication, label: 'blocked', source: 'credential-preflight',
    passed: false, blockedBy, optionalMissing, variables, daemonStarted: false, checks: {}, screenshots: [],
    observations: ['Authentication inputs were checked before the journey ran. Explicit gh authentication, when requested and other required inputs are present, was checked through the CLI. No Jevellan home was created, no daemon or browser started, and no repository was cloned or changed. A blocked journey is not a pass.'] });
  const text = JSON.stringify(evidence, null, 2);
  for (const value of Object.values(values)) if (value) assert(!text.includes(value), 'A credential value reached the receipt');
  writeFileSync(receipt, text + '\n', { mode: 0o600 });
  const optional = optionalMissing.length ? ` Optional and also missing: ${optionalMissing.map((entry) => entry.id).join(', ')}.` : '';
  console.log(`PJ-live is blocked by ${blockedBy.map((entry) => entry.id).join(', ')}.${optional} ${blockedBy.map((entry) => entry.reason).join(' ')} Receipt: ${receipt.startsWith(process.cwd() + sep) ? relative(process.cwd(), receipt) : receipt}. No daemon was started.`);
  process.exitCode = 0;
}

async function runLive() {
  for (const name of ['--home', '--user-home', '--sandbox', '--output', '--port']) assert(option(name), `${name} is required for a live PJ-live run`);
  const root = resolve(option('--home')); const userHome = resolve(option('--user-home')); const sandbox = resolve(option('--sandbox'));
  const output = resolve(option('--output')); const port = Number(option('--port'));
  assert(Number.isInteger(port) && port >= 9871 && port <= 9879, 'Use a live-acceptance port between 9871 and 9879');
  assert(!existsSync(root), 'Use a new Jevellan home for each PJ-live attempt');
  assert(!existsSync(sandbox), 'PJ-live clones the disposable repository itself: give a sandbox path that does not exist yet');
  assert(!existsSync(output), 'Use a new evidence directory for each attempt'); mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(userHome, { recursive: true, mode: 0o700 });
  const jevKey = values.JEVELLAN_TEST_JEV_KEY; const codexKey = values.JEVELLAN_TEST_CODEX_KEY; const claudeToken = values.JEVELLAN_TEST_CLAUDE_TOKEN;
  const githubToken = values.JEVELLAN_TEST_GITHUB_TOKEN; const repo = values.JEVELLAN_TEST_GITHUB_REPO;
  const identity = Object.fromEntries(['name', 'email'].map((field) => [field, execFileSync('git', ['config', `user.${field}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()]));
  assert(identity.name && identity.email, 'Configure the machine Git identity before a live PJ-live run');
  const secrets = [jevKey, codexKey, githubToken, claudeToken].filter(Boolean);
  // The repository name is a JEVELLAN_TEST_* value too, so the secret scanner blocks its bytes: evidence names it [repository].
  const repository = new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let evidence = { schema: 'live-journey-v3', journey: 'PJ-live', at: new Date().toISOString(), authentication, label: 'live', source: 'live-codex-jev-github', passed: false,
    variables, optionalMissing, checks: {}, screenshots: [], launches: [], observations: [] };
  let app; let server; let browser; let heartbeat; let cache;
  const redact = (value) => {
    let text = app ? app.hub.redactor.text(String(value)) : String(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text.replace(repository, '[repository]').replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[identifier omitted]');
  };
  const note = (text) => { evidence.observations.push(redact(text)); console.log(redact(text)); };
  // Git for this journey reads only the isolated user home: its configuration resets every inherited credential helper (the
  // system configuration may name the owner's keychain) and keeps the token in a credential cache held in memory.
  const environment = { ...Object.fromEntries(['PATH', 'USER', 'LANG', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), HOME: userHome };
  const gitOutput = (cwd, args, input) => execFileSync('git', args, { cwd, env: { ...environment, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
  const git = (cwd, args, input) => gitOutput(cwd, args, input).trim();
  const github = async (method, path) => {
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${githubToken}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jevellan-acceptance' } });
    const text = await response.text();
    assert(response.ok, `GitHub answered ${response.status} to ${method} ${path}: ${redact(text).slice(0, 300)}`);
    return JSON.parse(text);
  };
  const until = async (label, predicate, timeoutMs, intervalMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(intervalMs); }
  };
  const eventually = (predicate, timeoutMs) => until('a condition', predicate, timeoutMs).then(() => true, () => false);
  try {
    // The disposable repository: reachable with the test token, main by default, and marked as the acceptance sandbox.
    const remote = z.object({ private: z.boolean(), default_branch: z.string(), archived: z.boolean() }).parse(await github('GET', `/repos/${repo}`));
    assert.equal(remote.default_branch, 'main', 'The disposable repository must use main as its default branch');
    assert.equal(remote.archived, false, 'The disposable repository is archived');
    cache = mkdtempSync(join(tmpdir(), 'jv-git-')); const socket = join(cache, 'socket'); const gitconfig = join(userHome, '.gitconfig');
    try { git(userHome, ['config', '--file', gitconfig, '--unset-all', 'credential.helper']); } catch { /* nothing to reset yet */ }
    git(userHome, ['config', '--file', gitconfig, '--add', 'credential.helper', '']);
    git(userHome, ['config', '--file', gitconfig, '--add', 'credential.helper', `cache --timeout=14400 --socket=${socket}`]);
    const helpers = gitOutput(userHome, ['config', '--get-all', 'credential.helper']).replace(/\n$/, '').split('\n');
    assert.deepEqual(helpers.slice(helpers.lastIndexOf('')), ['', `cache --timeout=14400 --socket=${socket}`], 'Git would still consult an inherited credential helper');
    git(userHome, ['credential', 'approve'], `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${githubToken}\n\n`);
    const origin = `https://github.com/${repo}.git`;
    git(userHome, ['clone', '--quiet', origin, sandbox]);
    assert.equal(JSON.parse(readFileSync(join(sandbox, 'package.json'), 'utf8')).name, SANDBOX_NAME, 'The repository is not the disposable acceptance sandbox');
    assert.equal(git(sandbox, ['remote', 'get-url', 'origin']), origin); assert.equal(git(sandbox, ['branch', '--show-current']), 'main');
    // Thread commits take their identity from the checkout (the isolated user home has none).
    git(sandbox, ['config', 'user.name', identity.name]); git(sandbox, ['config', 'user.email', identity.email]);

    // Jevellan's own Git and gh use the isolated home; the authorized gh login was resolved before this boundary.
    process.env.HOME = userHome;
    for (const key of ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_AUTH_TOKEN', 'GH_CONFIG_DIR', 'GH_HOST', 'GH_AUTH_PROFILE', 'XDG_CONFIG_HOME']) delete process.env[key];
    const [core, daemon, playwright] = await Promise.all([import('../../packages/core/dist/index.js'), import('../../apps/daemon/dist/index.js'), import('@playwright/test')]);
    const { AccountListSchema, AccountViewSchema, Homes, MergeResultViewSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema, ThreadViewSchema } = core;
    const { chromium, expect } = playwright;
    const url = `http://127.0.0.1:${port}`;
    // Global timers stay off (no improver runs); the Projects loops poll pull requests and sweep queues as in production.
    app = new daemon.Application({ homes: new Homes(root, userHome), timers: false, projectTimers: { periodic: true, prPollMs: 15_000 },
      repositoryVisibility: async () => remote.private ? 'PRIVATE' : 'PUBLIC', port, url });
    await app.conversations.ready; await app.projectWork.ready;
    for (const runtime of ['codex', 'claude']) {
      const adapter = app.runtimes.get(runtime); if (!adapter) continue;
      const startTurn = adapter.startTurn.bind(adapter);
      adapter.startTurn = (input) => {
        const observation = { owner: input.owner.kind, thread: input.owner.kind === 'thread' ? input.owner.id : undefined, turn: input.turn, runtime, permissions: input.permissions,
          model: input.model, effort: input.effort, account: input.account.account.id, resumed: !!input.resume, startedAt: new Date().toISOString() };
        evidence.launches.push(observation);
        const run = startTurn(input);
        void run.done.then((result) => { observation.status = result.status; if (result.error) observation.error = { kind: result.error.kind, message: redact(result.error.message).slice(0, 300) }; })
          .catch((error) => { observation.error = { kind: 'other', message: redact(error.message).slice(0, 300) }; });
        return run;
      };
    }
    if (!app.auth.configured()) await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: randomBytes(32).toString('hex') });
    server = daemon.createDaemon({ application: app }); server.listen(port, '127.0.0.1'); await once(server, 'listening');
    // Placement reads this device's heartbeat; global timers are off, so the journey sends it as the presence timer would.
    await app.presence.pulse(); heartbeat = setInterval(() => { void app.presence.pulse().catch(() => undefined); }, 60_000);
    browser = await chromium.launch({ channel: 'chrome', headless: authentication.codex !== 'subscription' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'jevellan_session', value: app.hubAuth.issue(), url, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); page.setDefaultTimeout(90_000); const errors = []; page.on('pageerror', () => errors.push('Browser script error'));
    const call = async (method, path, body) => {
      const send = () => page.request.fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { data: body }) });
      // The daemon closes idle kept-alive connections after five seconds; a read that leaves on one as it closes is sent again.
      const response = await send().catch((error) => { if (method === 'GET' && String(error).includes('ECONNRESET')) return send(); throw error; });
      const text = await response.text();
      assert(response.ok(), `${method} ${path} failed (${response.status()}): ${redact(text)}`); return text ? JSON.parse(text) : undefined;
    };
    const capture = async (name, expected) => {
      await expect(page.getByText(/^Rendering(?:\.\.\.|…)$/)).toHaveCount(0);
      assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `Horizontal overflow in ${name}`);
      const file = `PJ-live-${name}.png`; await page.screenshot({ path: join(output, file), fullPage: false });
      evidence.screenshots.push({ file, expected });
    };
    const empty = { schema: 'empty-request-v1' };

    // Setup through the product API: secrets enter the vault; subscription sign-in stays in the product UI and isolated home.
    await call('PUT', '/hub/secrets/jev', { schema: 'save-secret-v1', value: jevKey });
    assert.equal((await call('PUT', '/hub/secrets/github', { schema: 'save-secret-v1', value: githubToken })).saved, true, 'The GitHub token was not saved');
    const ready = async (id) => AccountViewSchema.parse(await call('GET', `/hub/accounts/${id}`)).statuses.some((status) => status.deviceId === app.device.deviceId && status.auth === 'ready');
    const subscription = authentication.codex === 'subscription';
    const codex = AccountViewSchema.parse(await call('POST', '/hub/accounts', { schema: 'add-account-v1', runtime: 'codex',
      ...(subscription ? { label: 'Codex test subscription', kind: 'subscription' } : { label: 'Codex test key', kind: 'api-key', paidUse: 'always', secret: codexKey }) }));
    if (subscription) {
      await page.goto(`${url}/settings/runtimes?account=${encodeURIComponent(codex.account.id)}&login=1`);
      note('Complete Codex subscription sign-in in the open Jevellan Settings window. The journey waits up to 30 minutes for this device to be ready.');
      try { await until('Codex subscription sign-in on this device', () => ready(codex.account.id), 30 * 60_000); }
      catch {
        evidence = { schema: evidence.schema, journey: evidence.journey, at: evidence.at, authentication, label: 'blocked', source: 'subscription-login', passed: false,
          blockedBy: [{ id: 'AUTH-CODEX', variables: ['codex'], reason: 'Codex subscription sign-in did not reach Ready on this device, so the coordinator and thread cannot run.' }],
          optionalMissing, variables, daemonStarted: true, checks: {}, screenshots: [], observations: [...evidence.observations,
            'The isolated daemon, browser and sandbox were prepared, but subscription sign-in did not reach Ready. No Projects work or pull request started. Login instructions and credentials are omitted.'] };
        console.log('PJ-live is blocked by AUTH-CODEX. No Projects work started.');
        return;
      }
    } else if (!(await ready(codex.account.id))) await call('POST', `/api/accounts/${codex.account.id}/check`, empty);
    assert(await ready(codex.account.id), 'The Codex test account is not ready'); evidence.codexAccountId = codex.account.id;
    if (claudeToken) {
      const claude = await call('POST', '/hub/accounts', { schema: 'add-account-v1', runtime: 'claude', label: 'Claude test subscription', kind: 'subscription', secret: claudeToken });
      if (!(await ready(claude.account.id))) await call('POST', `/api/accounts/${claude.account.id}/check`, empty);
      assert(await ready(claude.account.id), 'The Claude test account is not ready'); evidence.claudeAccountId = claude.account.id;
    }
    const current = await call('GET', '/hub/config'); const configuration = globalThis.structuredClone(current.configuration); const settings = configuration['x-jevellan'];
    settings.runtimes.codex = { ...settings.runtimes.codex, enabled: true }; settings.runtimes.claude = { ...settings.runtimes.claude, enabled: !!claudeToken };
    await call('PUT', '/hub/config', { schema: 'config-write-v1', revision: current.revision, configuration });
    let config = (await call('GET', '/hub/config')).configuration['x-jevellan'];
    if (!config.menu.some((entry) => entry.runtime === 'codex' && entry.enabled)) { await call('POST', `/api/accounts/${codex.account.id}/models`, empty); config = (await call('GET', '/hub/config')).configuration['x-jevellan']; }
    const codexModel = config.menu.find((entry) => entry.runtime === 'codex' && entry.enabled); assert(codexModel, 'No enabled Codex model after discovery');
    evidence.menu = config.menu.map(({ id, runtime, model, enabled, efforts }) => ({ id, runtime, model, enabled, efforts }));
    AccountListSchema.parse(await call('GET', '/hub/accounts'));

    // An external-policy project: Jevellan never publishes to main itself, so the thread works in a worktree and opens a pull request.
    await app.conversations.saveProject({ schema: 'project-write-v1', revision: 0, project: { schema: 'project-v1', id: PROJECT_ID, name: PROJECT_NAME,
      paths: { [app.device.deviceId]: sandbox }, branchPolicy: 'external', testCommand: 'npm test', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } } });
    for (const operation of (await app.conversations.contextPanel(PROJECT_ID)).operations) await app.conversations.wait(operation.conversationId);
    // The coordinator runs on Codex, so the Codex account always works; Jev places the thread on any enabled model.
    const work = ProjectWorkSettingsViewSchema.parse(await call('GET', `/api/projects/${PROJECT_ID}/work-settings`)).settings;
    await call('PUT', `/api/projects/${PROJECT_ID}/work-settings`, { schema: 'project-work-settings-request-v1', revision: work.revision, settings: { defaultIsolation: 'worktree',
      coordinator: { modelId: codexModel.id, effort: 'medium' }, setupCommand: work.setupCommand, maxRunningThreads: 1, maxRunningPerDevice: 1, threadTurnCap: work.threadTurnCap } });
    const before = { head: git(sandbox, ['rev-parse', 'HEAD']), status: git(sandbox, ['status', '--porcelain']) }; evidence.git = { before: before.head };
    assert.equal(before.status, '', 'The sandbox must start clean');
    const projectView = async () => ProjectWorkViewSchema.parse(await call('GET', `/api/projects/${PROJECT_ID}/work`));
    const threadView = async (id) => ThreadViewSchema.parse(await call('GET', `/api/projects/${PROJECT_ID}/threads/${id}`));
    const refresh = (id) => call('POST', `/api/projects/${PROJECT_ID}/threads/${id}/pr/refresh`, empty).catch(() => undefined);

    // 1. The owner asks the coordinator from the Projects page; the coordinator starts the thread.
    await page.goto(`${url}/projects/${PROJECT_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: PROJECT_NAME, exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message the coordinator', exact: true });
    await composer.fill(REQUEST); await composer.press('Enter'); await expect(composer).toHaveValue(''); evidence.request = REQUEST;
    const first = await until('the coordinator to start a thread', async () => {
      const view = await projectView();
      if (view.coordinator.state === 'unavailable') throw new Error(`The coordinator is unavailable: ${view.coordinator.unavailableReason ?? 'no reason given'}`);
      return [...view.threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    }, 20 * 60_000, 3000);
    const threadId = first.id;
    evidence.checks.coordinatorStartedThread = app.projectWork.store.get(threadId)?.createdBy === 'coordinator';
    evidence.checks.worktreeIsolation = first.isolation === 'worktree';
    await capture('chat', 'the project page with the owner request, the coordinator reply and the thread it started');

    // 2. The thread works, Jevellan verifies and publishes, and the pull request opens. A thread left idle on a report Jevellan
    // wrote for it (a failed push or pull request, a failed turn) gets ten minutes for the coordinator to act before the journey stops.
    let stuck;
    const opened = await until('the pull request to open', async () => {
      const view = await threadView(threadId); const last = view.reports.at(-1);
      if (view.thread.state === 'waiting-for-you') throw new Error(`The thread waits for the owner: ${view.thread.stateReason ?? last?.question ?? 'no reason given'}`);
      if (['done', 'stopped', 'failed'].includes(view.thread.state) && !view.thread.pr) throw new Error(`The thread ended as ${view.thread.state} without a pull request: ${view.thread.stateReason ?? 'no reason given'}`);
      const blocked = view.thread.state === 'idle' && last?.synthesized && last.status === 'blocked' ? `${view.thread.turns}` : undefined;
      if (blocked !== stuck?.turns) stuck = blocked ? { turns: blocked, since: Date.now() } : undefined;
      if (stuck && Date.now() - stuck.since >= 10 * 60_000) throw new Error(`The thread stayed blocked: ${view.thread.stateReason ?? last.summary}`);
      return view.thread.pr ? view : undefined;
    }, 90 * 60_000, 5000);
    const { placement } = opened; const number = opened.thread.pr.number;
    // The worktree exists once the thread has run; its owner-local path is read now, not at the first sight of the thread.
    const local = app.projectWork.store.get(threadId);
    evidence.thread = { id: threadId, title: opened.thread.title, branch: opened.thread.branch, isolation: opened.thread.isolation, runtime: opened.thread.runtime, model: opened.thread.modelLabel, effort: opened.thread.effort };
    evidence.placement = { source: placement.source, fixed: placement.fixed, isolation: placement.isolation, runtime: placement.runtime, modelId: placement.modelId, model: placement.model,
      effortRequested: placement.effortRequested, effortEffective: placement.effortEffective, accountId: placement.accountId, probabilities: placement.probabilities,
      eligibleModels: placement.eligibleModels, excludedModels: placement.excludedModels, jevCalls: placement.jevCalls.length, ...(placement.error ? { error: placement.error } : {}) };
    evidence.checks.jevPlaced = placement.source === 'jev' && placement.jevCalls.length > 0;
    evidence.checks.pullRequestOpened = opened.thread.pr.state === 'open' && !!opened.thread.branch?.startsWith('jv/');
    await page.goto(`${url}/projects/${PROJECT_ID}/threads/${threadId}`); await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await capture('thread', 'the thread page with its transcript, its report card and the open pull request');

    // 3. Jevellan reads the checks state from GitHub. "none" counts only after it held for a minute, so a workflow that has not
    // registered its checks yet is not mistaken for a repository without checks.
    let noneSince;
    const checked = await until('the checks state', async () => {
      await refresh(threadId); const view = await threadView(threadId); const checks = view.thread.pr?.checks;
      if (checks !== 'none') noneSince = undefined; else noneSince ??= Date.now();
      return checks === 'passing' || checks === 'failing' || (checks === 'none' && Date.now() - noneSince >= 60_000) ? view : undefined;
    }, 45 * 60_000, 15_000);
    const pr = checked.thread.pr; evidence.pullRequest = { number, url: pr.url, checks: pr.checks, mergeable: pr.mergeable, headSha: pr.headSha };
    evidence.checks.checksRead = pr.checks === 'passing' || pr.checks === 'none';
    assert.notEqual(pr.checks, 'failing', 'The pull request checks are failing; the journey does not merge failing work');
    const ledger = app.projectWork.ledgers.thread(PROJECT_ID, threadId);
    evidence.verifications = ledger.events().filter((event) => event.type === 'thread-verification').map((event) => ledger.payload(event))
      .map(({ attempt, command, status, exitCode, timedOut, commit, tail }) => ({ attempt, command, status, exitCode, timedOut, commit, tail: redact(tail).slice(-600) }));
    evidence.checks.verifiedBeforePublishing = evidence.verifications.some((entry) => entry.status === 'passed' && entry.commit === pr.headSha);

    // 4. The owner merges from the Projects page: Merge, then the confirmation.
    await page.goto(`${url}/projects/${PROJECT_ID}`);
    const card = page.getByRole('region', { name: 'Pull requests', exact: true }).locator('article.pw-pr').filter({ hasText: `#${number} ` });
    const merge = card.getByRole('button', { name: 'Merge', exact: true }); await expect(merge).toBeEnabled({ timeout: 5 * 60_000 });
    await capture('pull-request', `the Pull requests section with #${number}, its checks state and an enabled Merge button`);
    const answer = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/projects/${PROJECT_ID}/threads/${threadId}/pr/merge`, { timeout: 5 * 60_000 });
    await merge.click();
    const dialog = page.getByRole('dialog', { name: `Squash and merge #${number}?`, exact: true }); await expect(dialog).toBeVisible();
    await capture('merge', 'the Squash and merge confirmation for the pull request');
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
    const response = await answer; const merged = MergeResultViewSchema.parse(await response.json());
    evidence.merge = { status: response.status(), merged: merged.merged, ...(merged.message ? { message: merged.message } : {}) };
    evidence.checks.mergedFromThePage = merged.merged; await expect(dialog).toHaveCount(0, { timeout: 60_000 });

    // 5. The thread concludes: done and merged, worktree and local branch removed, the owner checkout untouched.
    const done = await until('the thread to conclude', async () => { await refresh(threadId); const view = await threadView(threadId); return view.thread.state === 'done' && view.thread.pr?.state === 'merged' ? view : undefined; }, 15 * 60_000, 10_000);
    evidence.checks.threadDone = true; evidence.thread.turns = done.thread.turns;
    evidence.reports = done.reports.map(({ turn, status, summary, testsRun, synthesized }) => ({ turn, status, synthesized, summary: redact(summary).slice(0, 600), ...(testsRun ? { testsRun: { command: testsRun.command, passed: testsRun.passed } } : {}) }));
    const branch = done.thread.branch ?? ''; const cwd = local?.cwd;
    evidence.checks.worktreeRemoved = !!cwd && await eventually(async () => !existsSync(cwd), 5 * 60_000);
    evidence.checks.localBranchRemoved = !!branch && await eventually(async () => git(sandbox, ['branch', '--list', branch]) === '', 2 * 60_000);
    evidence.git.after = git(sandbox, ['rev-parse', 'HEAD']);
    evidence.checks.checkoutUntouched = evidence.git.after === before.head && git(sandbox, ['status', '--porcelain']) === before.status;

    // GitHub's own record: merged into main, a source file added with a test, no attribution trailers in the commits.
    const pull = z.object({ merged: z.boolean(), merge_commit_sha: z.string().nullable(), base: z.object({ ref: z.string() }) }).parse(await github('GET', `/repos/${repo}/pulls/${number}`));
    const files = z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number() })).parse(await github('GET', `/repos/${repo}/pulls/${number}/files?per_page=100`));
    const commits = z.array(z.object({ commit: z.object({ message: z.string() }) })).parse(await github('GET', `/repos/${repo}/pulls/${number}/commits?per_page=100`));
    const isTest = (file) => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file.filename);
    evidence.github = { merged: pull.merged, base: pull.base.ref, mergeCommit: pull.merge_commit_sha, files: files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })), commits: commits.length };
    evidence.checks.mergedOnGitHub = pull.merged && pull.base.ref === 'main';
    evidence.checks.addedFileWithTest = files.some((file) => file.status === 'added' && !isTest(file)) && files.some(isTest);
    evidence.checks.noTrailers = commits.every((entry) => !/^(?:Co-authored-by|Generated-by|Claude-Session):/im.test(entry.commit.message));

    // The coordinator ran on the Codex account; every thread the coordinator started is accounted for.
    const coordinatorLedger = app.projectWork.ledgers.coordinator(PROJECT_ID);
    evidence.coordinatorTools = coordinatorLedger.events().filter((event) => event.type === 'coordinator-tool').map((event) => coordinatorLedger.payload(event))
      .map(({ tool, ok, summary }) => ({ tool, ok, summary: redact(summary) }));
    evidence.threadsStarted = (await projectView()).threads.length;
    evidence.checks.oneThread = evidence.threadsStarted === 1;
    evidence.checks.coordinatorOnCodex = evidence.launches.some((entry) => entry.owner === 'coordinator' && entry.runtime === 'codex' && entry.status === 'completed');

    await page.goto(`${url}/projects/${PROJECT_ID}`);
    await expect(page.getByRole('region', { name: 'Concluded', exact: true }).locator('.pw-outcome').filter({ hasText: `Merged #${number}` })).toBeVisible({ timeout: 60_000 });
    await capture('concluded', 'the project page with the thread under Concluded as merged and no open pull requests');
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: PROJECT_NAME, exact: true })).toBeVisible(); await sleep(1500);
    await capture('phone', 'the same project page on a phone');
    evidence.checks.noBrowserErrors = errors.length === 0;
    evidence.passed = Object.values(evidence.checks).every(Boolean);
    if (!evidence.passed) process.exitCode = 1;
    note(`PJ-live: ${evidence.passed ? 'all checks passed' : `failed checks: ${Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}`}.`);
  } catch (error) { evidence.error = redact(error instanceof Error ? error.stack ?? error.message : 'Journey failed').slice(0, 3000); process.exitCode = 1; console.log(evidence.error); }
  finally {
    if (heartbeat) clearInterval(heartbeat);
    const document = (evidence.label === 'blocked' ? BlockedEvidenceSchema : LiveEvidenceSchema).parse(evidence);
    const text = redact(JSON.stringify(app ? app.hub.redactor.document(document) : document, null, 2));
    for (const secret of [...secrets, repo]) assert(!text.toLowerCase().includes(secret.toLowerCase()), 'A credential value reached the evidence');
    writeFileSync(join(output, 'evidence.json'), text + '\n', { mode: 0o600 });
    await browser?.close(); await app?.close(); if (server) await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    if (cache) { try { git(userHome, ['credential-cache', '--socket', join(cache, 'socket'), 'exit']); } catch { /* the cache never started */ } rmSync(cache, { recursive: true, force: true }); }
  }
}
