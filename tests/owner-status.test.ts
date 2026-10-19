import { expect, test } from 'vitest';
import { projectStatus, renderStatus, renderStatusLine, OwnerShortIds, capLines, type StatusInput } from '../packages/projects/dist/index.js';
import { ownerClock, ownerDuration } from '../packages/core/dist/index.js';
import { MemoryStore, NOW, at, coordinator, decision, goal, golden, job, run, settings, sha, task, thread } from './helpers/owner-fixtures.js';

const budgets = [{ label: 'main', usedPercent: 41, budgetPercent: 90 }, { label: 'second', usedPercent: 12, budgetPercent: 90 }];
function input(patch: Partial<StatusInput> = {}): StatusInput {
  return { project: { id: 'sandbox', name: 'sandbox' }, now: NOW, settings: settings(), coordinator: coordinator(), coordinatorStalled: false, threads: [], tasks: [], goals: [], decisions: [],
    jobs: [], dailies: [], runs: [], windows: [], deploys: [], budgets, deviceName: () => 'dev-box', deployPaused: false, ...patch };
}
const busy = () => {
  const goals = [goal('goal_a', 'Goal A', { createdAt: at(20000) }), goal('goal_b', 'Goal B', { createdAt: at(19000) }), goal('goal_c', 'Goal C', { state: 'paused', createdAt: at(18000) })];
  const tasks = [task('task_1', 'Harden parser tests', { goalId: 'goal_a', state: 'active', threadId: 'thread_1', createdAt: at(30) }), task('task_2', 'Compare extraction on twenty samples', { goalId: 'goal_b', state: 'active', threadId: 'thread_2', createdAt: at(29) }),
    task('task_3', 'Review flaky browser test', { goalId: 'goal_a', rank: 'a', createdAt: at(28) }), task('task_4', 'Bump the PDF library', { rank: 'b', createdAt: at(27) })];
  const threads = [thread('thread_1', 'Harden parser tests'), thread('thread_2', 'Compare extraction on twenty samples', { createdAt: at(5), runtime: 'codex', modelLabel: 'gpt-6.1', accountLabel: 'codex' })];
  return input({ goals, tasks, threads, jobs: [job('job_suite', 'Full suite')], runs: [run('run_1', 'job_suite')] });
};

test('status text matches its golden file for the six scripted states', () => {
  golden('status/idle', renderStatus(projectStatus(input(), new OwnerShortIds(new MemoryStore()))));
  golden('status/busy', renderStatus(projectStatus(busy(), new OwnerShortIds(new MemoryStore()))));
  const waiting = { ...busy(), decisions: [decision('decision_1', 'Deploy 1 landed thread(s) to production at aaaaaaa?', { options: [{ label: 'Deploy aaaaaaa' }, { label: 'Not now' }], deploy: { deployId: 'deploy_1', action: 'approve' } }),
    decision('decision_2', 'Which fixture should the parser tests use?', { from: 'thread', threadId: 'thread_1', createdAt: at(10) })] };
  golden('status/waiting', renderStatus(projectStatus(waiting, new OwnerShortIds(new MemoryStore()))));
  const held = { ...busy(), threads: [thread('thread_1', 'Harden parser tests', { state: 'attached' }), busy().threads[1]!], holds: new Map([['thread_1', { since: at(40), via: 'remote_control' as const, tmuxSession: 'jv-T1' }]]) };
  golden('status/held', renderStatus(projectStatus(held, new OwnerShortIds(new MemoryStore()))));
  const landing = { ...busy(), threads: [thread('thread_1', 'Harden parser tests', { state: 'publishing', stateReason: 'checks running (attempt 1 of 3)' }),
    thread('thread_9', 'Fix receipts rounding', { state: 'done', landing: { commit: sha('9f8e7d6'), at: at(74), method: 'squash', checks: [], route: 'land' }, endedAt: at(74), createdAt: at(200) })] };
  golden('status/landing', renderStatus(projectStatus(landing, new OwnerShortIds(new MemoryStore()))));
  const crashed = { ...input(), coordinator: coordinator('unavailable'), threads: [thread('thread_5', 'Add parser fuzz tests', { state: 'failed', stateReason: 'landing checks failed three times', endedAt: at(284) })],
    runs: [run('run_2', 'job_suite', { conclusion: 'passed', endedAt: at(600), summary: '4 fix tasks queued' })], jobs: [job('job_suite', 'Review since last')] };
  golden('status/crashed', renderStatus(projectStatus(crashed, new OwnerShortIds(new MemoryStore()))));
});

test('short ids are stable, never reused and resolve either way', () => {
  const store = new MemoryStore(); const ids = new OwnerShortIds(store);
  const first = projectStatus(busy(), ids);
  expect(first.running.map(row => row.id)).toEqual(['T1', 'J1', 'T2']);
  expect(first.queued.map(row => row.id)).toEqual(['T3', 'T4']);
  const again = projectStatus({ ...busy(), tasks: [task('task_0', 'Older but new to Jevellan', { createdAt: at(99999) }), ...busy().tasks] }, ids);
  expect(again.queued.find(row => row.internalId === 'task_0')?.id).toBe('T5');
  expect(ids.resolve('sandbox', 't2')).toEqual({ internalId: 'task_2', shortId: 'T2' });
  expect(ids.resolve('sandbox', 'task_2')).toEqual({ internalId: 'task_2', shortId: 'T2' });
  expect(ids.resolve('sandbox', 'T99')).toBeNull();
});

test('the goal filter limits every section and unknown goals are refused with the list', () => {
  const view = projectStatus({ ...busy(), goalFilter: 'g1' }, new OwnerShortIds(new MemoryStore()));
  expect(view.running.map(row => row.title)).toEqual(['Harden parser tests']);
  expect(view.queued.map(row => row.title)).toEqual(['Review flaky browser test']);
  golden('status/goal', renderStatus(view));
  expect(() => projectStatus({ ...busy(), goalFilter: 'Nope' }, new OwnerShortIds(new MemoryStore()))).toThrow('No goal matches "Nope". Goals: G1 Goal A, G2 Goal B, G3 Goal C.');
});

test('times, durations, caps and the status line follow the output conventions', () => {
  expect(ownerClock(at(80), NOW, 'Europe/Lisbon')).toBe('13:04');
  expect(ownerClock('2026-10-19T22:10:00.000Z', NOW, 'Europe/Lisbon')).toBe('yesterday 23:10');
  expect(ownerClock('2026-10-18T01:00:00.000Z', NOW, 'Europe/Lisbon')).toBe('Sun 18 Oct 02:00');
  expect(ownerDuration(22 * 60_000)).toBe('22 min'); expect(ownerDuration(100 * 60_000)).toBe('1 h 40 min');
  const long = capLines(Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(30)}`));
  expect(long.length).toBeLessThanOrEqual(3000); expect(long.split('\n').at(-1)).toMatch(/^\d+ more not shown\.$/u);
  expect(Number(long.split('\n').at(-1)!.split(' ')[0]) + long.split('\n').length - 1).toBe(400);
  expect(renderStatusLine(projectStatus(busy(), new OwnerShortIds(new MemoryStore())))).toBe('Jevellan sandbox · 3 running · 2 queued · 0 waiting · main 41/90%');
});
