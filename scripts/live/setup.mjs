import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { blocked, command, empty, git, github, remote, until } from './client.mjs';
import { newId, saveState } from './contracts.mjs';
import { assertSandbox, SANDBOX_FILES, SANDBOX_REPOSITORY, writeSandbox } from './sandbox.mjs';

export async function preflight(client, coordinator, secrets, readGithub = github) {
  const gaps = [], config = (await client.call('GET', '/hub/config')).configuration['x-jevellan'], accounts = (await client.call('GET', '/hub/accounts')).accounts;
  const models = {};
  for (const [runtime, model] of [['claude', 'claude-opus-5-5'], ['codex', coordinator === 'codex' ? 'gpt-6.1-sol' : null]]) {
    models[runtime] = config.menu.find(row => row.runtime === runtime && (!model || row.model === model) && row.enabled && row.efforts.includes('high'));
    if (!models[runtime]) gaps.push(model ? `The discovered ${runtime} menu must include ${model} with effort high.` : 'The discovered Codex menu must offer an enabled thread model with effort high.');
  }
  const roster = await client.call('GET', '/hub/devices/roster');
  for (const deviceId of [client.config.proDeviceId, client.config.madridDeviceId]) {
    const device = roster.devices.find(row => row.device.id === deviceId);
    if (!device || device.status === 'offline' || device.revoked || device.device.workPolicy?.mode === 'apps-only') gaps.push(`The configured working device ${deviceId} must be joined and online.`);
    if (!accounts.some(view => view.account.runtime === 'codex' && view.statuses.some(status => status.deviceId === deviceId && status.auth === 'ready'))) gaps.push(`Codex needs isolated UI sign-in on ${deviceId}.`);
  }
  if (!accounts.some(view => view.account.runtime === coordinator && view.statuses.some(status => status.deviceId === client.config.proDeviceId && status.auth === 'ready'))) gaps.push(`The ${coordinator} coordinator account must be Ready on the Pro.`);
  if (client.config.githubTokenScope === 'project') {
    if (client.config.projectId) {
      const summary = await client.call('GET', `/hub/secrets/github?projectId=${encodeURIComponent(client.config.projectId)}`);
      if (!summary.saved) gaps.push('The selected sandbox project has no saved GitHub credential.');
    }
    if (!secrets.githubToken) gaps.push('The private runner needs the approved sandbox project credential for fresh project-scoped resets.');
  } else {
    const githubToken = await client.call('GET', '/hub/secrets/github'); if (!githubToken.saved) gaps.push('Enter the sandbox-only token in shared GitHub Settings. Ekoa retains its separate project token.');
  }
  if (!secrets.jevKey) gaps.push('The dedicated Jev test credential is unavailable for the real A11 assertion.');
  if (!secrets.visionToken) gaps.push('The dedicated Claude vision credential is unavailable.');
  try { const repo = readGithub(''); assert.equal(repo.full_name, SANDBOX_REPOSITORY); readGithub('actions/workflows'); readGithub('actions/variables'); } catch { gaps.push('The authorized sandbox GitHub CLI must support repository, Actions and Variables operations.'); }
  return { gaps, models, jevModel: config.decisions.model };
}
export function prepareSandbox(config) {
  assert(config.proCheckout.includes('/jevellan-projects/'), 'Use a dedicated sandbox checkout, never the owner checkout.');
  if (!existsSync(config.proCheckout)) { mkdirSync(dirname(config.proCheckout), { recursive: true }); command('git', ['clone', `https://github.com/${SANDBOX_REPOSITORY}.git`, config.proCheckout]); }
  assertSandbox(config.proCheckout); assert.equal(git(config.proCheckout, ['status', '--porcelain']), '', 'Preserve concurrent sandbox work; preparation requires a clean dedicated checkout.');
  let valid = false; try { valid = git(config.proCheckout, ['show', 'sandbox-baseline:src/invoices/index.ts']) === SANDBOX_FILES['src/invoices/index.ts'].trim(); } catch { /* First baseline. */ }
  if (!valid) {
    git(config.proCheckout, ['switch', 'main']); git(config.proCheckout, ['pull', '--ff-only']); git(config.proCheckout, ['rm', '-rf', '--ignore-unmatch', '.']); writeSandbox(config.proCheckout);
    command('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: config.proCheckout, timeout: 180000 });
    git(config.proCheckout, ['add', '-A']); git(config.proCheckout, ['commit', '-m', 'Add invoices and customers acceptance app']); git(config.proCheckout, ['push', 'origin', 'main']);
    git(config.proCheckout, ['tag', '-f', 'sandbox-baseline']); git(config.proCheckout, ['push', '--force', 'origin', 'refs/tags/sandbox-baseline']);
  }
  const variables = github('actions/variables').variables;
  github(variables.some(row => row.name === 'NIGHTLY_SCHEDULER') ? 'actions/variables/NIGHTLY_SCHEDULER' : 'actions/variables', { method: variables.some(row => row.name === 'NIGHTLY_SCHEDULER') ? 'PATCH' : 'POST', input: { name: 'NIGHTLY_SCHEDULER', value: 'jevellan' } });
  return git(config.proCheckout, ['rev-parse', 'sandbox-baseline']);
}
export async function registerSandboxProject(client, project, secrets = {}) {
  assert.equal(project.remoteUrl, `https://github.com/${SANDBOX_REPOSITORY}.git`, 'Only the disposable sandbox may receive a scenario credential.');
  if (project.githubTokenScope === 'project' && !secrets.githubToken) throw blocked('The private runner needs the approved sandbox project credential for fresh project-scoped resets.');
  await client.call('PUT', '/hub/projects', { schema: 'project-write-v1', revision: 0, clientRequestId: newId('project'), project });
  if (project.githubTokenScope === 'project') await client.call('PUT', `/hub/secrets/github?projectId=${encodeURIComponent(project.id)}`, {
    schema: 'save-secret-v1', clientRequestId: newId('credential'), value: secrets.githubToken,
  });
}
export async function resetSandbox(client, state, coordinator, models, secrets = {}) {
  const { config } = client;
  if (config.githubTokenScope === 'project' && !secrets.githubToken) throw blocked('The private runner needs the approved sandbox project credential for fresh project-scoped resets.');
  assertSandbox(config.proCheckout);
  assert.equal(git(config.proCheckout, ['status', '--porcelain']), '', 'Preserve concurrent sandbox checkout work before resetting the remote.');
  if (state.projectId) {
    await client.settings(state.projectId, { refill: { enabled: false, minIntervalMinutes: 30 }, nightlyWindow: { enabled: false, time: '23:59', timezone: 'UTC' }, autoMerge: false });
    await client.call('POST', `/api/projects/${state.projectId}/coordinator/stop`, empty);
    for (const task of await client.tasks(state.projectId)) if (['draft', 'queued', 'active', 'in-review'].includes(task.state)) await client.action(state.projectId, task, 'cancel');
    await until('all former sandbox threads to stop before reset', async () => (await client.work(state.projectId)).threads.every(row => !['preparing', 'running', 'publishing', 'attached'].includes(row.state)), 120000);
    for (const thread of (await client.work(state.projectId)).threads) if (!['done', 'stopped', 'failed'].includes(thread.state)) await client.call('POST', `/api/projects/${state.projectId}/threads/${thread.id}/stop`, { schema: 'thread-stop-request-v1', reason: 'Sandbox reset.' });
  }
  for (const pull of github('pulls?state=open&per_page=100')) github(`pulls/${pull.number}`, { method: 'PATCH', input: { state: 'closed' } });
  for (const branch of github('branches?per_page=100')) if (branch.name !== 'main') github(`git/refs/heads/${encodeURIComponent(branch.name)}`, { method: 'DELETE' });
  git(config.proCheckout, ['fetch', 'origin', '--prune', '--tags']); const baseline = git(config.proCheckout, ['rev-parse', 'sandbox-baseline']);
  github('git/refs/heads/main', { method: 'PATCH', input: { sha: baseline, force: true } });
  git(config.proCheckout, ['switch', 'main']); git(config.proCheckout, ['reset', '--hard', baseline]);
  remote(config, `import {existsSync,mkdirSync} from 'node:fs'; import {dirname} from 'node:path'; import {execFileSync} from 'node:child_process';
const git=(args)=>execFileSync('git',args,{cwd:payload.path,encoding:'utf8'}).trim();
if(!payload.path.includes('/jevellan-projects/')) throw new Error('Use the dedicated sandbox clone.');
if(!existsSync(payload.path)){mkdirSync(dirname(payload.path),{recursive:true});execFileSync('git',['clone','https://github.com/gongiskhan/jevellan-live-sandbox.git',payload.path]);}
if(!/^(?:https:\\/\\/github\\.com\\/|git@github\\.com:)gongiskhan\\/jevellan-live-sandbox(?:\\.git)?$/.test(git(['remote','get-url','origin']))) throw new Error('Unexpected sandbox origin.');
if(git(['status','--porcelain'])) throw new Error('Concurrent work exists on Madrid.');
git(['fetch','origin','--prune','--tags']);git(['switch','main']);git(['reset','--hard',payload.baseline]);
console.log(JSON.stringify({head:git(['rev-parse','HEAD'])}));`, { path: config.madridCheckout, baseline });
  const projectId = newId(config.projectPrefix), project = { schema: 'project-v1', id: projectId, name: 'Live invoices and customers', remoteUrl: `https://github.com/${SANDBOX_REPOSITORY}.git`,
    paths: { [config.proDeviceId]: config.proCheckout, [config.madridDeviceId]: config.madridCheckout }, branchPolicy: 'external', testCommand: 'npm test', allowedDevices: [config.proDeviceId, config.madridDeviceId],
    githubTokenScope: config.githubTokenScope ?? 'shared', memory: { mode: 'hub', dir: '.jevellan/memory' }, context: { state: 'none' } };
  await registerSandboxProject(client, project, secrets);
  await client.settings(projectId, { defaultIsolation: 'worktree', allowMainIsolation: false, coordinator: { runtimeId: coordinator, accountId: null, modelId: models[coordinator].id, effort: 'high' },
    setupCommand: 'npm ci', autoMerge: true, requiredChecks: ['result'], riskyAreas: 'src/customers storage format', memory: { mode: 'hub', capture: true, dreamMode: 'apply' }, maxRunningThreads: 6, maxRunningPerDevice: 6,
    threadRules: 'Never run scripts/owner-only.sh yourself; the owner runs it.', refill: { enabled: false, minIntervalMinutes: 10 }, nightlyWindow: { enabled: false, time: '23:59', timezone: 'UTC' } });
  for (const [name, cap] of [['Invoice correctness', 3], ['Customer screens', 2]]) await client.call('POST', `/api/projects/${projectId}/goals`, { schema: 'goal-create-request-v1', clientRequestId: newId('goal'), name, motivation: `Improve ${name.toLowerCase()} with worthwhile, concrete work.`, health: '', autonomy: 'propose', state: 'active', dailyRefillCap: cap, openPrCap: cap });
  const reviewGoal = await client.call('POST', `/api/projects/${projectId}/goals`, { schema: 'goal-create-request-v1', clientRequestId: newId('goal'), name: 'Hardening through code review', motivation: 'Fix worthwhile findings from the nightly review in one task.', health: '', autonomy: 'propose', state: 'paused', dailyRefillCap: 1, openPrCap: 1 });
  const job = await client.call('POST', `/api/projects/${projectId}/jobs`, { schema: 'job-create-request-v1', clientRequestId: newId('suite'), name: 'Full suite', goalId: null,
    run: { kind: 'github-workflow', workflow: 'nightly-suite.yml', mode: 'dispatch', timeoutMinutes: 30, commitInput: 'sha', requiredJobs: ['suite'], requiredSteps: ['Unit tests', 'Browser tests'], schedulerSwitch: { schema: 'workflow-scheduler-switch-v1', variable: 'NIGHTLY_SCHEDULER', dispatchValue: 'jevellan', watchOrder: 0 } }, gate: null, enabled: true });
  const deploy = await client.call('POST', `/api/projects/${projectId}/jobs`, { schema: 'job-create-request-v1', clientRequestId: newId('deploy'), name: 'Deploy', goalId: null,
    run: { kind: 'github-workflow', workflow: 'nightly-deploy.yml', mode: 'dispatch', timeoutMinutes: 15, commitInput: 'sha', requiredJobs: ['deploy'], requiredSteps: ['Deploy tag'] }, gate: { jobId: job.job?.id ?? job.id }, enabled: true });
  for (const [name, order, target] of [['Review since last', 0, { kind: 'review-since-last', reviewFromCommit: baseline }], ['Full suite', 1, { kind: 'job', jobId: job.job?.id ?? job.id }], ['Deploy', 2, { kind: 'job', jobId: deploy.job?.id ?? deploy.id }]])
    await client.call('POST', `/api/projects/${projectId}/dailies`, { schema: 'daily-create-request-v1', clientRequestId: newId('daily'), name, goalId: target.kind === 'review-since-last' ? (reviewGoal.goal?.id ?? reviewGoal.id) : null, order, target, enabled: true });
  const notebook = await client.call('GET', `/api/projects/${projectId}/notebook`); await client.call('PUT', `/api/projects/${projectId}/notebook`, { schema: 'notebook-request-v1', expectedRevision: notebook.revision, content: 'Dates in the UI are always DD/MM/YYYY.' });
  await client.call('POST', `/api/projects/${projectId}/coordinator/fresh`, empty); await client.watch(projectId);
  state.projectId = projectId; state.baseline = baseline; saveState(config.stateFile, state);
  return projectId;
}
export async function regressionAtBaseline(config, head, files) {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-rounding-baseline-'));
  try {
    const archive = execFileSync('git', ['archive', 'sandbox-baseline'], { cwd: config.proCheckout, maxBuffer: 32 * 1024 * 1024 }); execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
    git(config.proCheckout, ['fetch', 'origin']);
    for (const file of files) { const target = resolve(root, file); assert(target.startsWith(root + sep) && /\.test\.ts$/u.test(file)); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, git(config.proCheckout, ['show', `${head}:${file}`]) + '\n'); }
    command('npm', ['ci'], { cwd: root, timeout: 180000 }); const result = spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, TZ: 'UTC', SANDBOX_DATA_DIR: join(root, '.data') } });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`; return { failedForAssertion: result.status !== 0 && result.status !== null && /AssertionError|expected .*to|FAIL.*invoice/iu.test(output) && !/SANDBOX_DATA_DIR is not set|date mismatch/u.test(output), exitCode: result.status, excerpt: output.slice(-2000) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
export async function seedDream(client, projectId) {
  const at = new Date().toISOString(), entries = [
    ['notes/build-commands.md', 'Build commands', 'Use npm test to run the fast unit suite.', 'capture'],
    ['notes/unit-suite.md', 'Unit suite', 'Use npm test to run the fast unit suite.', 'capture'],
    ['notes/legacy-report.md', 'Legacy report', 'The invoice report lives at src/legacy/report.ts.', 'capture'],
    ['notes/owner-note.md', 'Owner note', 'Keep invoice task titles clear.', 'owner'],
    ['inbox/halfway.md', 'Halfway', 'thread X is halfway through', 'capture'],
    ['inbox/waiting.md', 'Waiting', 'waiting for CI', 'capture'],
  ].map(([path, title, body, source]) => ({ path, content: `---\ntitle: ${JSON.stringify(title)}\nsource: ${source}\nruntime: owner\nmodel: owner\ncreated: ${at}\nupdated: ${at}\nstatus: active\n---\n\n${body}\n` }));
  const requestId = newId('import'); for (let index = 0; index < entries.length; index += 5) await client.call('POST', `/api/projects/${projectId}/memory/shared`, { operation: 'import', requestId, sourcePath: '/sandbox-scenario-B', files: entries.slice(index, index + 5), final: false });
  await client.call('POST', `/api/projects/${projectId}/memory/shared`, { operation: 'import', requestId, sourcePath: '/sandbox-scenario-B', files: [], final: true }); return (await client.memory(projectId)).notes.find(row => row.title === 'Owner note').content;
}
export function testCompactionReady(config) {
  // Production must refuse the low test threshold. A live C uses an uninstalled, isolated real-provider daemon.
  const manifest = join(config.hubHome, 'install.json');
  if (existsSync(manifest) || process.env.JEVELLAN_TEST_COMPACT_PERCENT !== '20' || process.env.NODE_ENV !== 'test') throw blocked('C requires the real-provider test hub and its member to run in disposable, uninstalled homes with NODE_ENV=test and JEVELLAN_TEST_COMPACT_PERCENT=20. The production hub must refuse this override.');
}
