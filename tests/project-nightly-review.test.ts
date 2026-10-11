import { afterEach, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountSchema, ProjectWorkSettingsSchema, type ModelOption } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { ReviewTools } from '../packages/projects/dist/index.js';
import { SecretRedactor } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const author: ModelOption = { id: 'author', runtime: 'fake', model: 'author-model', label: 'Author', description: 'Fixture.', enabled: true, efforts: ['medium', 'high'] };
const reviewer = { ...author, id: 'reviewer', runtime: 'fake2', model: 'review-model', label: 'Reviewer' };
async function setup() {
  let now = Date.parse('2026-10-11T00:59:00Z'); const first = new FakeRuntime(), second = new FakeRuntime(); first.capabilities.readOnlyEnforced = true; second.capabilities.readOnlyEnforced = true; Object.defineProperty(second, 'id', { value: 'fake2' });
  const f = fixture = await projectFixture({ menu: [author, reviewer], runtimes: { fake: first, fake2: second }, projectTimers: { now: () => now } });
  f.app.hub.put('accounts', 'review_account', AccountSchema, { schema: 'account-v1', id: 'review_account', runtime: 'fake2', label: 'Review account', kind: 'subscription', enabled: true, ceilingPct: 90, credential: 'per-device' }, 0); await f.app.accounts.check('review_account');
  await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  const old = await f.app.projectWork.admission.settings('project'); await f.app.projectHub.putSettings(ProjectWorkSettingsSchema.parse({ ...old, coordinator: { ...old.coordinator, runtimeId: 'fake' }, nightlyWindow: { enabled: true, time: '02:00', timezone: 'Europe/Lisbon' }, refill: { enabled: false, minIntervalMinutes: 30 } }), 0);
  const goal = await f.app.projectWork.goals.create('project', { schema: 'goal-create-request-v1', clientRequestId: 'review_goal', name: 'Hardening through code review', motivation: 'Keep the structure clear.', health: 'Findings are resolved.' });
  const daily = await f.app.projectWork.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'review_daily', name: 'Review since last', goalId: goal.goal.id, order: 0, enabled: true, target: { kind: 'review-since-last' } });
  return { f, second, daily, clock: (minutes: number) => { now += minutes * 60_000; } };
}
const body = { summary: 'One finding covers the changed path.', findings: [{ what: 'Empty names need a fallback.', detail: 'Add a default for empty input.', files: ['greeting.txt'] }] };
test('the review scope durably accepts exactly one report with identical retry and refuses coding tools', async () => {
  const saved: unknown[] = [], tools = new ReviewTools(async report => { saved.push(report); }, new SecretRedactor());
  await tools.call('jevellan_project_review_report', body); await tools.call('jevellan_project_review_report', body); expect(saved).toHaveLength(1);
  await expect(tools.call('jevellan_project_review_report', { summary: 'Another report.', findings: [] })).rejects.toMatchObject({ status: 409 });
  await expect(tools.call('jevellan_task_create', {})).rejects.toMatchObject({ status: 403 }); await tools.close(); expect(() => tools.list()).toThrow('expired');
});
test('read-only high-effort review includes direct pushes, advances its durable watermark and chooses at most one fix', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork, checkout = f.git(f.checkout, 'status', '--porcelain=v1');
  second.enqueueTurn(async turn => {
    expect(turn.input.permissions).toBe('read-only'); expect(turn.input.effort).toBe('high'); expect(turn.input.owner.kind).toBe('review');
    const input = turn.input.prompt.match(/Read every commit and patch in (.*), then inspect/)!; const diff = readFileSync(input[1]!, 'utf8'); expect(diff).toContain('    Seed\n');
    await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' };
  }, input => input.owner.kind === 'review');
  const run = await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'first' }); await f.waitFor(() => work.tasks.read('project', run.taskId), task => task.state === 'done'); await work.idle();
  const first = (await work.daily.view('project')).lastReview!; expect(first).toMatchObject({ schema: 'project-review-report-v1', runtime: 'fake2', fromCommit: null, findings: body.findings }); expect((await work.daily.view('project')).lastReviewedCommit).toBe(first.commit);
  const chosen = await work.daily.followup('project', { reviewTaskId: run.taskId, task: { title: 'Fix all review findings', brief: 'Add the empty-name default.' } });
  expect(await work.daily.followup('project', { reviewTaskId: run.taskId, task: { title: 'Second fix', brief: 'Must not create another.' } })).toMatchObject({ repeated: true, taskId: chosen.taskId });
  expect((await work.tasks.list('project')).filter(task => task.nightlyFixFor === run.taskId)).toHaveLength(1);
  writeFileSync(join(f.checkout, 'direct.txt'), 'Direct push\n'); f.git(f.checkout, 'add', '-A'); f.git(f.checkout, 'commit', '-m', 'Direct owner push'); f.git(f.checkout, 'push', 'origin', 'main');
  second.enqueueTurn(async turn => { const input = turn.input.prompt.match(/Read every commit and patch in (.*), then inspect/)!; const diff = readFileSync(input[1]!, 'utf8'); expect(diff).toContain('Direct owner push'); expect(diff).not.toContain('    Seed\n'); await turn.bridge('jevellan_project_review_report', { summary: 'Direct push reviewed.', findings: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const next = await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'next' }); await f.waitFor(() => work.tasks.read('project', next.taskId), task => task.state === 'done');
  expect((await work.daily.view('project')).lastReview?.fromCommit).toBe(first.commit); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe(checkout);
}, 90_000);
test('the window allows only its single fix before 150 minutes, then runs jobs and releases at seven hours', async () => {
  const { f, second, daily, clock } = await setup(), work = f.app.projectWork;
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  clock(1); await work.pulse(); const window = (await work.daily.window('project'))!; const reviewTask = window.plans.find(task => task.dailyId === daily.id)!;
  await f.waitFor(() => work.tasks.read('project', reviewTask.id), task => task.state === 'done');
  const follow = await work.daily.followup('project', { reviewTaskId: reviewTask.id, task: { title: 'Combined fix', brief: 'Fix all findings.' } });
  // A synthetic linked thread identity exercises the shared merge guard; no merge is claimed.
  const fix = await work.tasks.read('project', follow.taskId!); await work.tasks.save({ ...fix, threadId: 'fix_thread', state: 'active' });
  await expect(work.daily.assertMerge('project', 'fix_thread')).resolves.toBeUndefined(); await expect(work.daily.assertMerge('project', 'other_thread')).rejects.toThrow('Merges are held');
  clock(150); await expect(work.daily.assertMerge('project', 'fix_thread')).rejects.toThrow('Merges are held'); await work.daily.sweep('project');
  expect((await work.daily.view('project')).window?.state).toBe('finished'); expect((await work.tasks.read('project', fix.id)).state).toBe('active');
  clock(24 * 60 - 150); await work.daily.sweep('project'); expect(await work.daily.mergesHeld('project')).toBe(true); clock(7 * 60); await work.daily.sweep('project'); expect(await work.daily.mergesHeld('project')).toBe(false);
  expect((await work.daily.view('project')).window?.failed).toBe(true);
}, 90_000);
test('a reviewer changing its worktree cannot advance the watermark', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork;
  second.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'illegal.txt'), 'changed'); await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const run = await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'dirty' }); await f.waitFor(() => work.tasks.read('project', run.taskId), task => task.state === 'failed');
  expect((await work.daily.view('project')).lastReviewedCommit).toBeNull(); expect((await work.tasks.read('project', run.taskId)).endNote).toContain('read-only review changed');
}, 90_000);


test('restart never replays an interrupted review or advances its watermark', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork;
  const changed = work.daily.o.changed; work.daily.o.changed = () => {};
  const receipt = await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'interrupted' }); work.daily.o.changed = changed;
  const task = await work.tasks.read('project', receipt.taskId), commit = f.git(f.checkout, 'rev-parse', 'HEAD');
  await work.tasks.save({ ...task, state: 'active', reviewRun: { schema: 'project-review-run-v1', sequence: 1, state: 'running', commit, fromCommit: null, deviceId: f.app.device.deviceId, runtime: 'fake2', modelId: 'reviewer', model: 'review-model', modelLabel: 'Reviewer', majorityProvider: 'fake', selectionBasis: 'Other provider.', startedAt: work.tasks.at(), report: null, followupChosen: false, fixTaskId: null } });
  await f.restart(); await f.waitFor(() => f.app.projectWork.tasks.read('project', task.id), row => row.state === 'failed');
  expect(second.turnStarts.some(input => input.owner.kind === 'review')).toBe(false); expect((await f.app.projectWork.daily.view('project')).lastReviewedCommit).toBeNull();
});
