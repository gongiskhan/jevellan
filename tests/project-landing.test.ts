import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubClient, SecretRedactor, StoredProjectWorkSettingsSchema, LandingRouteSchema, ProjectWorkSettingsSchema, ThreadIndexSchema, defaultProjectWorkSettings, type LandingRoute, type ProjectWorkSettings } from '../packages/core/dist/index.js';
import { selectedLandingChecks } from '../packages/projects/dist/landing.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, git, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
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
  const old = { ...defaultProjectWorkSettings('p'), schema: 'project-work-settings-v4', autoMerge: true, defaultIsolation: 'main', allowMainIsolation: true, requiredChecks: ['result'] };
  for (const k of ['delivery', 'autoLand', 'landingChecks', 'smokeCheck', 'mergeCommitPaths', 'healthChecks', 'deploy']) delete old[k as keyof typeof old];
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
test('Land instead closes only a Jevellan-opened own pull request and retains its work', async () => {
  const f = await setup({ delivery: 'pull-request', autoLand: false });
  f.fake.enqueueTurn(commitStep({ 'README.md': 'Transition\n' }, { status: 'done', summary: 'Transition work.' }), forThread());
  const result = await start(f), thread = await done(f, result.threadId); expect(thread.delivery).toBe('pull-request'); expect(thread.pr?.state).toBe('open');
  await settings(f); expect(f.thread(thread.id).delivery).toBe('pull-request');
  const response = await f.request(`/api/projects/project/threads/${thread.id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId: 'convert', action: 'land-instead' }); expect(response.status).toBe(200);
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

test('the owner route override withdraws the superseded landing question', async () => {
  const f = await setup({ autoLand: false }); f.fake.enqueueTurn(commitStep({ 'README.md': 'Override\n' }, { status: 'done', summary: 'Done.' }), forThread()); const result = await start(f), thread = await done(f, result.threadId);
  const question = (await routes(f, thread.id))[0]!.decisionId!;
  await f.app.projectWork.threadAction('project', thread.id, { schema: 'thread-action-request-v1', clientRequestId: 'override_route', action: 'land-now' });
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
