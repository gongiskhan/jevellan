import { afterEach, expect, test } from 'vitest';
import { defaultProjectWorkSettings, ProjectJobsViewSchema } from '../packages/core/dist/index.js';
import { checkEnvironmentProfile, projectCheckEnvironment } from '../packages/projects/dist/check-environment.js';
import { restoreFromVault, vaultDefinition } from '../packages/projects/dist/vault-definition.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('an absent check profile runs empty without inheriting work variables, secrets or files', () => {
  const settings = defaultProjectWorkSettings('project');
  settings.environment = { variables: [{ name: 'WORK_ONLY', value: 'synthetic-work-input' }], secrets: ['WORK_SECRET'], copyFiles: ['.env.local'] };
  const profile = checkEnvironmentProfile(settings);
  expect(profile).toEqual({ schema: 'project-check-environment-v1', variables: [], secrets: [], copyFiles: [] });
  expect(projectCheckEnvironment(profile, { WORK_SECRET: 'synthetic-work-secret' })).toEqual({});
  expect(settings.environment).toEqual({ variables: [{ name: 'WORK_ONLY', value: 'synthetic-work-input' }], secrets: ['WORK_SECRET'], copyFiles: ['.env.local'] });
});

const jobInput = { schema: 'job-create-request-v1', clientRequestId: 'reset_job', name: 'Credential-bound checks', goalId: null,
  enabled: true, gate: null, run: { kind: 'command', command: 'printf fixture-only', timeoutMinutes: 1 } };
const reason = 'Required check credentials are unavailable; paused during the project reset.';

test('a credential pause persists its reason across restart and clears it on explicit resume', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', jobInput);
  const response = await f.request(`/api/projects/project/jobs/${job.id}/paused`, 'POST', {
    schema: 'job-paused-request-v1', expectedRevision: job.revision, paused: true, pauseReason: reason,
  });
  expect(response.status).toBe(200);
  const paused = await response.json();
  expect(paused).toMatchObject({ run: job.run, gate: job.gate, enabled: true, paused: true, pauseReason: reason });
  await f.restart();
  const view = await f.json('/api/projects/project/jobs-view', ProjectJobsViewSchema);
  expect(view.jobs.find(row => row.definition.id === job.id)).toMatchObject({ definition: { paused: true, pauseReason: reason }, stateLabel: `Paused: ${reason}`,
    runNow: { enabled: false, refusal: expect.stringContaining(reason) } });
  const refused = await f.request(`/api/projects/project/jobs/${job.id}/run`, 'POST', { schema: 'project-run-request-v1', clientRequestId: 'reset_no_run' });
  expect(refused.status).toBe(409);
  expect((await f.app.projectWork.taskList('project')).tasks).toEqual([]);
  const resumed = await f.request(`/api/projects/project/jobs/${job.id}/paused`, 'POST', {
    schema: 'job-paused-request-v1', expectedRevision: paused.revision, paused: false,
  });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ run: job.run, paused: false, pauseReason: null });
});

test('a disabled nightly credential item keeps a visible reason without queuing work', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const daily = await work.daily.createDaily('project', { schema: 'daily-create-request-v1', clientRequestId: 'reset_daily',
    name: 'Credential-bound nightly review', goalId: null, order: 2, enabled: true,
    target: { kind: 'session', title: 'Read-only review', brief: 'Fixture only.', type: 'review' } });
  const response = await f.request(`/api/projects/project/dailies/${daily.id}/enabled`, 'POST', {
    schema: 'daily-enabled-request-v1', expectedRevision: daily.revision, enabled: false, pauseReason: reason,
  });
  expect(response.status).toBe(200);
  const paused = await response.json();
  expect(paused).toMatchObject({ target: daily.target, order: daily.order, enabled: false, pauseReason: reason });
  await f.restart();
  await f.app.projectWork.coordinators.ensureAssigned('project');
  await f.app.projectWork.daily.sweep('project');
  expect((await f.app.projectWork.taskList('project')).tasks).toEqual([]);
  const view = await f.json('/api/projects/project/jobs-view', ProjectJobsViewSchema);
  expect(view.dailies.find(row => row.definition.id === daily.id)).toMatchObject({ state: 'disabled', stateLabel: `Paused: ${reason}`,
    runNow: { enabled: false, refusal: expect.stringContaining(reason) } });
  const resumed = await f.request(`/api/projects/project/dailies/${daily.id}/enabled`, 'POST', {
    schema: 'daily-enabled-request-v1', expectedRevision: paused.revision, enabled: true,
  });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({ target: daily.target, enabled: true, pauseReason: null });
});

test('vault restoration retains a credential pause and interval instead of scheduling the job again', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const interval = { everyMinutes: 30, start: '01:00', end: '05:00' };
  const job = await work.daily.createJob('project', { ...jobInput, paused: true, interval });
  const definition = vaultDefinition({ ...f.project, remoteUrl: 'https://github.com/fixture/reset-policy' },
    defaultProjectWorkSettings('project'), [], [{ ...job, pauseReason: reason }], []);
  expect(definition.jobs[0]).toMatchObject({ paused: true, pauseReason: reason, interval });
  const restoredName = 'Restored credential-bound checks';
  await restoreFromVault(work, 'project', 'fixture__repository', { ...definition, jobs: [{ ...definition.jobs[0], name: restoredName }] }, null);
  expect((await work.daily.jobs('project')).find(row => row.name === restoredName)).toMatchObject({ run: job.run, paused: true, pauseReason: reason, interval });
  expect((await work.taskList('project')).tasks).toEqual([]);
});
