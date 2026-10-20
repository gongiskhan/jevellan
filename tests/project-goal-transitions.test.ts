import { afterEach, expect, test, vi } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
import { task as fixtureTask } from './helpers/owner-fixtures.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  await work.coordinators.ensureAssigned('project');
  const current = (await work.settingsView('project')).settings, { schema: _s, projectId: _p, revision, ...settings } = current; void _s; void _p;
  await work.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, status: 'paused' } });
  const response = await f.request('/api/projects/project/goals', 'POST', { schema: 'goal-create-request-v1', clientRequestId: 'goal_transition', name: 'Scoped goal', motivation: 'Fixture-only goal transitions.' });
  expect(response.status).toBe(201); const { goal } = await response.json();
  return { f, work, goal };
}

test('UI goal completion cancels queued and proposed tasks while preserving running work and history', async () => {
  const { f, work, goal } = await setup();
  const queued = await work.tasks.save(fixtureTask('completion_queued', 'Queued fixture', { projectId: 'project', revision: 0, goalId: goal.id }));
  const draft = await work.tasks.save(fixtureTask('completion_draft', 'Proposed fixture', { projectId: 'project', revision: 0, goalId: goal.id, state: 'draft' }));
  const running = await work.tasks.save(fixtureTask('completion_running', 'Running fixture state', { projectId: 'project', revision: 0, goalId: goal.id, state: 'active' }));
  const response = await f.request(`/api/projects/project/goals/${goal.id}/edit`, 'POST', { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' });
  expect(response.status).toBe(200);
  expect((await work.tasks.read('project', queued.id)).state).toBe('cancelled');
  expect((await work.tasks.read('project', draft.id)).state).toBe('cancelled');
  expect(await work.tasks.read('project', running.id)).toEqual(running);
  expect((await work.goalList('project')).goals.map(row => row.goal)).toContainEqual(expect.objectContaining({ id: goal.id, state: 'done' }));
});

test('UI and owner-tool goal creation use the same canonical cap defaults', async () => {
  const { f, work, goal } = await setup();
  expect(await f.app.ownerTools.call('goals', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'create', args: { project: 'project', title: 'Tool default goal', motivation: 'Compare actual creation results.' } })).toMatchObject({ ok: true });
  const toolGoal = (await work.goalList('project')).goals.find(row => row.goal.name === 'Tool default goal')!.goal;
  expect({ dailyRefillCap: toolGoal.dailyRefillCap, openPrCap: toolGoal.openPrCap }).toEqual({ dailyRefillCap: goal.dailyRefillCap, openPrCap: goal.openPrCap });
});

test('goal completion refuses reserved queued starts before changing the goal or stopping any work', async () => {
  const { f, work, goal } = await setup();
  const queued = await work.tasks.save(fixtureTask('completion_reserved', 'Reserved fixture', { projectId: 'project', revision: 0, goalId: goal.id, dispatchText: 'Fixture reserved start.' }));
  const response = await f.request(`/api/projects/project/goals/${goal.id}/edit`, 'POST', { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' });
  expect(response.status).toBe(409);
  expect((await f.app.projectHub.goal(goal.id))?.document).toMatchObject({ state: 'active', revision: goal.revision });
  expect(await work.tasks.read('project', queued.id)).toEqual(queued);
});

test('a failed goal-completion cleanup resumes its recorded snapshot without cancelling future nightly work', async () => {
  const { f, work, goal } = await setup();
  const originalSave = work.tasks.save.bind(work.tasks);
  const queued = await originalSave(fixtureTask('completion_old_nightly', 'Existing nightly fixture', { projectId: 'project', revision: 0, goalId: goal.id, source: 'daily' }));
  const fault = vi.spyOn(work.tasks, 'save').mockRejectedValue(Object.assign(new Error('Fixture task storage unavailable.'), { status: 503 }));
  const response = await f.request(`/api/projects/project/goals/${goal.id}/edit`, 'POST', { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' });
  expect(response.status).toBe(503);
  expect((await f.app.projectHub.goal(goal.id))?.document).toMatchObject({ state: 'done', doneCleanup: { schema: 'goal-done-cleanup-v1', state: 'pending', taskIds: [queued.id] } });
  const later = await originalSave(fixtureTask('completion_future_nightly', 'Future nightly fixture', { projectId: 'project', revision: 0, goalId: goal.id, source: 'daily' }));
  expect(await work.goals.eligible(queued, await work.tasks.list('project'))).toBe(false);
  expect(await work.goals.eligible(later, await work.tasks.list('project'))).toBe(true);
  fault.mockRestore(); await work.goals.recoverDone('project');
  expect((await work.tasks.read('project', queued.id)).state).toBe('cancelled');
  expect(await work.tasks.read('project', later.id)).toEqual(later);
  expect((await f.app.projectHub.goal(goal.id))?.document).toMatchObject({ doneCleanup: { state: 'complete', cancelledCount: 1 } });
});

test('goal cleanup recovery does not repeat a cancellation already committed before a storage fault', async () => {
  const { f, work, goal } = await setup(), originalSave = work.tasks.save.bind(work.tasks);
  const first = await originalSave(fixtureTask('completion_partial_a', 'First queued fixture', { projectId: 'project', revision: 0, goalId: goal.id }));
  const second = await originalSave(fixtureTask('completion_partial_b', 'Second queued fixture', { projectId: 'project', revision: 0, goalId: goal.id }));
  const fault = vi.spyOn(work.tasks, 'save').mockImplementation(task => task.id === second.id && task.state === 'cancelled' ? Promise.reject(Object.assign(new Error('Fixture second save unavailable.'), { status: 503 })) : originalSave(task));
  expect((await f.request(`/api/projects/project/goals/${goal.id}/edit`, 'POST', { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' })).status).toBe(503);
  const committed = await work.tasks.read('project', first.id); expect(committed.state).toBe('cancelled');
  fault.mockRestore(); await work.goals.recoverDone('project');
  expect(await work.tasks.read('project', first.id)).toEqual(committed);
  expect((await work.tasks.read('project', second.id)).state).toBe('cancelled');
  expect((await f.app.projectHub.goal(goal.id))?.document).toMatchObject({ doneCleanup: { state: 'complete', cancelledCount: 2 } });
});

test('UI and owner-tool goal mutations run on the member coordinator with the same completion effect', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f); member.fake.capabilities.readOnlyEnforced = true;
  await f.app.projectWork.prepareDailyWork('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await member.request('/api/projects/project/coordinator/move', 'POST', { schema: 'empty-request-v1' })).status).toBe(200); await member.app.projectWork.idle();
  const current = (await f.app.projectWork.settingsView('project')).settings, { schema: _s, projectId: _p, revision, ...settings } = current; void _s; void _p;
  await f.app.projectWork.putSettings('project', { schema: 'project-work-settings-request-v1', revision, settings: { ...settings, status: 'paused' } });
  const response = await f.request('/api/projects/project/goals', 'POST', { schema: 'goal-create-request-v1', clientRequestId: 'member_goal_transition', name: 'Member goal', motivation: 'Fixture member ownership.' });
  expect(response.status).toBe(201); const { goal } = await response.json();
  const queued = await member.app.projectWork.tasks.save(fixtureTask('completion_member', 'Member queued fixture', { projectId: 'project', revision: 0, goalId: goal.id }));
  const hubUpdate = vi.spyOn(f.app.projectWork.goals, 'update'), memberUpdate = vi.spyOn(member.app.projectWork.goals, 'update');
  expect((await f.request(`/api/projects/project/goals/${goal.id}/edit`, 'POST', { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' })).status).toBe(200);
  expect(await f.app.ownerTools.call('goals', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'done', args: { project: 'project', goal: goal.id } })).toMatchObject({ ok: true });
  expect(hubUpdate).not.toHaveBeenCalled(); expect(memberUpdate).toHaveBeenCalledTimes(2);
  expect((await f.app.projectWork.tasks.read('project', queued.id)).state).toBe('cancelled');
});
