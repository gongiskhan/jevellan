import { afterEach, expect, test } from 'vitest';
import { COORDINATOR_TOOLS, GoalListViewSchema, GoalViewSchema, TaskCreateRequestSchema, type CoordinatorEvent } from '../packages/core/dist/index.js';
import { ProjectGoals, ProjectTasks } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture(); await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  let now = Date.parse('2026-10-24T15:00:00Z'), available = true, windowOpen = false;
  const events: CoordinatorEvent[] = [], goals = new ProjectGoals({ hub: f.app.projectHub, tasks: undefined as never, redactor: f.app.redactor, now: () => now,
    settings: id => f.app.projectWork.admission.settings(id), available: async () => available, windowOpen: async () => windowOpen, event: async (_id, event) => { if (!events.some(row => row.id === event.id)) events.push(event); } });
  const tasks = new ProjectTasks({ hub: f.app.projectHub, deviceId: f.app.device.deviceId, redactor: f.app.redactor, now: () => now,
    validateGoal: (project, goal, source, event) => goals.validate(project, goal, source, event), projectDay: id => goals.day(id) });
  goals.o.tasks = tasks;
  const create = async (id: string, goalId: string | null, source: 'owner' | 'refill' | 'finding' = 'owner', eventId?: string) => {
    const receipt = await tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: id, title: id, brief: 'Complete the scoped work.', goalId }), source, eventId ? { refillEventId: eventId } : {});
    return tasks.read('project', receipt.taskId);
  };
  return { f, goals, tasks, create, events, advance: (ms: number) => { now += ms; }, availability: (value: boolean) => { available = value; }, window: (value: boolean) => { windowOpen = value; } };
}
const goalInput = (id: string, over: object = {}) => ({ schema: 'goal-create-request-v1', clientRequestId: id, name: 'Hardening through tests', motivation: 'Protect the family livelihood.', health: 'Tests exercise the paths people rely on.', ...over });

test('only owner operations define goals; edits preserve identity and idempotent creation does not restore old content', async () => {
  const { f, goals } = await setup(); const first = await goals.create('project', goalInput('first'));
  expect(first.goal).toMatchObject({ autonomy: 'propose', dailyRefillCap: 3, openPrCap: 2, state: 'active' });
  const edited = await goals.update('project', first.goal.id, { schema: 'goal-update-request-v1', expectedRevision: first.goal.revision, state: 'paused', motivation: 'Owner correction.' });
  expect((await goals.create('project', goalInput('first'))).goal).toEqual(edited.goal);
  await expect(goals.create('project', goalInput('first', { name: 'Other goal' }))).rejects.toMatchObject({ status: 409 });
  await expect(goals.update('project', first.goal.id, { schema: 'goal-update-request-v1', expectedRevision: first.goal.revision, state: 'done' })).rejects.toMatchObject({ status: 409 });
  expect(COORDINATOR_TOOLS).toContain('jevellan_goals_list'); expect(COORDINATOR_TOOLS.some(name => /goal_(create|update)/u.test(name))).toBe(false);
  const response = await f.request('/api/projects/project/goals', 'POST', goalInput('api'));
  expect(response.status).toBe(201); const apiGoal = GoalViewSchema.parse(await response.json());
  expect(GoalListViewSchema.parse(await (await f.request('/api/projects/project/goals')).json()).goals).toHaveLength(2);
  const unauthenticated = await fetch(`${f.app.projectWork.daemonUrl}/api/projects/project/goals`, { method: 'POST', body: JSON.stringify(goalInput('unauthenticated')), headers: { 'content-type': 'application/json' } });
  expect(unauthenticated.status).toBe(401); expect(apiGoal.goal.motivation).toBe('Protect the family livelihood.');
});

test('refill asks an available idle coordinator once, makes one draft per listed goal and respects the project day cap', async () => {
  const { goals, tasks, create, events, advance, availability, window } = await setup(); const { goal } = await goals.create('project', goalInput('one', { dailyRefillCap: 1 }));
  availability(false); await goals.sweep('project'); expect(events).toHaveLength(0);
  availability(true); window(true); await goals.sweep('project'); expect(events).toHaveLength(0);
  window(false); await Promise.all([goals.sweep('project'), goals.sweep('project')]); expect(events).toHaveLength(1);
  const event = events[0]!; expect(event).toMatchObject({ kind: 'goal-refill', goals: [{ goalId: goal.id, cap: 1, refillsToday: 0 }] });
  await expect(create('bad', goal.id, 'refill')).rejects.toMatchObject({ status: 403 });
  const draft = await create('proposal', goal.id, 'refill', event.id); expect(draft.state).toBe('draft');
  await expect(create('duplicate', goal.id, 'refill', event.id)).rejects.toMatchObject({ status: 409 });
  const approved = await tasks.action('project', draft.id, { schema: 'task-action-request-v1', expectedRevision: draft.revision, action: 'approve' });
  await tasks.save({ ...approved, state: 'done', endedAt: tasks.at() }); advance(31 * 60_000); await goals.sweep('project'); expect(events).toHaveLength(1);
  expect((await goals.view('project')).goals[0]?.counts.refillsToday).toBe(1);
  // Lisbon's fall-back day has a 25-hour duration. The next closing boundary resets the refill cap.
  advance(26 * 3_600_000); await goals.sweep('project'); expect(events).toHaveLength(2);
});

test('paused/done goals, one active session and open pull-request caps gate dispatch while Asks remain eligible', async () => {
  const { goals, tasks, create } = await setup(), { goal } = await goals.create('project', goalInput('caps', { autonomy: 'auto', openPrCap: 1 }));
  const a = await create('a', goal.id), b = await create('b', goal.id), ask = await create('ask', null);
  expect(await goals.eligible(b, [a, b])).toBe(true);
  const active = await tasks.save({ ...a, state: 'active' }); expect(await goals.eligible(b, [active, b])).toBe(false); expect(await goals.eligible(ask, [active, ask])).toBe(true);
  const pending = await tasks.save({ ...active, state: 'queued', dispatchText: 'Frozen after an interrupted remote start.' }); expect(await goals.eligible(b, [pending, b])).toBe(false); expect(await goals.eligible(pending, [pending, b])).toBe(true);
  const reviewed = await tasks.save({ ...pending, state: 'in-review' }); expect(await goals.eligible(b, [reviewed, b])).toBe(false);
  await tasks.save({ ...reviewed, state: 'done' }); const paused = await goals.update('project', goal.id, { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state: 'paused' });
  expect(await goals.eligible(b, await tasks.list('project'))).toBe(false); expect((await tasks.read('project', b.id)).state).toBe('queued');
  await goals.update('project', goal.id, { schema: 'goal-update-request-v1', expectedRevision: paused.goal.revision, state: 'done' }); expect(await goals.eligible(b, await tasks.list('project'))).toBe(false);
  await expect(create('foreign', 'goal_missing')).rejects.toMatchObject({ status: 404 });
});


test('disabled windows use midnight and enabled windows use their local closing time', async () => {
  const { f, goals, advance } = await setup();
  advance(8 * 3_600_000 + 30 * 60_000); // October 25, 00:30 Lisbon before fall-back.
  const settings = await f.app.projectWork.admission.settings('project');
  await f.app.projectHub.putSettings({ ...settings, nightlyWindow: { ...settings.nightlyWindow, enabled: false } }, (await f.app.projectHub.settings('project'))?.revision ?? 0);
  expect(await goals.day('project')).toBe('2026-10-25');
  const current = await f.app.projectHub.settings('project');
  await f.app.projectHub.putSettings({ ...current!.document, nightlyWindow: { enabled: true, time: '02:00', timezone: 'Europe/Lisbon' } }, current!.revision);
  expect(await goals.day('project')).toBe('2026-10-24');
});
