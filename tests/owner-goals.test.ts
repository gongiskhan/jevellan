import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
const text = async (name: string, args: Record<string, unknown>) => { const result = await f!.app.ownerTools.call(name, { schema: 'owner-tool-request-v1', caller: 'bridge:project', args }); return result.ok ? result.text : `ERROR ${result.error.code}: ${result.error.text}`; };

test('goals are created, shown, paused against coordinator tasks, resumed and marked done with the specified copy', async () => {
  f = await projectFixture();
  expect(await text('goals', { action: 'create', title: 'Goal A', motivation: 'Nothing breaks without a test noticing.' })).toBe('Created G1 "Goal A". The coordinator plans its first tasks at its next turn.');
  const goalId = (await f.app.projectWork.goalList('project')).goals[0]!.goal.id;
  await f.app.projectWork.createTask('project', { schema: 'task-create-request-v1', clientRequestId: 'goal_task', title: 'Harden parser tests', brief: 'Harden.', type: 'feature', goalId, now: false, held: true, after: [], needs: [], fixed: {} });
  expect(await text('goals', { action: 'list' })).toMatch(/^G1 Goal A · active · 1 queued$/u);
  expect(await text('goals', { action: 'show', goal: 'goal a' })).toMatch(/^G1 Goal A · active\nNothing breaks without a test noticing\.\nHealth: not set\nDue: nothing\nRunning: none\nQueued: T1 Harden parser tests \(position 1\)\nWaiting on you: none\nToday: nothing yet\nNight items: none\nRecent coordinator decisions: none$/u);
  expect(await text('status', { goal: 'G1' })).toMatch(/^G1 Goal A · active\n/u);
  expect(await text('goals', { action: 'pause', goal: 'G1' })).toBe('Paused G1. Running tasks finish; queued ones wait until you resume it.');
  await expect(f.app.projectWork.tasks.create('project', { schema: 'task-create-request-v1', clientRequestId: 'coordinator_task', title: 'More work', brief: 'More.', type: 'feature', goalId, now: false, after: [], needs: [], fixed: {} }, 'finding')).rejects.toThrow('G1 is paused.');
  expect(await text('goals', { action: 'resume', goal: 'G1' })).toBe('Resumed G1. 1 queued task can start again.');
  expect(await text('goals', { action: 'done', goal: 'G1' })).toBe('Marked G1 done. Cancelled 1 queued tasks; 0 running tasks will finish. Its history stays.');
  expect(await text('goals', { action: 'list' })).toBe('Done: G1 Goal A');
  expect(await text('goals', { action: 'show', goal: 'nope' })).toBe('ERROR goal_not_found: No goal matches "nope". Goals: G1 Goal A.');
});
