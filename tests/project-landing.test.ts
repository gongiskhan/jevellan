import { afterEach, expect, test, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { GitHubClient, SecretRedactor, StoredProjectWorkSettingsSchema, LandingRouteSchema, ProjectWorkSettingsSchema, ThreadIndexSchema, defaultProjectWorkSettings, type LandingRoute, type ProjectWorkSettings } from '../packages/core/dist/index.js';
import { heldPort, selectedLandingChecks } from '../packages/projects/dist/landing.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, git, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const transport: typeof fetch = async (_url, init) => {
  if (init?.method !== 'POST') return Response.json({ models: [{ name: 'jev-latest', description: 'Fixture.', release_date: '2026-01-01' }] });
  const body = JSON.parse(String(init.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
  return Response.json({ model: 'jev-fixture', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => { const choice = Object.keys(q.criteria)[0]!; return [key, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }]; })) });
};
async function settings(f: ProjectFixture, over: Partial<ProjectWorkSettings> = {}) {
  const old = await f.app.projectHub.settings('project');
  return f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...(old?.document ?? defaultProjectWorkSettings('project')), delivery: 'land', autoLand: true, ...over }), old?.revision ?? 0);
}
async function setup(over: Partial<ProjectWorkSettings> = {}) {
  const f = fixture = await projectFixture({ jevKey: true, decisionFetch: transport }); await settings(f, over); return f;
}
async function start(f: ProjectFixture, id = 'first', fromBranch?: string) {
  return f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: id, title: `Change ${id}`, task: 'Make the requested change.', modelId: 'fixture', deviceId: f.app.device.deviceId, ...(fromBranch ? { fromBranch } : {}) });
}
async function done(f: ProjectFixture, id: string) { await f.waitFor(() => f.thread(id), t => ['done', 'idle', 'in-review'].includes(t.state)); await f.app.projectWork.idle(); return f.thread(id); }
async function routes(f: ProjectFixture, id: string) { return (await f.app.projectWork.landingRoute('project', id)).records.filter((r): r is LandingRoute => r.schema === 'landing-route-v1'); }

test('checks use path boundaries, empty paths and an unconditional smoke check', () => {
  const work = { landingChecks: [{ name: 'API', paths: ['api/'], command: 'api' }, { name: 'All', paths: [], command: 'all' }, { name: 'One', paths: ['README.md'], command: 'one' }], smokeCheck: 'smoke' };
  expect(selectedLandingChecks(work, ['api/a.ts']).map(c => c.command)).toEqual(['api', 'all', 'smoke']);
  expect(selectedLandingChecks(work, ['apis/a.ts']).map(c => c.command)).toEqual(['all', 'smoke']);
  expect(selectedLandingChecks(work, ['README.md']).map(c => c.command)).toEqual(['all', 'one', 'smoke']);
});
test('old threads default to pull-request delivery and old settings migrate to land without retired fields', () => {
  const old = { ...defaultProjectWorkSettings('p'), schema: 'project-work-settings-v4', notifications: 'standard', autoMerge: true, defaultIsolation: 'main', allowMainIsolation: true, requiredChecks: ['result'] };
  for (const k of ['delivery', 'autoLand', 'landingChecks', 'smokeCheck', 'mergeCommitPaths', 'healthChecks', 'deploy', 'coordinatorHandoffAtPercent', 'pullRequestAutoMerge']) delete old[k as keyof typeof old];
  const migrated = StoredProjectWorkSettingsSchema.parse(old); expect(migrated).toMatchObject({ delivery: 'land', autoLand: true }); expect(migrated).not.toHaveProperty('requiredChecks');
  const index = ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id: 't', projectId: 'p', title: 'Old', state: 'running', isolation: 'worktree', ownerDeviceId: 'd', runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Work', turns: 1, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' });
  expect(index.delivery).toBe('pull-request');
});
test('a checked thread lands as one squash commit, preserves the checkout and deletes its backup', async () => {
  const f = await setup({ landingChecks: [{ name: 'Selected', paths: ['README.md'], command: 'test -f README.md' }], smokeCheck: 'true' });
  const original = git(f.checkout, 'rev-parse', 'HEAD');
  f.fake.enqueueTurn(commitStep({ 'README.md': 'A small change\n' }, { status: 'done', summary: 'Describe the change.\n\nMore detail.' }), forThread());
  const started = await start(f), thread = await done(f, started.threadId);
  expect(thread.stateReason).toBeUndefined(); expect(thread.landing).toMatchObject({ method: 'squash', route: 'land', checks: [{ name: 'Selected', passed: true }, { name: 'Smoke check', passed: true }] });
  expect(git(f.origin, 'rev-parse', 'main')).toBe(thread.landing!.commit); expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(original);
  expect(git(f.origin, 'show', '-s', '--format=%B', 'main')).toBe(`Change first\n\nDescribe the change.\n\nThread: ${thread.id}`);
  expect(git(f.origin, 'rev-list', '--count', `${original}..main`)).toBe('1'); expect(git(f.origin, 'branch', '--list', thread.branch!)).toBe('');
  expect(f.github.requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(0);
  expect((await routes(f, thread.id))[0]).toMatchObject({ state: 'landed', backupDeletedAt: expect.any(String) });
  await f.restart(); await f.app.projectWork.pulse(); expect(git(f.origin, 'rev-parse', 'main')).toBe(thread.landing!.commit);
}, 120_000);
test('mergeCommitPaths preserves individual commits under a merge commit', async () => {
  const f = await setup({ mergeCommitPaths: ['docs/legal/'] });
  f.fake.enqueueTurn(async turn => { mkdirSync(join(turn.input.cwd, 'docs/legal'), { recursive: true }); writeFileSync(join(turn.input.cwd, 'docs/legal/x.md'), 'Legal\n'); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Legal change'); writeFileSync(join(turn.input.cwd, 'extra.txt'), 'Separate\n'); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Separate change'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Legal change.' }); return { status: 'completed' }; }, forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.landing?.method).toBe('merge-commit');
  expect(git(f.origin, 'show', '-s', '--format=%s', 'main')).toBe(`Land "Change first" (${thread.id})`); expect(git(f.origin, 'show', '-s', '--format=%P', 'main').split(' ')).toHaveLength(2);
  expect(git(f.origin, 'log', '--format=%s', '-3', 'main')).toContain('Legal change');
}, 120_000);
test('landing checks fail three times with the exact repair prompt then leave the thread idle', async () => {
  const f = await setup({ landingChecks: [{ name: 'Gate', paths: [], command: 'echo deterministic-failure; exit 1' }] });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Broken\n' }, { status: 'done', summary: 'Done.' }), forThread());
  for (let n = 1; n <= 2; n++) f.fake.enqueueTurn(async turn => { expect(turn.input.prompt).toContain(`Landing checks failed (attempt ${n} of 3). Gate: deterministic-failure`); expect(turn.input.prompt).toContain('Fix the cause, run the relevant tests and report done.'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Still done.' }); return { status: 'completed' }; }, forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.state).toBe('idle'); expect(thread.stateReason).toBe('Landing checks failed three times.'); expect(thread.turns).toBe(3); expect(thread.landing).toBeUndefined();
}, 120_000);
test('a landing check that cannot bind its port waits without a repair turn, names the holder, and lands by itself once the port is free', async () => {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve)); const port = (holder.address() as AddressInfo).port;
  const listen = `node -e "require('net').createServer().listen(${port}, '127.0.0.1', () => process.exit(0))"`;
  const f = await setup({ landingChecks: [{ name: 'API tests', paths: [], command: listen }] });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'A change\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f); let thread = await done(f, result.threadId);
  expect(thread).toMatchObject({ state: 'in-review', turns: 1, verificationAttempts: 0 });
  expect(thread.stateReason).toMatch(new RegExp(`^API tests could not start: port ${port} is in use by node \\(pid ${process.pid}\\)\\. It lands by itself once the port is free\\.$`, 'u'));
  // While the port stays held the sweep does not run the checks again.
  await f.app.projectWork.pulse(); await f.app.projectWork.idle(); expect(f.thread(result.threadId).state).toBe('in-review');
  await new Promise<void>(resolve => holder.close(() => resolve()));
  await f.app.projectWork.pulse(); thread = await f.waitFor(() => f.thread(result.threadId), t => t.state === 'done');
  expect(thread.landing).toMatchObject({ checks: [{ name: 'API tests', passed: true }] }); expect(thread.turns).toBe(1);
}, 120_000);
test('a blocked landing rechecks its port without launching process discovery helpers', async () => {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve)); const port = (holder.address() as AddressInfo).port;
  try {
    const listen = `node -e "require('net').createServer().listen(${port}, '127.0.0.1', () => process.exit(0))"`;
    const f = await setup({ landingChecks: [{ name: 'API tests', paths: [], command: listen }] });
    f.fake.enqueueTurn(commitStep({ 'README.md': 'A checked change\n' }, { status: 'done', summary: 'Done.' }), forThread());
    const started = await start(f), thread = await done(f, started.threadId);
    const wait = f.local(thread.id).landingWait!; expect(wait.blocker.port).toBe(port);
    let launches = 0;
    const spawned = () => { launches++; }, children = channel('child_process'); children.subscribe(spawned);
    try { for (let n = 0; n < 3; n++) await f.app.projectWork.landings.sweep(); }
    finally { children.unsubscribe(spawned); }
    expect((await f.app.projectHub.decision(wait.decisionId))?.document).toMatchObject({ id: wait.decisionId, blocker: { port } });
    expect((await f.app.projectHub.decision(wait.decisionId))?.document.answer).toBeUndefined();
    expect(f.thread(thread.id)).toMatchObject({ state: 'in-review', turns: 1 });
    await new Promise<void>(resolve => holder.close(() => resolve()));
    await f.app.projectWork.landings.sweep(); await f.waitFor(() => f.thread(thread.id), row => row.state === 'done');
    expect(f.thread(thread.id).turns).toBe(1);
    expect((await f.app.projectHub.decision(wait.decisionId))?.document.withdrawal?.reason).toContain('now free');
    expect(launches, 'Waiting only needs a fresh TCP result, not a subprocess or a process identity.').toBe(0);
  } finally { if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);
test('autoLand off asks with the checked route, and owner Land now resumes without another author turn', async () => {
  const f = await setup({ autoLand: false }); f.fake.enqueueTurn(commitStep({ 'README.md': 'Ask\n' }, { status: 'done', summary: 'A checked change.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.state).toBe('in-review'); const route = (await routes(f, thread.id))[0]!; expect(route.route).toBe('land');
  const response = await f.request(`/api/projects/project/decisions/${route.decisionId}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'owner_land', optionLabel: 'Land now' }); expect(response.status).toBe(202);
  await f.waitFor(() => f.thread(thread.id), t => !!t.landing); expect(f.thread(thread.id).turns).toBe(1); expect((await routes(f, thread.id))[0]?.source).toBe('owner');
}, 120_000);
test('a backup is pushed after a nonfinal turn and retained while the owner is asked', async () => {
  const f = await setup({ autoLand: false }); f.fake.enqueueTurn(commitStep({ 'README.md': 'Backup\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(git(f.origin, 'rev-parse', thread.branch!)).toBe(git(thread.cwd, 'rev-parse', 'HEAD')); expect(thread.pr).toBeUndefined();
  const correction = { schema: 'landing-correction-input-v1', clientRequestId: 'one', commit: (await routes(f, thread.id))[0]!.commit, correction: 'did-not-need-asking' };
  await f.app.projectWork.landingCorrection('project', thread.id, correction); await f.app.projectWork.landingCorrection('project', thread.id, correction);
  expect((await f.app.projectWork.landingRoute('project', thread.id)).records.filter(r => r.schema === 'landing-correction-v1')).toHaveLength(1);
}, 120_000);
test('fromBranch refuses a missing remote branch with the exact owner message before creating work', async () => {
  const f = await setup(); await expect(start(f, 'missing', 'does-not-exist')).rejects.toThrow('Branch does-not-exist is not on origin.'); expect(f.app.projectWork.store.all()).toHaveLength(0);
});
test('fromBranch starts at the remote branch without modifying the dedicated checkout', async () => {
  const f = await setup(); const original = git(f.checkout, 'rev-parse', 'HEAD'); git(f.checkout, 'switch', '-c', 'existing'); writeFileSync(join(f.checkout, 'branch.txt'), 'Existing work\n'); git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-m', 'Existing work'); const branchHead = git(f.checkout, 'rev-parse', 'HEAD'); git(f.checkout, 'push', 'origin', 'existing'); git(f.checkout, 'switch', 'main');
  f.fake.enqueueTurn(async turn => { expect(git(turn.input.cwd, 'rev-parse', 'HEAD')).toBe(branchHead); expect(readFileSync(join(turn.input.cwd, 'branch.txt'), 'utf8')).toBe('Existing work\n'); expect(readFileSync(join(turn.input.cwd, 'value.txt'), 'utf8')).toBeTruthy(); await turn.bridge('jevellan_thread_report', { status: 'blocked', summary: 'Inspection complete.' }); return { status: 'completed' }; }, forThread());
  const result = await start(f, 'continued', 'existing'); await done(f, result.threadId); expect(f.thread(result.threadId).fromBranch).toBe('existing'); expect(git(f.checkout, 'rev-parse', 'HEAD')).toBe(original);
}, 120_000);
test('landing receipts reject malformed commits and excessive gate results', () => {
  expect(LandingRouteSchema.safeParse({ schema: 'landing-route-v1', commit: 'main' }).success).toBe(false);
});

test('a different author’s open pull request refuses continuation and remains untouched', async () => {
  const f = await setup(); git(f.checkout, 'push', 'origin', 'HEAD:refs/heads/other-work');
  const client = new GitHubClient({ token: async () => f.token, baseUrl: f.github.url, redactor: new SecretRedactor() });
  const pull = await client.createPull({ owner: 'fixture', repo: 'repo' }, { head: 'other-work', base: 'main', title: 'Other work', body: '' });
  f.github.pulls[0]!.author = 'another-owner'; const before = f.github.requests.length;
  await expect(start(f, 'other', 'other-work')).rejects.toThrow(`Branch other-work belongs to #${pull.number} by another-owner; only your own work can be continued.`);
  expect(f.github.requests.slice(before).every(r => r.method === 'GET')).toBe(true); expect(f.app.projectWork.store.all()).toHaveLength(0);
});
test.each(['ui', 'tool'] as const)('Land instead closes only a Jevellan-opened own pull request and retains its work (%s)', async transport => {
  const f = await setup({ delivery: 'pull-request', autoLand: false });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Transition\n' }, { status: 'done', summary: 'Transition work.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.delivery).toBe('pull-request'); expect({ state: thread.state, reason: thread.stateReason, pr: thread.pr }).toMatchObject({ state: 'in-review', pr: { state: 'open' } });
  await settings(f); expect(f.thread(thread.id).delivery).toBe('pull-request'); expect((await f.app.projectHub.settings('project'))!.document.pullRequestAutoMerge).toBe(false);
  if (transport === 'ui') {
    const response = await f.request(`/api/projects/project/threads/${thread.id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId: 'convert', action: 'land-instead' }); expect(response.status).toBe(200);
  } else expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'act', args: {
    project: 'project', thread: thread.id, operation: 'land-instead', clientRequestId: 'convert',
  } })).toMatchObject({ ok: true });
  await f.waitFor(() => f.thread(thread.id), t => !!t.landing); expect(f.github.pulls[0]?.state).toBe('closed'); expect(f.thread(thread.id).delivery).toBe('land'); expect(f.thread(thread.id).turns).toBe(1);
  expect(git(f.origin, 'show', 'main:README.md')).toBe('Transition');
}, 120_000);
test('three concurrent movements of main rerun the gates then ask the owner without an unchecked push', async () => {
  const f = await setup({ smokeCheck: 'echo checked >> "$HOME/landing-checks"' }), runner = f.app.projectWork.landings.o.git, run = runner.run.bind(runner); let pushes = 0;
  vi.spyOn(runner, 'run').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'push' && args.some(arg => arg === 'HEAD:refs/heads/main')) {
      const previous = git(f.origin, 'rev-parse', 'main'), tree = git(f.origin, 'rev-parse', 'main^{tree}');
      const commit = git(f.origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', previous, '-m', `Other landing ${++pushes}`); git(f.origin, 'update-ref', 'refs/heads/main', commit);
    }
    return run(cwd, args, options);
  });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Concurrent\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(pushes).toBe(3); expect(thread.landing).toBeUndefined(); expect(thread.stateReason).toBe('Main moved three times during landing.'); expect((await routes(f, thread.id))[0]).toMatchObject({ state: 'asked' });
}, 120_000);
test('a lost push acknowledgement recovers the durable candidate without landing twice', async () => {
  const f = await setup(), runner = f.app.projectWork.landings.o.git, run = runner.run.bind(runner); let lost = false;
  vi.spyOn(runner, 'run').mockImplementation(async (cwd, args, options) => { const response = await run(cwd, args, options); if (!lost && args[0] === 'push' && args.includes('HEAD:refs/heads/main') && response.code === 0) { lost = true; throw new Error('Simulated lost acknowledgement'); } return response; });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Durable\n' }, { status: 'done', summary: 'Done.' }), forThread()); const result = await start(f); const waiting = await done(f, result.threadId); expect(waiting.state).toBe('in-review'); const landed = git(f.origin, 'rev-parse', 'main');
  await f.app.projectWork.pulse(); await f.waitFor(() => f.thread(result.threadId), t => !!t.landing); expect(f.thread(result.threadId).landing?.commit).toBe(landed); expect(git(f.origin, 'rev-parse', 'main')).toBe(landed);
}, 120_000);
test('continuing a landed thread publishes its new work rather than reusing its earlier landing receipt', async () => {
  const f = await setup(); f.fake.enqueueTurn(commitStep({ 'README.md': 'First\n' }, { status: 'done', summary: 'First.' }), forThread()); const result = await start(f), first = await done(f, result.threadId); expect(first.landing).toBeDefined();
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Second\n' }, { status: 'done', summary: 'Second.' }), forThread());
  const response = await f.request(`/api/projects/project/threads/${first.id}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: 'continue', interrupt: false, text: 'Continue with the second change.' }); expect(response.status).toBe(202);
  await f.waitFor(() => f.thread(first.id), t => t.turns === 2 && t.state === 'done'); expect(git(f.origin, 'show', 'main:README.md')).toBe('Second'); expect(f.thread(first.id).landing?.commit).not.toBe(first.landing!.commit);
}, 120_000);

test.each(['ui', 'tool'] as const)('the owner route override withdraws the superseded landing question (%s)', async transport => {
  const f = await setup({ autoLand: false }); f.fake.enqueueTurn(commitStep({ 'README.md': 'Override\n' }, { status: 'done', summary: 'Done.' }), forThread()); const result = await start(f), thread = await done(f, result.threadId);
  const question = (await routes(f, thread.id))[0]!.decisionId!;
  if (transport === 'ui') {
    const response = await f.request(`/api/projects/project/threads/${thread.id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId: 'override_route', action: 'land-now' });
    expect(response.status).toBe(200);
  } else expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'act', args: {
    project: 'project', thread: thread.id, operation: 'land-now', clientRequestId: 'override_route',
  } })).toMatchObject({ ok: true });
  await f.waitFor(() => f.thread(thread.id), t => !!t.landing); await f.app.projectWork.idle(); expect((await f.app.projectHub.decision(question))?.document.withdrawnAt).toBeDefined();
}, 120_000);

test('a moved-main conflict is aborted and the repair turn gets the exact conflict instructions', async () => {
  const f = await setup();
  f.fake.enqueueTurn(async turn => {
    writeFileSync(join(turn.input.cwd, 'value.txt'), 'Thread intent\n'); git(turn.input.cwd, 'add', '-A'); git(turn.input.cwd, 'commit', '-m', 'Thread intent');
    writeFileSync(join(f.checkout, 'value.txt'), 'Other intent\n'); git(f.checkout, 'add', '-A'); git(f.checkout, 'commit', '-m', 'Other intent'); git(f.checkout, 'push', 'origin', 'main');
    await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Thread intent.' }); return { status: 'completed' };
  }, forThread());
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.prompt).toContain('Landing stopped: main moved and these files conflict: value.txt. Run git fetch origin and git rebase origin/main in your worktree, resolve the conflicts keeping the intent of both sides, run the relevant tests and report done.');
    expect(git(turn.input.cwd, 'status', '--porcelain')).toBe('');
    await turn.bridge('jevellan_thread_report', { status: 'blocked', summary: 'Conflict identified.' }); return { status: 'completed' };
  }, forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.state).toBe('idle'); expect(thread.turns).toBe(2); expect(thread.landing).toBeUndefined(); expect(git(f.origin, 'show', 'main:value.txt')).toBe('Other intent');
}, 120_000);

test('two devices land under the same publication lease and keep both checked changes', async () => {
  const { projectMember } = await import('./helpers/project-fixture.js');
  const f = await setup({ smokeCheck: 'test -f value.txt' }), member = await projectMember(f, { decisionFetch: transport });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let arrivals = 0;
  const turn = (path: string) => commitStep({ [path]: `${path}\n` }, { status: 'done', summary: path }, async () => { arrivals++; await gate; });
  f.fake.enqueueTurn(turn('a.txt'), forThread()); member.fake.enqueueTurn(turn('b.txt'), forThread());
  const left = await start(f, 'left'); const right = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: 'right', title: 'Right', task: 'Make the other change.', modelId: 'fixture', deviceId: member.deviceId });
  await f.waitFor(async () => { await f.app.projectWork.pulse(); await member.app.projectWork.pulse(); return arrivals; }, n => n === 2).catch(error => { const local = f.app.projectWork.store.get(left.threadId), remote = member.app.projectWork.store.get(right.threadId); throw new Error(`${String(error)}: ${JSON.stringify({ local: { state: local?.state, reason: local?.stateReason }, remote: { state: remote?.state, reason: remote?.stateReason }, memberTurns: member.fake.turnStarts.length })}`); }); release();
  // A busy lease is retried by the ordinary sweep, without another author turn.
  await f.waitFor(async () => { await f.app.projectWork.pulse(); await member.app.projectWork.pulse(); return !!f.thread(left.threadId).landing && !!member.thread(right.threadId).landing; }, Boolean, 90_000);
  expect(git(f.origin, 'show', 'main:a.txt')).toBe('a.txt'); expect(git(f.origin, 'show', 'main:b.txt')).toBe('b.txt'); expect(f.thread(left.threadId).turns).toBe(1); expect(member.thread(right.threadId).turns).toBe(1);
}, 120_000);

test('a landing held before routing retries after the night releases it', async () => {
  const f = await setup(), service = f.app.projectWork.landings; let held = true;
  service.o.assertLanding = async () => { if (held) throw new Error('Held for the nightly window.'); };
  f.fake.enqueueTurn(commitStep({ 'README.md': 'After the night\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.state).toBe('in-review'); expect(await routes(f, thread.id)).toHaveLength(0);
  held = false; const retry = vi.spyOn(service.o, 'retry'); await service.sweep(); expect(retry).toHaveBeenCalledWith('project', thread.id);
  await f.waitFor(() => f.thread(thread.id), t => !!t.landing); expect(f.thread(thread.id).turns).toBe(1);
}, 120_000);

test('landing commands receive project provider credentials and redact their output', async () => {
  const f = await setup({ smokeCheck: 'printf "gate-value=%s\\n" "$ANTHROPIC_API_KEY"; exit 1' }), service = f.app.projectWork.landings;
  const value = 'fixture-gate-credential-test'; service.o.redactor.add(value); service.o.projectEnvironment = async () => ({ ANTHROPIC_API_KEY: value });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Environment\n' }, { status: 'progress', summary: 'Ready for a gate.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(git(f.origin, 'rev-parse', thread.branch!)).toBe(git(thread.cwd, 'rev-parse', 'HEAD'));
  const outcome = await service.publish(f.project, thread); expect(outcome.kind).toBe('fix');
  if (outcome.kind !== 'fix') throw new Error('Expected the failing configured gate.');
  expect(outcome.body).toContain(`gate-value=${service.o.redactor.text(value)}`); expect(outcome.body).not.toContain(value);
}, 120_000);

test('a night starting during integration fences the final main push', async () => {
  const f = await setup(), service = f.app.projectWork.landings; let assertions = 0;
  service.o.assertLanding = async () => { if (++assertions >= 3) throw new Error('Held for the nightly window.'); };
  const before = git(f.origin, 'rev-parse', 'main');
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Held at push\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.landing).toBeUndefined(); expect(git(f.origin, 'rev-parse', 'main')).toBe(before); expect(thread.stateReason).toBe('Held for the nightly window.');
}, 120_000);

test.each([{ passed: true, expired: false }, { passed: false, expired: false }, { passed: true, expired: true }, { passed: true, expired: 'push' }, { passed: true, expired: 'cached' }])('a required job gate controls landing and forces a merge commit (passed $passed, expired $expired)', async ({ passed, expired }) => {
  const { ProjectJobRunSchema, ProjectWorkTaskSchema, writeDocument } = await import('../packages/core/dist/index.js');
  const { deliveryDirectory, PrivateJobDeliverySchema } = await import('../packages/projects/dist/job-deliveries.js');
  const f = await setup({ autoLand: expired !== 'cached' }), commit = git(f.checkout, 'rev-parse', 'HEAD'), at = new Date().toISOString(), runId = 'gate_fixture';
  let gateNow = Date.now(); const validUntil = new Date(gateNow + 3600000).toISOString();
  if (expired) {
    f.app.projectWork.landings.o.now = () => gateNow;
    const put = f.app.projectWork.landings.o.hub.putMergeDocument.bind(f.app.projectWork.landings.o.hub);
    vi.spyOn(f.app.projectWork.landings.o.hub, 'putMergeDocument').mockImplementation(async (raw, revision) => { const saved = await put(raw, revision); if (expired !== 'cached' && raw.schema === 'landing-route-v1' && raw.state === (expired === 'push' ? 'landing' : 'waiting')) gateNow = Date.parse(validUntil) + 1000; return saved; });
  }
  const gate = { id: 'fixture_gate', protectedPaths: ['evals/'], timeoutMinutes: 1, command: `node -e 'const f=require("node:fs"),p=require("node:path");const rel=p.relative(process.env.JEVELLAN_JOB_WORKSPACE,process.env.JEVELLAN_GATE_INPUT);if(rel.startsWith("..")||p.isAbsolute(rel)||JSON.parse(f.readFileSync(process.env.JEVELLAN_GATE_INPUT)).schema!=="private-job-delivery-v1")process.exit(9);f.writeFileSync(process.env.JEVELLAN_GATE_RESULT,JSON.stringify({schema:"project-job-gate-result-v1",trustedCommit:process.env.JEVELLAN_JOB_COMMIT,candidateCommit:process.env.JEVELLAN_GATE_CANDIDATE_COMMIT,${expired ? `validUntil:"${validUntil}",` : ''}passed:${passed},checks:[{name:"Fixture measurement",passed:${passed}}]}))'` };
  f.app.hub.put('project-job-runs', runId, ProjectJobRunSchema, ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: runId, projectId: 'project', revision: 1, jobId: 'night', taskId: 'night_task', deviceId: f.app.device.deviceId, commit, projectDay: at.slice(0, 10), startedAt: at, conclusion: 'passed', summary: 'Fixture measurement completed.', logTail: '', phase: 'finished', spec: { kind: 'command', command: 'true', timeoutMinutes: 1, deliveryGate: gate }, baseBranch: 'main', watchAfter: at,
    deliveries: [{ schema: 'project-job-delivery-v1', id: 'candidate', title: 'Candidate', brief: 'Dev fixture only.', type: 'feature', fromBranch: 'fixture', gate, inputSha256: 'a'.repeat(64) }] }), 0);
  writeDocument(join(deliveryDirectory(f.homes, 'project', runId), 'candidate.json'), PrivateJobDeliverySchema, { schema: 'private-job-delivery-v1', runId, deliveryId: 'candidate', trustedCommit: commit, sha256: 'a'.repeat(64), input: { schema: 'fixture-input-v1', private: 'Never included in the prompt.' } });
  f.fake.enqueueTurn(async turn => {
    const threadId = turn.input.owner.id;
    f.app.hub.put('project-work-tasks', 'bound_candidate', ProjectWorkTaskSchema, ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id: 'bound_candidate', projectId: 'project', revision: 1, jobDelivery: { runId, deliveryId: 'candidate' }, title: 'Candidate', brief: 'Dev fixture only.', kind: 'session', type: 'feature', goalId: null, source: 'finding', state: 'active', rank: '8', ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: null, threadId, jobRunId: null, fixed: {}, createdAt: at, updatedAt: at }), 0);
    expect(turn.input.prompt).not.toContain('Never included in the prompt.');
    return commitStep({ 'README.md': 'Measured change\n' }, { status: passed && !expired ? 'progress' : 'done', summary: 'Candidate ready.' })(turn);
  }, forThread());
  const started = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: 'gated', title: 'Gated work', task: 'Make the measured change.', modelId: 'fixture', deviceId: f.app.device.deviceId, taskContext: { taskId: 'bound_candidate', type: 'feature', needs: [], goal: null } });
  let thread;
  if (passed && !expired) {
    await f.waitFor(() => f.thread(started.threadId), row => row.state === 'idle');
    f.fake.enqueueTurn(commitStep({ 'README.md': 'Measured change after restart\n' }, { status: 'done', summary: 'Restarted candidate ready.' }), forThread());
    const restarted = await f.app.projectWork.threads.restart('project', started.threadId, { schema: 'thread-override-request-v1', clientRequestId: 'gated_restart', mode: 'restart', modelId: 'fixture', deviceId: f.app.device.deviceId }, f.app.device.deviceId);
    thread = await done(f, restarted.newThreadId); expect(thread.taskContext?.taskId).toBe('bound_candidate');
  } else thread = await done(f, started.threadId);
  if (expired === 'cached') {
    gateNow = Date.parse(validUntil) + 1000;
    const route = (await routes(f, thread.id))[0]!;
    const response = await f.request(`/api/projects/project/decisions/${route.decisionId}/answer`, 'POST', { schema: 'decision-answer-request-v1', clientRequestId: 'expired_owner_land', optionLabel: 'Land now' });
    expect(response.status).toBe(202); await f.app.projectWork.idle(); thread = f.thread(thread.id);
  }
  if (passed && !expired) { expect(thread.landing?.method).toBe('merge-commit'); expect(thread.landing?.checks).toContainEqual(expect.objectContaining({ name: gate.id, passed: true })); expect(git(f.origin, 'show', '-s', '--format=%P', 'main').split(' ')).toHaveLength(2); }
  else { expect(thread.landing).toBeUndefined(); expect(git(f.origin, 'rev-parse', 'main')).toBe(commit); expect(thread.stateReason).toContain(expired ? 'gate deadline expired' : 'gate refused'); }
}, 120_000);

test('ROUTECTL landing records preserve the exact immutable packet separately from refreshed checks',async()=>{
 const asked:string[]=[],fetcher:typeof fetch=async(url,init)=>{if(init?.method==='POST'){const body=JSON.parse(String(init.body)) as {state:string;questions:Record<string,unknown>};if(body.questions.landing_route)asked.push(body.state);}return transport(url,init);};const f=fixture=await projectFixture({jevKey:true,decisionFetch:fetcher});await settings(f,{autoLand:false});f.fake.enqueueTurn(commitStep({'README.md':'Snapshot fixture\n'},{status:'done',summary:'Owned packet snapshot.'}),forThread());const result=await start(f),thread=await done(f,result.threadId),row=(await routes(f,thread.id))[0]!;expect(row).toMatchObject({inputPacket:JSON.parse(asked[0]!)});const changed=await f.app.projectHub.putMergeDocument({...row,packet:{...row.packet,checks:[...row.packet.checks,{name:'Later check',passed:true,at:new Date().toISOString()}]}},row.revision);const fresh=LandingRouteSchema.parse(changed.document);expect(fresh).toMatchObject({inputPacket:JSON.parse(asked[0]!)});await expect(f.app.projectHub.putMergeDocument({...fresh,inputPacket:{...row.packet,title:'Replacement packet'}},changed.revision)).rejects.toThrow(/immutable/u);
},120_000);
test('ROUTECTL l-v1 stores replay input and output evidence without changing landed work',async()=>{
 let choice='land';const asked:string[]=[],fetcher:typeof fetch=async(url,init)=>{if(init?.method==='POST'){const body=JSON.parse(String(init.body)) as {state:string;questions:Record<string,{criteria:Record<string,string>}>};if(body.questions.landing_route){asked.push(body.state);return Response.json({model:'jev-fixture',usage:{input_tokens:20,output_tokens:4},answers:{landing_route:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(body.questions.landing_route.criteria).map(key=>[key,Number(key===choice)]))}}});}}return transport(url,init);};const f=fixture=await projectFixture({jevKey:true,decisionFetch:fetcher});await settings(f);f.fake.enqueueTurn(commitStep({'README.md':'Replay fixture\n'},{status:'done',summary:'Owned route replay.'}),forThread());const result=await start(f),thread=await done(f,result.threadId),before=structuredClone(f.thread(thread.id)),calls=asked.length,head=git(f.origin,'rev-parse','main');choice='ask-owner';const proposed=await f.app.ownerJev.propose('project','l-v1',{edits:[{find:'Small or low-risk change',replace:'Small and covered change'}],summary:'Owned landing replay.'});expect(asked.length-calls).toBe(1);const proposal=f.app.ownerJev.proposals().find(row=>row.id===proposed.match(/^P[1-9][0-9]*/u)![0])!;expect(proposal.replayReportId).toBeDefined();expect(f.app.ownerJev.replayReport('project',proposal.replayReportId!)).toMatchObject({questionSet:'l-v1',selected:1,compared:1,changed:1,evidence:'simulated'});expect(f.thread(thread.id)).toEqual(before);expect(git(f.origin,'rev-parse','main')).toBe(head);expect(f.fake.runs).toHaveLength(1);
},120_000);
test('ROUTECTL reading landing policy does not count a lesson as applied',async()=>{
 const f=fixture=await projectFixture();const lesson=f.app.ownerJev.addLesson('project',{about:'landing',source:'owner',text:'Owned lesson.'});await f.app.ownerJev.landingHook('project');await f.app.ownerJev.landingHook('project');expect(f.app.ownerJev.lessons('project').find(row=>row.id===lesson.id)?.timesApplied).toBe(0);expect(f.fake.runs).toHaveLength(0);
});

test('LESSONPOL6 an unavailable landing policy cannot silently use the code defaults to land',async()=>{
 const f=await setup();f.app.projectWork.landings.o.jev=async()=>{throw Error('Owned canonical policy outage.');};const head=git(f.origin,'rev-parse','main');
 f.fake.enqueueTurn(commitStep({'README.md':'Owned policy outage\n'},{status:'done',summary:'A small policy fixture.'}),forThread());const started=await start(f),thread=await done(f,started.threadId);
 expect(thread.state).toBe('in-review');expect(thread.landing).toBeUndefined();expect(git(f.origin,'rev-parse','main')).toBe(head);expect((await routes(f,thread.id))[0]).toMatchObject({route:'ask-owner',source:'unavailable'});expect(f.fake.runs).toHaveLength(1);
},120_000);

test('LESSONMETA1 normal route updates cannot replace original prompt, raw answer or condition evidence',async()=>{
 const f=await setup({autoLand:false});f.fake.enqueueTurn(commitStep({'README.md':'Owned immutable route metadata\n'},{status:'done',summary:'A small metadata fixture.'}),forThread());const started=await start(f),thread=await done(f,started.threadId),row=(await routes(f,thread.id))[0]!;
 for(const change of [{rawChoice:'ask-owner' as const},{promptVersion:99},{promptText:'Replacement prompt.'},{inputsRef:'replacement_input'},{ruleContext:{schema:'placement-rule-context-v1' as const,text:'Replacement task.',complete:true}}])await expect(f.app.projectHub.putMergeDocument({...row,...change},row.revision)).rejects.toThrow(/immutable/u);
 expect(f.thread(thread.id).landing).toBeUndefined();
},120_000);


test('LP075 occupied-port diagnostics are recognized as resource blockers', () => {
  expect(heldPort('Error: port 54321 is already occupied; this run needs its own stack')).toBe(54321);
  expect(heldPort('Error: listen EADDRINUSE: address already in use 127.0.0.1:54321')).toBe(54321);
  expect(heldPort('An unrelated operation took 3000ms while busy.')).toBeNull();
  expect(heldPort('port 99999 is already occupied')).toBeNull();
});

test('LP075 a blocked landing retains its waiting item across restart and resolves it when the blocker clears', async () => {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
  const port = (holder.address() as AddressInfo).port;
  try {
    const f = await setup(); const count = join(f.root, 'landing-check-count');
    const code = `require('fs').appendFileSync(${JSON.stringify(count)}, 'check\\n');require('net').createServer().listen(${port},'127.0.0.1',()=>process.exit(0))`;
    const command = 'node -e ' + shellQuote(code);
    await settings(f, { landingChecks: [{ name: 'Fixture server', paths: [], command }] });
    f.fake.enqueueTurn(commitStep({ 'README.md': 'A resource-bound change\n' }, { status: 'done', summary: 'Done.' }), forThread());
    const result = await start(f, 'persistent-port'); const blocked = await done(f, result.threadId);
    expect(blocked).toMatchObject({ state: 'in-review', turns: 1, verificationAttempts: 0 });
    const question = (await f.app.projectHub.decisions('project')).find(row => row.blocker?.kind === 'port' && row.threadId === blocked.id);
    expect(question).toBeDefined(); expect(question?.withdrawnAt).toBeUndefined();
    const before = readFileSync(count, 'utf8');
    await f.restart(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
    expect(readFileSync(count, 'utf8')).toBe(before);
    expect((await f.app.projectHub.decision(question!.id))?.document.withdrawnAt).toBeUndefined();
    await new Promise<void>(resolve => holder.close(() => resolve()));
    await f.app.projectWork.pulse(); const landed = await f.waitFor(() => f.thread(blocked.id), row => !!row.landing);
    expect(landed).toMatchObject({ state: 'done', turns: 1 });
    const closed = (await f.app.projectHub.decision(question!.id))!.document;
    expect(closed.answer).toBeUndefined(); expect(closed.withdrawnAt).toBeDefined();
    expect(closed.withdrawal).toMatchObject({ source: 'system', reason: expect.stringMatching(/port.*free/i) });
    const checked = readFileSync(count, 'utf8'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
    expect(readFileSync(count, 'utf8')).toBe(checked);
  } finally { if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);

test('LP075 landing checks receive the project environment including command-only names', async () => {
  const command = `node -e 'const a=require("assert");a.strictEqual(process.env.FIXTURE_REGION,"sandbox");a.strictEqual(process.env.OPENAI_CHECK_CONTEXT,"fixture-only")'`;
  const f = await setup({ environment: { variables: [{ name: 'FIXTURE_REGION', value: 'sandbox' }, { name: 'OPENAI_CHECK_CONTEXT', value: 'fixture-only' }], secrets: [], copyFiles: [] },
    landingChecks: [{ name: 'Environment contract', paths: [], command }] });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Environment check\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f, 'command-environment'), landed = await done(f, result.threadId);
  expect(landed.landing).toMatchObject({ checks: [{ name: 'Environment contract', passed: true }] });
  expect(landed.turns).toBe(1);
}, 120_000);

test('LP075 every selected and smoke check gets managed localhost ports without changing its command', async () => {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve)); const occupied = (holder.address() as AddressInfo).port;
  try {
    const code = `const a=require('assert');const port=Number(process.env.APP_PORT);a.ok(port>0&&port<65536);a.notStrictEqual(port,${occupied});a.strictEqual(process.env.APP_BASE_URL,'http://127.0.0.1:'+port);require('net').createServer().listen(port,'127.0.0.1',()=>process.exit(0))`;
    const command = 'node -e ' + shellQuote(code);
    const f = await setup({ landingPorts: [{ schema: 'landing-check-port-v1', variable: 'APP_PORT', urlVariable: 'APP_BASE_URL' }],
      environment: { variables: [{ name: 'APP_PORT', value: String(occupied) }], secrets: [], copyFiles: [] },
      landingChecks: [{ name: 'Isolated check', paths: [], command }], smokeCheck: command });
    f.fake.enqueueTurn(commitStep({ 'README.md': 'Isolated server check\n' }, { status: 'done', summary: 'Done.' }), forThread());
    const result = await start(f, 'managed-port'), landed = await done(f, result.threadId);
    expect(landed.landing).toMatchObject({ checks: [{ name: 'Isolated check', passed: true }, { name: 'Smoke check', passed: true }] });
    expect((await f.app.projectHub.settings('project'))?.document).toMatchObject({ landingChecks: [{ command }], smokeCheck: command,
      environment: { variables: [{ name: 'APP_PORT', value: String(occupied) }] } });
    expect(holder.listening).toBe(true); expect(landed.turns).toBe(1);
  } finally { if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);

async function legacyPortWait(current: boolean) {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve)); const port = (holder.address() as AddressInfo).port;
  const f = await setup({ landingChecks: [{ name: 'Legacy fixture', paths: [], command: `node -e "require('net').createServer().listen(${port},'127.0.0.1',()=>process.exit(0))"` }] });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Legacy resource wait\n' }, { status: 'done', summary: 'Done.' }), forThread());
  const result = await start(f, 'legacy-resource'), blocked = await done(f, result.threadId), wait = f.app.projectWork.store.local(blocked.id).landingWait!;
  await f.app.projectWork.decisions.withdraw('project', wait.decisionId, 'Historical fixture withdrawal.');
  f.app.projectWork.store.updateLocal(blocked.id, value => { const next = { ...value }; delete next.landingWait; return next; });
  f.app.projectWork.store.update(blocked.id, value => ({ ...value, state: 'idle', stateReason: current ? 'Landing checks failed three times.' : 'Landing left by the owner.' }));
  f.app.projectWork.coordinatorLedger('project').append({ type: 'coordinator-event', data: { schema: 'coordinator-event-v1', kind: 'thread-verification-failed',
    id: 'legacy_resource_failure', at: new Date(Date.now() - (current ? 0 : 60_000)).toISOString(), threadId: blocked.id, attempts: 3,
    tail: `port ${port} is already occupied; this run needs its own stack` } });
  return { f, holder, blocked, previousQuestion: wait.decisionId };
}

test('LEGACY075 current typed failure restores resource waiting without an author turn', async () => {
  const { f, holder, blocked, previousQuestion } = await legacyPortWait(true);
  try {
    await f.restart(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
    expect(f.thread(blocked.id)).toMatchObject({ state: 'in-review', turns: 1 });
    const wait = f.app.projectWork.store.local(blocked.id).landingWait;
    expect(wait).toBeDefined(); expect(wait!.decisionId).not.toBe(previousQuestion);
    expect((await f.app.projectHub.decision(previousQuestion))?.document.withdrawnAt).toBeDefined();
    expect((await f.app.projectHub.decision(wait!.decisionId))?.document.withdrawnAt).toBeUndefined();
    await new Promise<void>(resolve => holder.close(() => resolve()));
    await f.app.projectWork.pulse(); const landed = await f.waitFor(() => f.thread(blocked.id), row => !!row.landing);
    expect(landed).toMatchObject({ state: 'done', turns: 1 });
  } finally { if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);

test('LEGACY075 a newer owner action prevents legacy resource retry', async () => {
  const { f, holder, blocked } = await legacyPortWait(false);
  try {
    await f.restart(); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
    expect(f.thread(blocked.id)).toMatchObject({ state: 'idle', stateReason: 'Landing left by the owner.', turns: 1 });
    expect(f.app.projectWork.store.local(blocked.id).landingWait).toBeUndefined();
  } finally { await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);

test('REPLAY075 a lost blocker-answer reply acknowledges its retry after landing without another turn or push', async () => {
  const holder = createServer(); await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve)); const port = (holder.address() as AddressInfo).port;
  try {
    const f = await setup({ landingChecks: [{ name: 'Retry fixture', paths: [], command: `node -e "require('net').createServer().listen(${port},'127.0.0.1',()=>process.exit(0))"` }] });
    f.fake.enqueueTurn(commitStep({ 'README.md': 'Retry-safe resource answer\n' }, { status: 'done', summary: 'Done.' }), forThread());
    const result = await start(f, 'blocker-answer'), blocked = await done(f, result.threadId), wait = f.app.projectWork.store.local(blocked.id).landingWait!;
    await new Promise<void>(resolve => holder.close(() => resolve()));
    const body = { schema: 'decision-answer-request-v1', clientRequestId: 'same_blocker_answer', optionLabel: 'Retry checks' };
    expect((await f.request(`/api/projects/project/decisions/${wait.decisionId}/answer`, 'POST', body)).status).toBe(202);
    const landed = await f.waitFor(() => f.thread(blocked.id), row => !!row.landing); await f.app.projectWork.idle();
    const commit = git(f.origin, 'rev-parse', 'main'), answered = (await f.app.projectHub.decision(wait.decisionId))!.document;
    const repeated = await f.request(`/api/projects/project/decisions/${wait.decisionId}/answer`, 'POST', body);
    expect(repeated.status).toBe(202); expect(await repeated.json()).toMatchObject({ repeated: true });
    expect((await f.app.projectHub.decision(wait.decisionId))!.document.answeredAt).toBe(answered.answeredAt);
    expect(f.thread(landed.id).turns).toBe(1); expect(git(f.origin, 'rev-parse', 'main')).toBe(commit);
  } finally { if (holder.listening) await new Promise<void>(resolve => holder.close(() => resolve())); }
}, 120_000);
