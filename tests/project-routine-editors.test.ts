import { afterEach, expect, test, vi } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });

test('the job editor read model owns defaults, canonical limits and the retry request', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/jobs/editor'); expect(response.status).toBe(200);
  const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-job-editor-v1', projectId: 'project', title: 'New job', readonly: false,
    defaults: { name: '', enabled: true, command: '', needs: '', cwd: 'checkout', timeoutMinutes: '30', intervalEnabled: false },
    constraints: { nameMax: 80, commandMax: 2000, timeoutMinutes: { min: 1, max: 600 } },
    request: { path: '/api/projects/project/jobs/editor', base: { schema: 'job-editor-create-request-v1' } } });
  expect(view.request.base.clientRequestId).toBeTruthy();
  const result = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'editor', args: { project: 'project', kind: 'job' } });
  expect(result).toMatchObject({ ok: true, data: { schema: view.schema, defaults: view.defaults, constraints: view.constraints, choices: view.choices } });
});

test('job editor saves normalize canonical fields and UI/tool retries create the same definition', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/jobs/editor'); expect(response.status).toBe(200); const view = await response.json();
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'Editor fixture', command: 'printf fixture-only', needs: 'linux, mac', cwd: 'workspace', timeoutMinutes: '600' } };
  const saved = await f.request(view.request.path, 'POST', request); expect(saved.status).toBe(201); const job = await saved.json();
  expect(job).toMatchObject({ name: 'Editor fixture', goalId: null, enabled: true, gate: null,
    run: { kind: 'command', command: 'printf fixture-only', needs: ['linux', 'mac'], cwd: 'workspace', timeoutMinutes: 600 } });
  const tool = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'save', args: { project: 'project', request } });
  expect(tool).toMatchObject({ ok: true, data: job });
  expect((await f.app.projectWork.daily.jobs('project')).map(row => row.id)).toEqual([job.id]);
  const invalid = await f.request(view.request.path, 'POST', { ...request, clientRequestId: 'invalid_editor', fields: { ...request.fields, needs: 'INVALID-TAG' } });
  expect(invalid.status).toBe(400);
  expect((await f.app.projectWork.daily.jobs('project')).map(row => row.id)).toEqual([job.id]);
});

test('editing a job preserves paused scheduling and refuses stale field replacement', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'edit_existing', name: 'Existing fixture', enabled: false, paused: true,
    goalId: null, gate: null, interval: { everyMinutes: 15, start: '08:00', end: '23:00' }, run: { kind: 'command', command: 'printf fixture-only', timeoutMinutes: 5,
      deliveryGate: { id: 'delivery_guard', command: 'true', timeoutMinutes: 1, protectedPaths: ['guarded.txt'] } } });
  const response = await f.request(`/api/projects/project/jobs/${job.id}/editor`); expect(response.status).toBe(200); const view = await response.json();
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'Edited fixture' } };
  const saved = await f.request(view.request.path, 'POST', request); expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ id: job.id, name: 'Edited fixture', paused: true, enabled: false, interval: job.interval, run: job.run });
  expect((await f.request(view.request.path, 'POST', request)).status).toBe(409);
  expect((await work.daily.jobs('project'))[0]!.name).toBe('Edited fixture');
});

test('nightly editor requests normalize work kinds and empty days through the canonical writer', async () => {
  const f = fixture = await projectFixture();
  const response = await f.request('/api/projects/project/dailies/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-daily-editor-v1', title: 'New nightly item', defaults: { kind: 'job', order: '0', type: 'review', days: [] } });
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'Night editor fixture', enabled: false, kind: 'session', title: 'Fixture work', brief: 'Fixture only.', order: '2' } };
  const saved = await f.request(view.request.path, 'POST', request); expect(saved.status).toBe(201); const daily = await saved.json();
  expect(daily).toMatchObject({ name: 'Night editor fixture', order: 2, goalId: null, enabled: false, target: { kind: 'session', title: 'Fixture work', brief: 'Fixture only.', type: 'review' } });
  expect(daily.days).toBeUndefined();
  expect(await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'save', args: { project: 'project', request } })).toMatchObject({ ok: true, data: daily });
});

test('job gate choices and writes use the same cycle guard', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const values = { name: 'Parent fixture', goalId: null, enabled: false, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } };
  const parent = await work.daily.createJob('project', { ...values, schema: 'job-create-request-v1', clientRequestId: 'gate_parent' });
  const child = await work.daily.createJob('project', { ...values, name: 'Child fixture', gate: { jobId: parent.id }, schema: 'job-create-request-v1', clientRequestId: 'gate_child' });
  const view = await (await f.request(`/api/projects/project/jobs/${parent.id}/editor`)).json();
  expect(view.choices.gates.some((row: { value: string }) => row.value === parent.id)).toBe(false);
  expect(view.choices.gates.find((row: { value: string }) => row.value === child.id)).toMatchObject({ disabled: true, refusal: 'Job gates cannot contain a cycle.' });
  const response = await f.request(view.request.path, 'POST', { ...view.request.base, fields: { ...view.defaults, gate: child.id } });
  expect(response.status).toBe(400); expect((await f.app.projectHub.job(parent.id))!.document.gate).toBeNull();
});

test('retired jobs stay read-only in the editor and cannot be converted by a form save', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.restoreRetiredJob('project', { schema: 'job-create-request-v1', clientRequestId: 'retired_editor', name: 'Retired fixture', enabled: false,
    goalId: null, gate: null, run: { kind: 'github-workflow', workflow: 'old.yml', mode: 'watch', timeoutMinutes: 5 } });
  const response = await f.request(`/api/projects/project/jobs/${job.id}/editor`); expect(response.status).toBe(200); const view = await response.json();
  expect(view.readonly).toBe(true); expect(view.notice).toContain('Its receipts remain available.');
  expect((await f.request(view.request.path, 'POST', { ...view.request.base, fields: { ...view.defaults, command: 'true' } })).status).toBe(400);
  expect((await f.app.projectHub.job(job.id))!.document.run.kind).toBe('github-workflow');
});

test('nightly editor choices retain canonical review-goal restrictions and kind-specific fields', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const ordinary = await work.createGoal('project', { schema: 'goal-create-request-v1', clientRequestId: 'ordinary_goal', name: 'General fixture', motivation: 'Fixture only.' });
  const review = await work.createGoal('project', { schema: 'goal-create-request-v1', clientRequestId: 'review_goal', name: 'Resilience', motivation: 'Fixture only.' });
  const view = await (await f.request('/api/projects/project/dailies/editor')).json();
  expect(view.choices.goalsByKind['review-since-last'].find((row: { value: string }) => row.value === ordinary.goal.id)).toMatchObject({ disabled: true });
  expect(view.choices.goalsByKind['review-since-last'].find((row: { value: string }) => row.value === review.goal.id)).toMatchObject({ disabled: false });
  expect(view.fieldsByKind['review-since-last']).toEqual({ job: false, session: false, review: true });
  expect(view.fieldsByKind['memory-dream']).toEqual({ job: false, session: false, review: false });
  expect(view.notesByKind['memory-dream']).not.toContain('other provider');
});

test('UI and tool form saves run on the member coordinator through the normal owner route', async () => {
  const f = fixture = await projectFixture({ coordinator: true }), member = await projectMember(f);
  member.fake.capabilities.readOnlyEnforced = true;
  await f.app.projectWork.prepareDailyWork('project'); await f.app.projectWork.pulse(); await f.app.projectWork.idle();
  expect((await member.request('/api/projects/project/coordinator/move', 'POST', { schema: 'empty-request-v1' })).status).toBe(200);
  await member.app.projectWork.idle();
  const hubSave = vi.spyOn(f.app.projectWork, 'saveRoutineEditor'), memberSave = vi.spyOn(member.app.projectWork, 'saveRoutineEditor');
  const response = await f.request('/api/projects/project/jobs/editor'); expect(response.status).toBe(200); const view = await response.json();
  const request = { ...view.request.base, fields: { ...view.defaults, name: 'Remote fixture', command: 'true', enabled: false } };
  expect((await f.request(view.request.path, 'POST', request)).status).toBe(201);
  expect(await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'save', args: { project: 'project', request } })).toMatchObject({ ok: true });
  expect(hubSave).not.toHaveBeenCalled(); expect(memberSave).toHaveBeenCalledTimes(2);
  expect((await f.app.projectWork.daily.jobs('project')).map(row => row.name)).toEqual(['Remote fixture']);
});
