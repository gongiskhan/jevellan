import { afterEach, expect, test } from 'vitest';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { projectJobsView } from '../packages/projects/dist/jobs-view.js';
import { task as makeTask } from './helpers/owner-fixtures.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const definition = (key: string, extra: Record<string, unknown> = {}) => ({ schema: 'job-create-request-v1', clientRequestId: key,
  name: key, goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'printf fixture-only', timeoutMinutes: 1 }, ...extra });

test('jobs view supplies nightly row copy and action plans to the page and jobs tool', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', definition('view_job'));
  const daily = await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'view_daily', name: 'Night fixture',
    goalId: null, order: 7, days: ['mon', 'thu'], target: { kind: 'job', jobId: job.id }, enabled: true });
  const response = await f.request('/api/projects/project/jobs-view'); expect(response.status).toBe(200);
  const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-jobs-view-v1', projectId: 'project', counts: { nightly: 1, goals: 0 }, displayDay: { label: 'Project day' },
    dailies: [{ definition: { id: daily.id }, stateLabel: 'Not run today', kindLabel: 'Command', daysLabel: 'Mon, Thu',
      runNow: { enabled: true, refusal: null, path: `/api/projects/project/dailies/${daily.id}/run` },
      toggle: { path: `/api/projects/project/dailies/${daily.id}/enabled`, body: { schema: 'daily-enabled-request-v1', expectedRevision: daily.revision, enabled: false } } }] });
  const page = await (await f.request('/api/projects/project/status-view')).json(); expect(page.routines).toEqual(view);
  const tool = await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'night', args: { project: 'project' } });
  expect(tool).toMatchObject({ ok: true, data: view });
});

test('patch-only nightly enablement preserves fields and refuses a stale revision', async () => {
  const f = fixture = await projectFixture(), daily = await f.app.projectWork.daily.createDaily('project', {
    schema: 'daily-create-request-v1', clientRequestId: 'toggle_daily', name: 'Keep fixture fields', goalId: null, order: 7,
    days: ['thu'], target: { kind: 'session', title: 'Fixture', brief: 'Fixture only.', type: 'review' }, enabled: true,
  });
  const path = `/api/projects/project/dailies/${daily.id}/enabled`, body = { schema: 'daily-enabled-request-v1', expectedRevision: daily.revision, enabled: false };
  const response = await f.request(path, 'POST', body); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: daily.id, name: daily.name, goalId: daily.goalId, order: daily.order, days: daily.days, target: daily.target, enabled: false });
  expect((await f.request(path, 'POST', { ...body, enabled: true })).status).toBe(409);
  expect((await f.app.projectHub.daily(daily.id))!.document.enabled).toBe(false);
});

test('patch-only job pause and owner tools preserve the same definition', async () => {
  const f = fixture = await projectFixture(), job = await f.app.projectWork.daily.createJob('project', definition('pause_parity'));
  const response = await f.request(`/api/projects/project/jobs/${job.id}/paused`, 'POST', {
    schema: 'job-paused-request-v1', expectedRevision: job.revision, paused: true,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: job.id, name: job.name, run: job.run, paused: true });
  expect(await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'resume', args: { project: 'project', job: job.id } })).toMatchObject({ ok: true });
  expect((await f.app.projectHub.job(job.id))!.document).toMatchObject({ name: job.name, run: job.run, paused: false });
  expect(await f.app.ownerTools.call('jobs', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'pause', args: { project: 'project', job: job.id } })).toMatchObject({ ok: true });
  expect((await f.app.projectHub.job(job.id))!.document).toMatchObject({ name: job.name, run: job.run, paused: true });
});

test('a paused command job cannot be newly queued through Run now', async () => {
  const f = fixture = await projectFixture(), job = await f.app.projectWork.daily.createJob('project', definition('paused_fixture', { paused: true }));
  const response = await f.request(`/api/projects/project/jobs/${job.id}/run`, 'POST', { schema: 'project-run-request-v1', clientRequestId: 'paused_run' });
  expect(response.status).toBe(409);
  expect((await f.app.projectWork.taskList('project')).tasks).toEqual([]);
});

test('Run now cannot create work while the project is paused', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', definition('inactive_fixture'));
  const daily = await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'inactive_daily', name: 'Inactive daily',
    goalId: null, order: 0, target: { kind: 'job', jobId: job.id }, enabled: true });
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, status: 'paused' }, settings.revision);
  const response = await f.request(`/api/projects/project/jobs/${job.id}/run`, 'POST', { schema: 'project-run-request-v1', clientRequestId: 'inactive_run' });
  expect(response.status).toBe(409);
  expect((await f.request(`/api/projects/project/dailies/${daily.id}/run`, 'POST', { schema: 'project-run-request-v1', clientRequestId: 'inactive_daily_run' })).status).toBe(409);
  expect((await work.taskList('project')).tasks).toEqual([]);
});

test('nightly presentation keeps window precedence and project time while respecting any queued item', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const daily = await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'night_selection', name: 'Night selection',
    goalId: null, order: 0, target: { kind: 'session', title: 'Fixture', brief: 'Fixture only.', type: 'review' }, enabled: true });
  const raw = await work.daily.view('project'), settings = await work.admission.settings('project');
  const done = makeTask('night_done', 'Done', { projectId: 'project', dailyId: daily.id, state: 'done', projectDay: '2026-10-20', endedAt: '2026-10-20T23:15:00.000Z' });
  const failed = makeTask('night_failed', 'Failed', { projectId: 'project', dailyId: daily.id, state: 'failed', projectDay: '2026-10-20', endedAt: '2026-10-20T23:10:00.000Z', endNote: 'Fixture failure.' });
  const queued = makeTask('other_day_queued', 'Queued', { projectId: 'project', dailyId: daily.id, state: 'queued', projectDay: '2026-10-21' });
  const input = { ...raw, projectDay: '2026-10-21', tasks: [done, failed, queued], window: { schema: 'project-window-v1' as const, id: 'window_fixture', projectId: 'project', revision: 1,
    date: '2026-10-21', closingProjectDay: '2026-10-20', state: 'open' as const, memoryDreamPending: false, mergesHeld: true,
    openedAt: '2026-10-21T00:00:00.000Z', taskIds: [done.id, failed.id], plans: [] } };
  const view = projectJobsView(input, { ...settings, nightlyWindow: { ...settings.nightlyWindow, timezone: 'Europe/Lisbon' } }, []);
  expect(view.displayDay).toEqual({ date: '2026-10-20', label: 'Closing project day' });
  expect(view.dailies[0]).toMatchObject({ state: 'done', stateLabel: 'Done today at 00:15', tonight: { taskId: done.id }, runNow: { enabled: false } });
  const finished = projectJobsView({ ...input, mergesHeld: false, window: { ...input.window, state: 'finished', taskIds: [done.id, failed.id, 'skipped_task'] } }, settings, []);
  expect(finished.banner?.text).toBe('Last night: 1 of 3 nightly tasks passed.');
});

test('accepted Run-now receipts repeat after pause without creating another task', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', definition('repeat_after_pause'));
  await work.prepareDailyWork('project');
  work.daily.o.changed = () => {};
  const request = { schema: 'project-run-request-v1', clientRequestId: 'accepted_once' };
  const accepted = await work.daily.runJob('project', job.id, request);
  await work.daily.setPaused('project', job.id, { schema: 'job-paused-request-v1', expectedRevision: job.revision, paused: true });
  expect(await work.daily.runJob('project', job.id, request)).toMatchObject({ taskId: accepted.taskId, repeated: true });
  await expect(work.daily.runJob('project', job.id, { ...request, clientRequestId: 'new_after_pause' })).rejects.toThrow('This job is paused.');
  expect((await work.taskList('project')).tasks.map(task => task.id)).toEqual([accepted.taskId]);
});
