import { TaskReceiptSchema } from '../packages/core/dist/index.js';
import { afterEach, expect, test } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    const input = turn.input.prompt.match(/Read every commit and patch in (.*), then inspect/)!; const diff = readFileSync(input[1]!, 'utf8'); expect(diff).not.toContain('    Seed\n');
    await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' };
  }, input => input.owner.kind === 'review');
  const run = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'first' })); await f.waitFor(() => work.tasks.read('project', run.taskId), task => task.state === 'done'); await work.idle();
  const first = (await work.daily.view('project')).lastReview!; expect(first).toMatchObject({ schema: 'project-review-report-v1', runtime: 'fake2', fromCommit: f.git(f.checkout, 'rev-parse', 'HEAD'), findings: body.findings }); expect((await work.daily.view('project')).lastReviewedCommit).toBe(first.commit);
  const chosen = await work.daily.followup('project', { reviewTaskId: run.taskId, task: { title: 'Fix all review findings', brief: 'Add the empty-name default.' } });
  expect(await work.daily.followup('project', { reviewTaskId: run.taskId, task: { title: 'Second fix', brief: 'Must not create another.' } })).toMatchObject({ repeated: true, taskId: chosen.taskId });
  expect((await work.tasks.list('project')).filter(task => task.nightlyFixFor === run.taskId)).toHaveLength(1);
  writeFileSync(join(f.checkout, 'direct.txt'), 'Direct push\n'); f.git(f.checkout, 'add', '-A'); f.git(f.checkout, 'commit', '-m', 'Direct owner push'); f.git(f.checkout, 'push', 'origin', 'main');
  second.enqueueTurn(async turn => { const input = turn.input.prompt.match(/Read every commit and patch in (.*), then inspect/)!; const diff = readFileSync(input[1]!, 'utf8'); expect(diff).toContain('Direct owner push'); expect(diff).not.toContain('    Seed\n'); await turn.bridge('jevellan_project_review_report', { summary: 'Direct push reviewed.', findings: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const next = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'next' })); await f.waitFor(() => work.tasks.read('project', next.taskId), task => task.state === 'done');
  expect((await work.daily.view('project')).lastReview?.fromCommit).toBe(first.commit); expect(f.git(f.checkout, 'status', '--porcelain=v1')).toBe(checkout);
}, 90_000);
test('review fixes continue outside the nightly window and never bypass its landing hold', async () => {
  const { f, second, daily, clock } = await setup(), work = f.app.projectWork;
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  clock(1); await work.pulse(); const window = (await work.daily.window('project'))!; const reviewTask = window.plans.find(task => task.dailyId === daily.id)!;
  await f.waitFor(() => work.tasks.read('project', reviewTask.id), task => task.state === 'done');
  const follow = await work.daily.followup('project', { reviewTaskId: reviewTask.id, task: { title: 'Combined fix', brief: 'Fix all findings.' } });
  // A synthetic linked thread identity exercises the shared merge guard; no merge is claimed.
  const fix = await work.tasks.read('project', follow.taskId!); await work.tasks.save({ ...fix, threadId: 'fix_thread', state: 'active' });
  expect(fix.nightlyWindowId).toBeUndefined();
  await work.daily.sweep('project');
  await expect(work.daily.assertMerge('project', 'fix_thread')).resolves.toBeUndefined();
  clock(150);
  expect((await work.daily.view('project')).window?.state).toBe('finished'); expect((await work.tasks.read('project', fix.id)).state).toBe('active');
  clock(24 * 60 - 150); await work.daily.sweep('project'); expect(await work.daily.mergesHeld('project')).toBe(true); clock(7 * 60); await work.daily.sweep('project'); expect(await work.daily.mergesHeld('project')).toBe(false);
  expect((await work.daily.view('project')).window?.failed).toBe(true);
}, 90_000);
test('a reviewer changing its worktree cannot advance the watermark', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork;
  second.enqueueTurn(async turn => { writeFileSync(join(turn.input.cwd, 'illegal.txt'), 'changed'); await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const run = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'dirty' })); await f.waitFor(() => work.tasks.read('project', run.taskId), task => task.state === 'failed');
  expect((await work.daily.view('project')).lastReviewedCommit).toBe(f.git(f.checkout, 'rev-parse', 'HEAD')); expect((await work.tasks.read('project', run.taskId)).endNote).toContain('read-only review changed');
}, 90_000);


test('restart never replays an interrupted review or advances its watermark', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork;
  const changed = work.daily.o.changed; work.daily.o.changed = () => {};
  const receipt = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'interrupted' })); work.daily.o.changed = changed;
  const task = await work.tasks.read('project', receipt.taskId), commit = f.git(f.checkout, 'rev-parse', 'HEAD');
  await work.tasks.save({ ...task, state: 'active', reviewRun: { schema: 'project-review-run-v1', sequence: 1, state: 'running', commit, fromCommit: null, deviceId: f.app.device.deviceId, runtime: 'fake2', modelId: 'reviewer', model: 'review-model', modelLabel: 'Reviewer', majorityProvider: 'fake', selectionBasis: 'Other provider.', startedAt: work.tasks.at(), report: null, followupChosen: false, fixTaskId: null } });
  await f.restart(); await f.waitFor(() => f.app.projectWork.tasks.read('project', task.id), row => row.state === 'failed');
  expect(second.turnStarts.some(input => input.owner.kind === 'review')).toBe(false); expect((await f.app.projectWork.daily.view('project')).lastReviewedCommit).toBe(f.git(f.checkout, 'rev-parse', 'HEAD'));
});
test('creating and first enabling a review starts at current main, with an owner-editable baseline', async () => {
  const { f, daily } = await setup(), work = f.app.projectWork, initial = f.git(f.checkout, 'rev-parse', 'HEAD');
  expect(daily.target).toMatchObject({ reviewFromCommit: initial });
  const disabled = await work.daily.updateDaily('project', daily.id, { schema: 'daily-update-request-v1', expectedRevision: daily.revision, name: daily.name, goalId: daily.goalId, order: 0, target: daily.target, enabled: false });
  writeFileSync(join(f.checkout, 'new-main.txt'), 'owner push'); f.git(f.checkout, 'add', '-A'); f.git(f.checkout, 'commit', '-m', 'New main before enabling'); f.git(f.checkout, 'push', 'origin', 'main');
  const enabled = await work.daily.updateDaily('project', daily.id, { schema: 'daily-update-request-v1', expectedRevision: disabled.revision, name: daily.name, goalId: daily.goalId, order: 0, target: disabled.target, enabled: true });
  expect(enabled.target).toMatchObject({ reviewFromCommit: f.git(f.checkout, 'rev-parse', 'HEAD') });
  const selected = await work.daily.updateDaily('project', daily.id, { schema: 'daily-update-request-v1', expectedRevision: enabled.revision, name: daily.name, goalId: daily.goalId, order: 0, target: { kind: 'review-since-last', reviewFromCommit: initial }, enabled: false });
  const kept = await work.daily.updateDaily('project', daily.id, { schema: 'daily-update-request-v1', expectedRevision: selected.revision, name: daily.name, goalId: daily.goalId, order: 0, target: selected.target, enabled: true });
  expect(kept.target).toMatchObject({ reviewFromCommit: initial });
});
test('a newly created review definition uses its captured baseline rather than an older definition watermark', async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork;
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_project_review_report', { summary: 'Initial baseline reviewed.', findings: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const first = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'old_definition' }));
  await f.waitFor(() => work.tasks.read('project', first.taskId), row => row.state === 'done');
  await work.daily.updateDaily('project', daily.id, { schema: 'daily-update-request-v1', expectedRevision: daily.revision, name: daily.name, goalId: daily.goalId, order: 0, target: { kind: 'session', title: 'Previous nightly item', brief: 'Park the previous review definition.', type: 'review' }, enabled: false });
  writeFileSync(join(f.checkout, 'later.txt'), 'Before new review definition'); f.git(f.checkout, 'add', '-A'); f.git(f.checkout, 'commit', '-m', 'Main before replacement review'); f.git(f.checkout, 'push', 'origin', 'main');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD'), replacement = await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'replacement_review', name: 'Replacement review', goalId: daily.goalId, order: 0, enabled: true, target: { kind: 'review-since-last' } });
  expect((await work.daily.view('project')).lastReviewedCommit).toBe(head);
  second.enqueueTurn(async turn => { expect(turn.input.prompt).toContain(`review from commit ${head}`); await turn.bridge('jevellan_project_review_report', { summary: 'Replacement baseline reviewed.', findings: [] }); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  const next = TaskReceiptSchema.parse(await work.daily.runDaily('project', replacement.id, { schema: 'project-run-request-v1', clientRequestId: 'new_definition' }));
  await f.waitFor(() => work.tasks.read('project', next.taskId), row => ['done', 'failed'].includes(row.state));
  expect((await work.tasks.read('project', next.taskId)).reviewRun?.fromCommit).toBe(head);
  expect((await work.tasks.read('project', next.taskId)).state).toBe('done');
});
test('a 3000-commit review streams a bounded input with every message/stat and a remaining-patch instruction', { timeout: 180_000 }, async () => {
  const { f, second, daily } = await setup(), work = f.app.projectWork, base = f.git(f.checkout, 'rev-parse', 'HEAD');
  let imported = '';
  for (let i = 1; i <= 3000; i++) {
    const content = `${i} ${'x'.repeat(4096)}\n`, message = `Night change ${i}\n`;
    imported += `blob\nmark :${i}\ndata ${Buffer.byteLength(content)}\n${content}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> ${1791790000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i === 1 ? `from ${base}\n` : ''}M 100644 :${i} range.txt\n\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: f.checkout, input: imported, stdio: ['pipe', 'ignore', 'pipe'], maxBuffer: 1024 * 1024 });
  f.git(f.checkout, 'reset', '--hard', 'main'); f.git(f.checkout, 'push', 'origin', 'main');
  expect(Number(f.git(f.checkout, 'rev-list', '--count', 'main'))).toBeGreaterThanOrEqual(3000);
  second.enqueueTurn(async turn => {
    const input = turn.input.prompt.match(/Read every commit and patch in (.*), then inspect/)!;
    expect(statSync(input[1]!).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    const content = readFileSync(input[1]!, 'utf8'); expect(content).toContain('Night change 1'); expect(content).toContain('Night change 3000'); expect(content).not.toContain('    Seed\n'); expect(content).toContain('remaining patches');
    await turn.bridge('jevellan_project_review_report', { summary: 'Range reviewed.', findings: [] }); return { status: 'completed' };
  }, input => input.owner.kind === 'review');
  const receipt = TaskReceiptSchema.parse(await work.daily.runDaily('project', daily.id, { schema: 'project-run-request-v1', clientRequestId: 'large_range' }));
  await f.waitFor(() => work.tasks.read('project', receipt.taskId), row => ['done', 'failed'].includes(row.state), 150_000);
  const completed = await work.tasks.read('project', receipt.taskId);
  expect(completed.state, completed.endNote ?? undefined).toBe('done');
});
test('ordinary queued work remains eligible overnight and a late opening uses the actual open clock', async () => {
  const { f, clock } = await setup(), work = f.app.projectWork;
  const queued = await work.tasks.create('project', { schema: 'task-create-request-v1', clientRequestId: 'ordinary_night', title: 'Ordinary overnight task', brief: 'Run normal placement overnight.', type: 'fix', goalId: null, now: false, after: [], needs: [], fixed: {} });
  clock(91); await work.daily.sweep('project');
  const window = (await work.daily.window('project'))!;
  expect(window.openedAt).toBe(work.tasks.at());
  expect(await work.daily.eligible(await work.tasks.read('project', queued.taskId), await work.tasks.list('project'))).toBe(true);
});
test('jobs continue after a failed review and its reason appears in the night report', async () => {
  const { f, second, clock } = await setup(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'post_review', name: 'After failed review', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'post_review_daily', name: job.name, goalId: null, order: 1, enabled: true, target: { kind: 'job', jobId: job.id } });
  second.enqueueTurn(async () => ({ status: 'failed', error: { kind: 'other', message: 'Provider temporarily refused the review.' } }), input => input.owner.kind === 'review');
  clock(1); await work.pulse(); await f.waitFor(() => work.daily.view('project'), view => view.window?.state === 'finished');
  const view = await work.daily.view('project'); expect(view.runs[0]?.conclusion).toBe('passed'); expect(view.window?.outcome).toContain('Provider temporarily refused');
});

test('a completed review never delays the next configured job while a finding continues normally', async () => {
  const { f, second, daily, clock } = await setup(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'wait_job', name: 'Full suite', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'wait_job_daily', name: 'Full suite', goalId: null, order: 1, enabled: true, target: { kind: 'job', jobId: job.id } });
  second.enqueueTurn(async turn => { await turn.bridge('jevellan_project_review_report', body); return { status: 'completed' }; }, input => input.owner.kind === 'review');
  clock(1); await work.pulse(); const window = (await work.daily.window('project'))!, review = window.plans.find(row => row.dailyId === daily.id)!, suite = window.plans.find(row => row.jobId === job.id)!;
  await f.waitFor(() => work.tasks.read('project', review.id), row => row.state === 'done');
  expect(await work.daily.eligible(suite, await work.tasks.list('project'))).toBe(true);
  clock(20); expect(await work.daily.eligible(suite, await work.tasks.list('project'))).toBe(true);
  const changed = work.daily.o.changed; work.daily.o.changed = () => {};
  const chosen = await work.daily.followup('project', { reviewTaskId: review.id, task: { title: 'Combined review finding', brief: 'Fix every worthwhile finding.' } }); work.daily.o.changed = changed;
  expect((await work.tasks.read('project', chosen.taskId!)).state).toBe('queued');
  // A coordinator follow-up cannot hold the configured jobs.
  expect(await work.daily.eligible(suite, await work.tasks.list('project'))).toBe(true);
});

test('a hub returning more than seven hours late still opens a seven-hour window from its real clock', async () => {
  const { f, clock } = await setup(), work = f.app.projectWork;
  clock(8 * 60 + 1); await work.daily.sweep('project'); const window = (await work.daily.window('project'))!;
  expect(window.openedAt).toBe(work.tasks.at()); expect(window.openedLateReason).toContain('480 minutes late');
  clock(6 * 60); expect(await work.daily.mergesHeld('project')).toBe(true);
  clock(60); await work.daily.sweep('project'); const ended = (await work.daily.view('project')).window!;
  expect(ended.state).toBe('finished'); expect(ended.outcome).toContain('Opened late'); expect(ended.outcome).toContain('seven-hour');
});
