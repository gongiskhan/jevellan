import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ThreadCreatedViewSchema, ThreadReportInputSchema, ThreadReportSchema, type ProjectWorkSettings } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitStep, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('failing checks run an automatic turn in the existing thread, publish and report the passing head', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture({ testCommand: 'test -f greeting.txt' });
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'First version.\n' }, { status: 'done', summary: 'Added the greeting.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'req_auto_checks', title: 'Add a greeting', task: 'Add greeting.txt.',
  });
  await f.app.projectWork.idle();
  const before = f.thread(made.threadId), number = before.pr!.number;
  expect(before.state).toBe('in-review');
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'Corrected version.\n' }, { status: 'done', summary: 'Fixed the failing check.' }), forThread());
  f.github.setChecks(number, 'failing');
  await f.app.projectWork.tracker.poll();
  await f.app.projectWork.idle();
  const fixed = f.thread(made.threadId);
  expect(fixed.turns).toBe(2);
  expect(fixed.state).toBe('in-review');
  expect(fixed.pr!.number).toBe(number);
  expect(fixed.pr!.headSha).not.toBe(before.pr!.headSha);
  expect(f.fake.turnStarts[1]!.prompt).toContain(`Checks failed on pull request #${number}`);
  f.github.setChecks(number, 'passing');
  await f.app.projectWork.tracker.poll();
  const events = f.coordinatorState().queue.filter(event => event.kind === 'thread-auto-fix');
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'thread-auto-fix', threadId: made.threadId, fixKind: 'checks', outcome: 'started', round: 1, maxRounds: 3 }),
    expect.objectContaining({ kind: 'thread-auto-fix', threadId: made.threadId, fixKind: 'checks', outcome: 'fixed' }),
  ]));
});

async function open(f: ProjectFixture, title = 'Repair the greeting') {
  f.fake.enqueueTurn(commitStep({ 'greeting.txt': 'First version.\n' }, { status: 'done', summary: 'Added the greeting.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'req_auto_open', title, task: 'Add greeting.txt.',
  });
  await f.app.projectWork.idle(); return f.thread(made.threadId);
}
async function settings(f: ProjectFixture, patch: Partial<ProjectWorkSettings>) {
  const current = await f.app.projectWork.admission.settings(f.project.id);
  await f.app.projectHub.putSettings({ ...current, ...patch }, current.revision);
}
const fixStep = (f: ProjectFixture, n: number) => f.fake.enqueueTurn(commitStep({ 'greeting.txt': `Fixed version ${n}.\n` }, { status: 'done', summary: `Fix ${n}.` }), forThread());

test('the round cap asks once, both answers work, retries do not reset later rounds and owner buttons add no round', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); await settings(f, { prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 2 } });
  const thread = await open(f), n = thread.pr!.number;
  f.github.setChecks(n, 'failing');
  for (const i of [1, 2]) { fixStep(f, i); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); }
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.tracker.poll();
  const asked = (await f.app.projectHub.decisions(f.project.id)).filter(q => q.automaticFix && !q.answer);
  expect(asked).toHaveLength(1); expect(asked[0]!.question).toBe(`Pull request #${n} still has failing checks after 2 automatic fixes.`);
  expect(asked[0]!.options.map(o => o.label)).toEqual(['Allow 2 more automatic fixes', 'Leave it to me']);
  expect(f.coordinatorState().queue.filter(e => e.kind === 'thread-auto-fix' && e.outcome === 'gave-up')).toHaveLength(1);
  fixStep(f, 3);
  await f.app.projectWork.decisions.answer(f.project.id, asked[0]!.id, { clientRequestId: 'answer_allow', optionLabel: 'Allow 2 more automatic fixes' });
  await f.waitFor(() => f.thread(thread.id), t => t.turns === 4 && t.state === 'in-review');
  expect(f.local(thread.id).prAutoFix!.rounds).toBe(1);
  await f.app.projectWork.decisions.answer(f.project.id, asked[0]!.id, { clientRequestId: 'answer_allow', optionLabel: 'Allow 2 more automatic fixes' });
  expect(f.local(thread.id).prAutoFix!.rounds).toBe(1);
  fixStep(f, 4); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); await f.app.projectWork.tracker.poll();
  const next = (await f.app.projectHub.decisions(f.project.id)).find(q => q.automaticFix && !q.answer)!;
  expect(next.id).not.toBe(asked[0]!.id);
  await f.app.projectWork.decisions.answer(f.project.id, next.id, { clientRequestId: 'answer_leave', optionLabel: 'Leave it to me' });
  expect(f.local(thread.id).prAutoFix!.disabled).toBe(true); await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(5);
  fixStep(f, 5);
  const response = await f.request(`/api/projects/project/threads/${thread.id}/actions`, 'POST', { schema: 'thread-action-request-v1', clientRequestId: 'owner_checks', action: 'fix-checks' });
  expect(response.status).toBe(200); await f.app.projectWork.idle();
  expect(f.local(thread.id).prAutoFix).toMatchObject({ rounds: 2, disabled: false, pendingResults: [] });
  expect(f.thread(thread.id).lastReport!.fix).toEqual({ by: 'owner', kind: 'checks' });
});

test('a conflict turn merges current main, preserves both intents and publishes the existing pull request', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f), n = thread.pr!.number;
  writeFileSync(join(f.checkout, 'greeting.txt'), 'Main greeting.\n'); f.git(f.checkout, 'add', 'greeting.txt'); f.git(f.checkout, 'commit', '-m', 'Main greeting'); f.git(f.checkout, 'push', 'origin', 'main');
  f.github.setMergeable(n, 'dirty');
  f.fake.enqueueTurn(async turn => {
    expect(turn.input.prompt).toContain('merge origin/main into this branch (do not rebase)');
    f.git(turn.input.cwd, 'fetch', 'origin'); expect(() => f.git(turn.input.cwd, 'merge', 'origin/main')).toThrow();
    writeFileSync(join(turn.input.cwd, 'greeting.txt'), 'First version. Main greeting.\n'); f.git(turn.input.cwd, 'add', 'greeting.txt'); f.git(turn.input.cwd, 'commit', '-m', 'Keep both greetings');
    f.github.setMergeable(n, 'clean'); await turn.bridge('jevellan_thread_report', { status: 'done', summary: 'Kept both greetings.' }); return { status: 'completed' };
  }, forThread());
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); await f.app.projectWork.tracker.poll();
  expect(f.thread(thread.id)).toMatchObject({ turns: 2, state: 'in-review', pr: { number: n, mergeable: 'clean' } });
  expect(f.git(f.thread(thread.id).cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-auto-fix', fixKind: 'conflicts', outcome: 'fixed' }));
});

test('comments include bots, batch after two quiet minutes, advance the cursor and are delivered once', { timeout: 120_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), thread = await open(f), n = thread.pr!.number;
  now += 1000; const at = new Date(now).toISOString(), pull = f.github.pulls.find(p => p.number === n)!;
  pull.issueComments = [{ id: 1, user: { login: 'helper[bot]' }, body: 'Please keep the greeting clear.', created_at: at }];
  pull.inlineComments = [{ id: 2, user: { login: 'owner' }, body: 'Use the helper here.', created_at: at, path: 'greeting.txt', line: 1 }];
  pull.reviews = [{ id: 3, user: { login: 'owner' }, body: '', state: 'COMMENTED', submitted_at: at }, { id: 4, user: { login: 'owner' }, body: 'Approved.', state: 'APPROVED', submitted_at: at }, { id: 5, user: { login: 'owner' }, body: 'Please make the wording consistent.', state: 'CHANGES_REQUESTED', submitted_at: at }]; pull.updatedAt = at;
  await f.app.projectWork.tracker.poll(); expect(f.local(thread.id).prComments!.items).toHaveLength(3); expect(f.thread(thread.id).turns).toBe(1);
  now += 119_999; await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(1);
  now += 1; fixStep(f, 1); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.fake.turnStarts[1]!.prompt).toContain('helper[bot]: Please keep the greeting clear.'); expect(f.fake.turnStarts[1]!.prompt).toContain('owner on greeting.txt:1: Use the helper here.');
  expect(f.local(thread.id).prAutoFix!.comments.deliveredIds).toHaveLength(3); expect(f.local(thread.id).prComments!.items).toHaveLength(0);
  await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(2);
  const secondAt = new Date(now + 1).toISOString(); pull.issueComments.push({ id: 6, user: { login: 'owner' }, body: 'One more small wording change.', created_at: secondAt }); pull.updatedAt = secondAt;
  now += 121_000; fixStep(f, 2); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(3); expect(f.fake.turnStarts[2]!.prompt).toContain('One more small wording change.');
  expect(f.fake.turnStarts[2]!.prompt.split('New review comments on pull request').at(-1)).not.toContain('Please keep the greeting clear.');
  expect(f.local(thread.id).prAutoFix!.comments.deliveredIds).toHaveLength(4);
});

test('automatic fixes do not start while off, paused, working, attached, idle, failed or waiting', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f), n = thread.pr!.number;
  f.github.setChecks(n, 'failing'); await settings(f, { prAutoFix: { checks: false, conflicts: false, comments: false, maxRounds: 3 } });
  await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(1);
  await settings(f, { status: 'paused', prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 3 } });
  await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(1); await settings(f, { status: 'active' });
  for (const state of ['running', 'attached', 'idle', 'failed', 'waiting-for-you'] as const) {
    f.app.projectWork.store.update(thread.id, current => ({ ...current, state })); await f.app.projectWork.tracker.poll(); expect(f.thread(thread.id).turns).toBe(1);
  }
  f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'in-review' })); fixStep(f, 1); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); expect(f.thread(thread.id).turns).toBe(2);
});

test('an automatic blocked report rests and reaches the coordinator without another automatic round', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f); f.github.setChecks(thread.pr!.number, 'failing');
  f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'The check failed because the test service is unavailable.' }), forThread());
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); await f.app.projectWork.tracker.poll();
  expect(f.thread(thread.id)).toMatchObject({ turns: 2, state: 'idle', lastReport: { status: 'blocked', synthesized: false, fix: { by: 'automatic' } } });
  expect(f.local(thread.id).prAutoFix!.rounds).toBe(1);
  expect(f.coordinatorState().queue).toContainEqual(expect.objectContaining({ kind: 'thread-report', report: expect.objectContaining({ status: 'blocked' }) }));
});

test('notification acknowledgement lost across restart does not create another turn or duplicate events', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f), n = thread.pr!.number; f.github.setChecks(n, 'failing');
  fixStep(f, 1); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  f.app.projectWork.store.updateLocal(thread.id, local => ({ ...local, prAutoFix: { ...local.prAutoFix!, pendingResults: local.prAutoFix!.pendingResults!.map(row => ({ ...row, startedNotified: false })) } }));
  f.github.setChecks(n, 'passing'); await f.restart(); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(2); expect(f.local(thread.id).prAutoFix!.rounds).toBe(1);
  const events = f.coordinatorState().queue.filter(e => e.kind === 'thread-auto-fix');
  expect(events.filter(e => e.outcome === 'started')).toHaveLength(1); expect(events.filter(e => e.outcome === 'fixed')).toHaveLength(1);
});

test('the first comment read includes comments posted before the publication receipt was saved', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f), pull = f.github.pulls.find(p => p.number === thread.pr!.number)!;
  const at = new Date((Date.parse(thread.createdAt) + Date.parse(thread.pr!.updatedAt)) / 2).toISOString();
  pull.issueComments = [{ id: 101, user: { login: 'owner' }, body: 'Please keep this early review comment.', created_at: at }];
  await f.app.projectWork.tracker.poll(); expect(f.local(thread.id).prComments!.items).toHaveLength(1);
});

test('only the daemon can attach automatic-fix provenance to a report', () => {
  const fix = { by: 'automatic', id: 'pfix_report', kind: 'checks', round: 1, maxRounds: 3 };
  expect(ThreadReportInputSchema.safeParse({ status: 'done', summary: 'Ready.', fix }).success).toBe(false);
  expect(ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 2, status: 'done', summary: 'Ready.', synthesized: false, fix }).fix).toEqual(fix);
});

test('an already handled failing head does not suppress a newly actionable conflict', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f), n = thread.pr!.number;
  f.github.setChecks(n, 'failing'); await settings(f, { prAutoFix: { checks: false, conflicts: false, comments: false, maxRounds: 3 } });
  await f.app.projectWork.tracker.poll();
  f.app.projectWork.store.updateLocal(thread.id, local => ({ ...local, prAutoFix: { ...local.prAutoFix!, rounds: 1, handledHead: { checks: thread.pr!.headSha } } }));
  await settings(f, { prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 3 } }); f.github.setMergeable(n, 'dirty');
  fixStep(f, 2); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(2); expect(f.fake.turnStarts[1]!.prompt).toContain('merge origin/main into this branch');
});

test('a cap question is withdrawn when CI recovers and a later failure gets a fresh question', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(); await settings(f, { prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 1 } });
  const thread = await open(f), n = thread.pr!.number; f.github.setChecks(n, 'failing'); fixStep(f, 1);
  await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle(); await f.app.projectWork.tracker.poll();
  const first = (await f.app.projectHub.decisions(f.project.id)).find(q => q.automaticFix)!;
  f.github.setChecks(n, 'passing'); await f.app.projectWork.tracker.poll();
  expect((await f.app.projectHub.decision(first.id))?.document.withdrawnAt).toBeDefined();
  f.github.setChecks(n, 'failing'); await f.app.projectWork.tracker.poll();
  const second = (await f.app.projectHub.decisions(f.project.id)).find(q => q.automaticFix && !q.answer && !q.withdrawnAt)!;
  expect(second.id).not.toBe(first.id); expect(f.thread(thread.id).turns).toBe(2);
});

test('publishing one comment batch preserves undelivered comments with the same timestamp', { timeout: 120_000 }, async () => {
  let now = Date.now(); const f = fixture = await projectFixture({ projectTimers: { now: () => now } }), thread = await open(f), pull = f.github.pulls.find(p => p.number === thread.pr!.number)!;
  now += 1000; const at = new Date(now).toISOString();
  pull.issueComments = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, user: { login: 'owner' }, body: `Review item ${i + 1}.`, created_at: at })); pull.updatedAt = at;
  await f.app.projectWork.tracker.poll(); now += 121_000; fixStep(f, 1); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  await settings(f, { prAutoFix: { checks: true, conflicts: true, comments: false, maxRounds: 3 } });
  now += 61_000; await f.app.projectWork.tracker.poll(); expect(f.local(thread.id).prComments!.items).toHaveLength(5);
  await settings(f, { prAutoFix: { checks: true, conflicts: true, comments: true, maxRounds: 3 } });
  fixStep(f, 2); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).turns).toBe(3); expect(f.local(thread.id).prAutoFix!.comments.deliveredIds).toHaveLength(20);
});

test('turning automatic checks off cancels a queued resource wait without charging an unstarted round', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f); await settings(f, { maxRunningThreads: 1 });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { entered = resolve; });
  f.fake.enqueueTurn(async turn => { entered(); await held; return reportStep({ status: 'progress', summary: 'Resource holder finished.' })(turn); }, forThread());
  try {
    await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'req_resource_holder', title: 'Hold one slot', task: 'Wait for the fixture release.' }); await running;
    f.github.setChecks(thread.pr!.number, 'failing'); await f.app.projectWork.tracker.poll();
    expect(f.local(thread.id).pendingTurn?.reason).toBe('checks'); expect(f.thread(thread.id).turns).toBe(1);
    await settings(f, { prAutoFix: { checks: false, conflicts: true, comments: true, maxRounds: 3 } });
    release(); await f.app.projectWork.idle(); fixStep(f, 1); await f.app.projectWork.threads.sweep(); await f.app.projectWork.idle();
    expect(f.thread(thread.id).turns).toBe(1); expect(f.local(thread.id).pendingTurn).toBeUndefined(); expect(f.local(thread.id).prAutoFix!.rounds).toBe(0);
  } finally { release(); }
});

test('a resumed verification keeps its automatic origin, spends no second round and clears its pending turn', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), thread = await open(f); f.github.setChecks(thread.pr!.number, 'failing');
  fixStep(f, 1); await f.app.projectWork.tracker.poll(); await f.app.projectWork.idle();
  const fix = f.thread(thread.id).lastReport!.fix!; expect(fix.by).toBe('automatic');
  f.app.projectWork.store.updateLocal(thread.id, local => ({ ...local, pendingTurn: { reason: 'verification', body: 'Finish the verification repair.', fix } }));
  f.app.projectWork.store.update(thread.id, current => ({ ...current, state: 'idle' }));
  fixStep(f, 2); await f.app.projectWork.threads.runner(thread.id)!.resume(); await f.app.projectWork.idle();
  expect(f.thread(thread.id).lastReport!.fix).toEqual(fix); expect(f.local(thread.id).prAutoFix!.rounds).toBe(1);
  expect(f.local(thread.id).pendingTurn).toBeUndefined(); expect(f.thread(thread.id).turns).toBe(3);
});
