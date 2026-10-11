import { afterEach, expect, test } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ProjectJobRunSchema, ProjectJobSchema, TaskReceiptSchema, ThreadCreatedViewSchema, groupAlive, processIdentity, type CoordinatorEvent } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { ProjectDailyWork } from '../packages/projects/dist/index.js';
import { derivedId } from '../packages/projects/dist/decision-items.js';
import { commitStep, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const jobInput = (id: string, command = 'true', gate: string | null = null) => ({ schema: 'job-create-request-v1', clientRequestId: id.replaceAll(" ", "_"), name: id, goalId: null, enabled: true, run: { kind: 'command', command, timeoutMinutes: 1 }, gate: gate ? { jobId: gate } : null });
const runInput = (id: string) => ({ schema: 'project-run-request-v1', clientRequestId: id });
const checkoutState = (f: ProjectFixture) => ({ head: f.git(f.checkout, 'rev-parse', 'HEAD'), branch: f.git(f.checkout, 'symbolic-ref', 'HEAD'), status: f.git(f.checkout, 'status', '--porcelain=v1'), tracking: f.git(f.checkout, 'rev-parse', 'origin/main'), index: createHash('sha256').update(f.git(f.checkout, 'ls-files', '--stage', '-z')).digest('hex') });
async function job(f: ProjectFixture, id: string, command = 'true', gate: string | null = null) { return f.json('/api/projects/project/jobs', ProjectJobSchema, 'POST', jobInput(id, command, gate)); }

test('commands use fresh worktrees, setup and redacted receipts without touching a dirty registered checkout', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, setupCommand: 'printf setup > prepared' }, 0);
  const before = f.git(f.checkout, 'rev-parse', 'HEAD'); writeFileSync(join(f.checkout, 'value.txt'), 'owner edit\n');
  const snapshot = checkoutState(f);
  const secret = 'disposable output secret'; f.app.redactor.add(secret);
  const definition = await job(f, 'Checks', `test -f prepared && test "$(cat value.txt)" = 1 && printf '${secret}'`);
  const receipt = await f.json(`/api/projects/project/jobs/${definition.id}/run`, TaskReceiptSchema, 'POST', runInput('first'));
  await f.waitFor(() => work.tasks.read('project', receipt.taskId), task => task.state === 'done');
  await work.idle();
  const run = (await work.jobs.runs('project'))[0]!;
  expect(run).toMatchObject({ conclusion: 'passed', commit: before, taskId: receipt.taskId }); expect(run.logTail).not.toContain(secret);
  expect(f.git(f.checkout, 'diff')).toContain('owner edit'); expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(before);
  expect(checkoutState(f)).toEqual(snapshot);
  expect(existsSync(join(f.homes.root, 'worktrees', 'project', 'jobs', run.id))).toBe(false);
  expect(f.git(f.checkout, 'for-each-ref', '--format=%(refname)', 'refs/jevellan/threads')).toBe('');
  expect((await f.json(`/api/projects/project/jobs/${definition.id}/run`, TaskReceiptSchema, 'POST', runInput('first'))).taskId).toBe(receipt.taskId);
});

test('gates select the passing commit of the project day even after base advances and missing passes skip', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const full = await job(f, 'Full suite'), deploy = await job(f, 'Deploy', 'test "$(cat value.txt)" = 1', full.id), missing = await job(f, 'Never passed'), skip = await job(f, 'Skipped deployment', 'exit 44', missing.id);
  const first = await work.daily.runJob('project', full.id, runInput('full')); await f.waitFor(() => work.tasks.read('project', first.taskId), task => task.state === 'done');
  const passing = (await work.jobs.runs('project')).find(row => row.jobId === full.id)!;
  writeFileSync(join(f.checkout, 'value.txt'), '2\n'); f.git(f.checkout, 'commit', '-am', 'Advance base'); f.git(f.checkout, 'push', 'origin', 'main');
  const gated = await work.daily.runJob('project', deploy.id, runInput('deploy')); await f.waitFor(() => work.tasks.read('project', gated.taskId), task => task.state === 'done');
  expect((await work.jobs.runs('project')).find(row => row.jobId === deploy.id)).toMatchObject({ conclusion: 'passed', commit: passing.commit, gateRunId: passing.id });
  const skipped = await work.daily.runJob('project', skip.id, runInput('skip')); await f.waitFor(() => work.tasks.read('project', skipped.taskId), task => task.state === 'failed');
  expect((await work.jobs.runs('project')).find(row => row.jobId === skip.id)).toMatchObject({ conclusion: 'skipped', summary: 'Skipped: Never passed has not passed today.' });
  const { clientRequestId: _request, ...fields } = jobInput('ignored'); void _request;
  await expect(work.daily.updateJob('project', full.id, { ...fields, schema: 'job-update-request-v1', expectedRevision: full.revision, gate: { jobId: deploy.id } })).rejects.toThrow('cycle');
});

test('a persisted executing receipt is failed after restart without repeating command effects', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork; const definition = await job(f, 'Restart check', 'printf repeated > repeated.txt');
  const original = work.daily.o.changed; work.daily.o.changed = () => {};
  const receipt = await work.daily.runJob('project', definition.id, runInput('restart')); work.daily.o.changed = original;
  const task = await work.tasks.read('project', receipt.taskId), runId = derivedId('jrun', task.id), at = work.tasks.at();
  await work.tasks.save({ ...task, state: 'active', jobRunId: runId });
  await f.app.projectHub.putJobRun(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: runId, projectId: 'project', revision: 0, jobId: definition.id, taskId: task.id, commit: f.git(f.checkout, 'rev-parse', 'HEAD'), deviceId: f.app.device.deviceId,
    projectDay: await work.daily.day('project'), startedAt: at, watchAfter: at, conclusion: null, summary: '', logTail: '', spec: definition.run, baseBranch: 'main', phase: 'executing' }), 0);
  await f.restart(); await f.waitFor(() => f.app.projectWork.tasks.read('project', task.id), row => row.state === 'failed');
  expect((await f.app.projectWork.jobs.runs('project'))[0]?.summary).toContain('not repeated'); expect(existsSync(join(f.checkout, 'repeated.txt'))).toBe(false);
});

test('nightly windows serialize closing-day tasks, recover missing plans and release holds at completion or six hours', async () => {
  let now = Date.parse('2026-10-25T01:59:00Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { enabled: true, time: '02:00', timezone: 'Europe/Lisbon' } }, 0);
  const events: CoordinatorEvent[] = [];
  const make = () => new ProjectDailyWork({ hub: f.app.projectHub, tasks: f.app.projectWork.tasks, runner: f.app.projectWork.jobs, redactor: f.app.redactor, deviceId: f.app.device.deviceId, now: () => now,
    settings: id => f.app.projectWork.admission.settings(id), validateGoal: async () => {}, event: async (_id, event) => { if (!events.some(row => row.id === event.id)) events.push(event); }, changed: () => {} });
  let daily = make();
  const create = (id: string, order: number) => daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: id.replaceAll(" ", "_"), name: id, goalId: null, order, enabled: true, target: { kind: 'session', title: id, brief: 'Review yesterday and conclude without edits.', type: 'review' } });
  const first = await create('First', 0), second = await create('Second', 1), already = await create('Already done', 2);
  const done = await daily.runDaily('project', already.id, runInput('earlier')); await f.app.projectWork.tasks.save({ ...await f.app.projectWork.tasks.read('project', done.taskId), state: 'done' });
  now += 60_000; await daily.sweep('project');
  const window = (await daily.window('project'))!; expect(window).toMatchObject({ closingProjectDay: '2026-10-24', mergesHeld: true }); expect(window.plans.map(plan => plan.dailyId)).toEqual([first.id, second.id]);
  expect(window.plans.every(plan => plan.projectDay === '2026-10-24')).toBe(true); await expect(daily.assertMerge('project')).rejects.toThrow('Merges are held');
  let tasks = await f.app.projectWork.tasks.list('project'); expect(await daily.eligible(window.plans[0]!, tasks)).toBe(true); expect(await daily.eligible(window.plans[1]!, tasks)).toBe(false);
  // Crash after the window receipt, before all plan documents were written.
  f.app.hub.delete('project-work-tasks', window.plans[1]!.id); f.app.hub.delete('project-work-task-history', `${window.plans[1]!.id}_0000000001`); daily = make(); await daily.sweep('project'); expect(await f.app.projectHub.task(window.plans[1]!.id)).not.toBeNull();
  await f.app.projectWork.tasks.save({ ...await f.app.projectWork.tasks.read('project', window.plans[0]!.id), state: 'done' }); tasks = await f.app.projectWork.tasks.list('project'); expect(await daily.eligible(window.plans[1]!, tasks)).toBe(true);
  await f.app.projectWork.tasks.save({ ...await f.app.projectWork.tasks.read('project', window.plans[1]!.id), state: 'done' }); await daily.sweep('project'); expect(await daily.mergesHeld('project')).toBe(false);
  expect((await daily.view('project')).window?.state).toBe('finished'); expect(events.filter(event => event.kind === 'window-opened')).toHaveLength(1);
  now += 24 * 3_600_000; await daily.sweep('project'); expect(await daily.mergesHeld('project')).toBe(true); now += 6 * 3_600_000; await daily.sweep('project'); expect(await daily.mergesHeld('project')).toBe(false);
  expect((await daily.view('project')).tasks.filter(task => task.projectDay === '2026-10-25').every(task => task.state === 'cancelled')).toBe(true);
  expect((await daily.view('project')).window?.outcome).toContain('cancelled');
  // Closing receipts repair notifications even after the six-hour limit.
  events.splice(0); daily = make(); await daily.sweep('project'); expect(events.filter(event => event.kind === 'window-finished')).toHaveLength(1);
});

test('both owner API and the shared merge backend refuse during the nightly window and allow after the deadline', async () => {
  let now = Date.parse('2026-10-11T00:58:00Z'); const f = fixture = await projectFixture({ projectTimers: { now: () => now } });
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'hello\n' }, { status: 'done', summary: 'Added greeting.', changedFiles: ['greeting.txt'] }), forThread());
  const created = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'merge_candidate', title: 'Add greeting', task: 'Create greeting.txt.' });
  await f.waitFor(() => f.thread(created.threadId).state, state => state === 'in-review'); await f.app.projectWork.idle();
  const settings = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { enabled: true, time: '02:00', timezone: 'Europe/Lisbon' } }, 0);
  await f.app.projectWork.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'merge_window', name: 'Review', goalId: null, order: 0, enabled: true, target: { kind: 'session', title: 'Review', brief: 'Review yesterday.', type: 'review' } });
  now += 2 * 60_000; await f.app.projectWork.daily.sweep('project');
  const denied = await f.request(`/api/projects/project/threads/${created.threadId}/pr/merge`, 'POST', { schema: 'empty-request-v1' });
  expect(denied.status).toBe(409); expect((await denied.json()).message).toBe('Merges are held while the nightly window runs.');
  await expect(f.app.projectWork.tracker.merge(created.threadId)).rejects.toThrow('Merges are held'); expect(f.github.requests.some(row => row.method === 'PUT' && row.path.endsWith('/merge'))).toBe(false);
  now += 6 * 3_600_000; expect((await f.app.projectWork.tracker.merge(created.threadId)).merged).toBe(true);
});

test('restart stops a recorded orphan before removing its job worktree, and never repeats the command', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork, definition = await job(f, 'Orphan', 'printf repeated > repeated.txt');
  const changed = work.daily.o.changed; work.daily.o.changed = () => {}; const receipt = await work.daily.runJob('project', definition.id, runInput('orphan')); work.daily.o.changed = changed;
  const task = await work.tasks.read('project', receipt.taskId), runId = derivedId('jrun', task.id), at = work.tasks.at(), commit = f.git(f.checkout, 'rev-parse', 'HEAD');
  await work.tasks.save({ ...task, state: 'active', jobRunId: runId });
  await f.app.projectHub.putJobRun(ProjectJobRunSchema.parse({ schema: 'project-job-run-v1', id: runId, projectId: 'project', revision: 0, jobId: definition.id, taskId: task.id, commit, deviceId: f.app.device.deviceId, projectDay: await work.daily.day('project'), startedAt: at, watchAfter: at, conclusion: null, summary: '', logTail: '', spec: definition.run, baseBranch: 'main', phase: 'executing' }), 0);
  const path = f.homes.at('worktrees', 'project', 'jobs', runId); f.homes.ensure('worktrees', 'project', 'jobs'); f.git(f.checkout, 'worktree', 'add', '--detach', path, commit);
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); child.unref();
  try {
    const native = processIdentity(child.pid!); writeFileSync(join(f.homes.ensure('project-work', 'project', 'job-processes'), `${runId}.json`), JSON.stringify({ ...native, schema: 'project-job-process-v1', turn: 1, startedAt: at }));
    await f.restart(); await f.waitFor(() => f.app.projectWork.tasks.read('project', task.id), row => row.state === 'failed'); await f.app.projectWork.idle(); await f.app.projectWork.pulse();
    expect(groupAlive(native.pgid)).toBe(false); expect(existsSync(path)).toBe(false); expect(existsSync(join(f.checkout, 'repeated.txt'))).toBe(false);
  } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ } }
});
