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
  const created = await work.createGoal('project', { schema: 'goal-create-request-v1', clientRequestId: 'goal_view', name: 'Scoped goal', motivation: 'Render the canonical goal state.' });
  return { f, work, goal: created.goal };
}
async function view(f: ProjectFixture) { const response = await f.request('/api/projects/project/goal-views'); expect(response.status).toBe(200); return response.json(); }

test('goal views supply labels, counts, actions and completion consequences to UI and owner clients', async () => {
  const { f, goal } = await setup(), model = await view(f);
  expect(model).toMatchObject({ schema: 'project-goal-views-v1', projectId: 'project', rows: [{ goalId: goal.id, name: goal.name, stateLabel: 'Active', autonomyLabel: 'Propose tasks',
    countsLine: '0 queued · 0 running · 0 in review · 0 refilled today', capsLine: 'Refills a day: 3 · Open pull requests: 2' }] });
  expect(model.rows[0].due).toEqual([{ type: 'idle_goal', ref: goal.id, text: 'nothing queued or running' }]);
  const done = model.rows[0].actions.find((action: { name: string }) => action.name === 'done');
  expect(done).toMatchObject({ kind: 'update', enabled: true, request: { path: `/api/projects/project/goals/${goal.id}/edit`, body: { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' } } });
  expect(done.confirm.consequence).toContain('Queued and proposed tasks are cancelled. Running tasks finish.');
  expect((await (await f.request('/api/projects/project/status-view')).json()).goalViews).toEqual(model);
  expect(await f.app.ownerTools.call('goals', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'list', args: { project: 'project' } })).toMatchObject({ ok: true, data: model });
});

test('goal editor models share canonical defaults, raw-field normalization and retry-safe UI/tool creation', async () => {
  const { f, work } = await setup(), response = await f.request('/api/projects/project/goals/editor'); expect(response.status).toBe(200); const editor = await response.json();
  expect(editor).toMatchObject({ schema: 'project-goal-editor-v1', defaults: { autonomy: 'propose', state: 'active', dailyRefillCap: '3', openPrCap: '2' },
    constraints: { name: { maxLength: 80 }, motivation: { maxLength: 4000 }, health: { maxLength: 1000 }, dailyRefillCap: { min: 0, max: 20 }, openPrCap: { min: 1, max: 10 } } });
  const request = { ...editor.request.base, fields: { ...editor.defaults, name: 'Form goal', motivation: 'Shared editor fixture.', dailyRefillCap: '4', openPrCap: '5' } };
  const saved = await f.request(editor.request.path, 'POST', request); expect(saved.status).toBe(201); const created = await saved.json();
  expect(await f.app.ownerTools.call('goals', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'save', args: { project: 'project', request } })).toMatchObject({ ok: true, data: { goal: { id: created.goal.id, dailyRefillCap: 4, openPrCap: 5 } } });
  expect((await work.goalList('project')).goals.filter(row => row.goal.name === 'Form goal')).toHaveLength(1);
});

test('goal queue projection keeps running work of done goals visible and resolves unknown waiting dependencies', async () => {
  const { f, work, goal } = await setup();
  const running = await work.tasks.save(fixtureTask('view_done_running', 'Running fixture', { projectId: 'project', revision: 0, goalId: goal.id, state: 'active' }));
  await work.tasks.save(fixtureTask('missing_dependency', 'Dependency fixture', { projectId: 'project', revision: 0 }));
  const waiting = await work.tasks.save(fixtureTask('view_waiting', 'Waiting fixture', { projectId: 'project', revision: 0, after: ['missing_dependency'], held: true, ownerRanked: true }));
  // Simulate an incomplete read model, while retaining the canonical store's dependency-integrity guard.
  const list = work.tasks.list.bind(work.tasks); vi.spyOn(work.tasks, 'list').mockImplementation(async projectId => (await list(projectId)).filter(task => task.id !== 'missing_dependency'));
  await work.updateGoal('project', goal.id, { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'done' });
  const model = await view(f);
  expect(model.queue.scopes.all.groups).toContainEqual(expect.objectContaining({ label: goal.name, taskIds: [running.id] }));
  expect(model.queue.rows.find((row: { taskId: string }) => row.taskId === running.id)).toMatchObject({ stateLabel: 'Active', goalNotice: 'Goal done' });
  expect(model.queue.rows.find((row: { taskId: string }) => row.taskId === waiting.id)).toMatchObject({ stateLabel: 'On hold · Queued', meta: 'feature · Asks · Ordered by you', waitingLine: 'Waiting on: missing_dependency' });
});

test('goal editor saves retain revision guards and engine state choices', async () => {
  const { f, work, goal } = await setup();
  const response = await f.request(`/api/projects/project/goals/${goal.id}/editor`); expect(response.status).toBe(200); const editor = await response.json();
  expect(editor.choices.states.map((row: { value: string }) => row.value)).toEqual(['active', 'paused']);
  const request = { ...editor.request.base, fields: { ...editor.defaults, name: 'Edited goal', openPrCap: '4' } };
  expect((await f.request(editor.request.path, 'POST', request)).status).toBe(200);
  expect((await f.request(editor.request.path, 'POST', request)).status).toBe(409);
  expect((await work.goalList('project')).goals[0]?.goal).toMatchObject({ name: 'Edited goal', openPrCap: 4 });
});


test('goal editor normalization rejects empty numbers and unknown fields without mutation', async () => {
  const { f, work } = await setup(), editor = await (await f.request('/api/projects/project/goals/editor')).json();
  for (const fields of [{ ...editor.defaults, dailyRefillCap: '' }, { ...editor.defaults, openPrCap: '2.5' }, { ...editor.defaults, unknownField: true }]) {
    expect((await f.request(editor.request.path, 'POST', { ...editor.request.base, fields: { ...fields, name: 'Invalid fixture', motivation: 'Must not be stored.' } })).status).toBe(400);
  }
  expect((await work.goalList('project')).goals).toHaveLength(1);
});

test('goal view completion refusal uses the same reserved-start guard as the writer', async () => {
  const { f, work, goal } = await setup();
  await work.tasks.save(fixtureTask('view_reserved', 'Reserved start', { projectId: 'project', revision: 0, goalId: goal.id, dispatchText: 'Fixture reserved work.' }));
  const model = await view(f), done = model.rows[0].actions.find((row: { name: string }) => row.name === 'done');
  expect(done.enabled).toBe(false); expect(done.refusal).toContain('reserved start');
  expect((await f.request(done.request.path, 'POST', done.request.body)).status).toBe(409);
  expect((await work.goalList('project')).goals[0]?.goal.state).toBe('active');
});

test('owner editor saves forward to the member coordinator without writing on the hub', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f); member.fake.capabilities.readOnlyEnforced = true;
  await f.app.projectWork.prepareDailyWork('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await member.request('/api/projects/project/coordinator/move', 'POST', { schema: 'empty-request-v1' })).status).toBe(200); await member.app.projectWork.idle();
  const editor = await (await f.request('/api/projects/project/goals/editor')).json();
  const hubCreate = vi.spyOn(f.app.projectWork.goals, 'create'), memberCreate = vi.spyOn(member.app.projectWork.goals, 'create');
  const request = { ...editor.request.base, fields: { ...editor.defaults, name: 'Member editor goal', motivation: 'Keep its canonical writer on the coordinator.' } };
  expect(await f.app.ownerTools.call('goals', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'save', args: { project: 'project', request } })).toMatchObject({ ok: true, data: { goal: { name: 'Member editor goal' } } });
  expect(hubCreate).not.toHaveBeenCalled(); expect(memberCreate).toHaveBeenCalledOnce();
});
