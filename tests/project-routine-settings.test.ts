import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function view(f: ProjectFixture) {
  const response = await f.request('/api/projects/project/routine-settings'); expect(response.status).toBe(200); return response.json();
}

test('routine settings metadata supplies modes, command-only slot patches and canonical limits without resetting the draft mode', async () => {
  const f = fixture = await projectFixture(), daily = f.app.projectWork.daily;
  const command = await daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'routine_settings_command', name: 'Fixture command', enabled: false,
    goalId: null, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  await daily.restoreRetiredJob('project', { schema: 'job-create-request-v1', clientRequestId: 'routine_settings_retired', name: 'Retired fixture', enabled: false,
    goalId: null, gate: null, run: { kind: 'github-workflow', workflow: 'old.yml', mode: 'watch', timeoutMinutes: 5 } });
  const model = await view(f);
  expect(model).toMatchObject({ schema: 'project-routine-settings-view-v1', projectId: 'project', routines: { refill: { min: 10, max: 1440 } },
    automation: { fields: { deployPaused: false, debounceMinutes: '10', catchUpHours: '4' }, constraints: { debounceMinutes: { min: 1, max: 30 }, catchUpHours: { min: 0, max: 12 } } } });
  expect(model.deploy.modes.map((row: { value: string }) => row.value)).toEqual(['approve', 'nightly', 'automatic']);
  expect(model.deploy.modes.map((row: { disabled: boolean }) => row.disabled)).toEqual([false, true, true]);
  expect(model.deploy.modeNotice).toBe("Change through config when you're ready.");
  const slot = model.deploy.slots.find((row: { key: string }) => row.key === 'jobId');
  expect(slot.choices.map((row: { value: string }) => row.value)).toEqual(['', command.id]);
  const patch = slot.choices.find((row: { value: string }) => row.value === command.id).patch;
  expect(patch).toEqual({ jobId: command.id }); expect(slot.choices[0].patch).toEqual({ jobId: null });
  expect({ mode: 'automatic', jobId: null, desktopJobId: null, suiteJobId: null, ...patch }).toEqual({ mode: 'automatic', jobId: command.id, desktopJobId: null, suiteJobId: null });
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'routines', args: { project: 'project' } })).toMatchObject({ ok: true, data: model });
});

test('UI and config tool normalize the same automation preferences and preserve unrelated settings', async () => {
  const f = fixture = await projectFixture();
  f.app.ownerTools.updateProjectSettings('project', current => ({ ...current, push: { ...current.push, batchSeconds: 120 } }));
  const before = await view(f), fields = { deployPaused: true, debounceMinutes: '7', catchUpHours: '6' };
  const response = await f.request(before.automation.request.path, 'POST', { ...before.automation.request.base, fields }); expect(response.status).toBe(200);
  const saved = await response.json(); expect(saved.automation.fields).toEqual(fields);
  expect(f.app.ownerTools.projectSettings('project')).toMatchObject({ deploy: { paused: true, debounceMinutes: 7 }, night: { catchUpHours: 6 }, push: { batchSeconds: 120 } });
  const result = await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'routines_save', args: {
    project: 'project', request: { ...saved.automation.request.base, fields: { ...fields, deployPaused: false, debounceMinutes: '8' } },
  } });
  expect(result).toMatchObject({ ok: true, data: { automation: { fields: { deployPaused: false, debounceMinutes: '8', catchUpHours: '6' } } } });
  expect(f.app.ownerTools.projectSettings('project').push.batchSeconds).toBe(120);
});

test('automation saves reject stale revisions and out-of-range values without changing any preference', async () => {
  const f = fixture = await projectFixture(), before = await view(f), request = { ...before.automation.request.base, fields: before.automation.fields };
  f.app.ownerTools.updateProjectSettings('project', current => ({ ...current, deploy: { ...current.deploy, paused: true } }));
  expect((await f.request(before.automation.request.path, 'POST', request)).status).toBe(409);
  const current = await view(f);
  expect((await f.request(current.automation.request.path, 'POST', { ...current.automation.request.base, fields: { ...current.automation.fields, debounceMinutes: '31' } })).status).toBe(400);
  expect((await f.request(current.automation.request.path, 'POST', { ...current.automation.request.base, fields: { ...current.automation.fields, catchUpHours: ' ' } })).status).toBe(400);
  expect((await view(f)).automation).toEqual(current.automation);
});

test('member UI automation reads and saves reach the state-point namespace through the existing owner-tool forward', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const response = await member.request('/api/projects/project/routine-settings'); expect(response.status).toBe(200); const model = await response.json();
  expect((await member.request(model.automation.request.path, 'POST', { ...model.automation.request.base, fields: { ...model.automation.fields, catchUpHours: '9' } })).status).toBe(200);
  expect((await view(f)).automation.fields.catchUpHours).toBe('9');
  expect(f.app.ownerTools.projectSettings('project').night.catchUpHours).toBe(9);
});

test('config routine fields and the UI share nightly-window and refill state and validation', async () => {
  const f = fixture = await projectFixture();
  for (const [key, value] of [['nightlyWindow.enabled', true], ['nightlyWindow.time', '04:30'], ['nightlyWindow.timezone', 'UTC'], ['refill.enabled', false], ['refill.minIntervalMinutes', 90]] as const) {
    expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'routines', key, value } })).toMatchObject({ ok: true });
  }
  const response = await f.request('/api/projects/project/work-settings'); expect(response.status).toBe(200); const { settings } = await response.json();
  expect(settings).toMatchObject({ nightlyWindow: { enabled: true, time: '04:30', timezone: 'UTC' }, refill: { enabled: false, minIntervalMinutes: 90 }, deploy: { mode: 'approve' } });
  const bad = await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'routines', key: 'nightlyWindow.time', value: '25:00' } });
  expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
  expect((await f.app.projectWork.settingsView('project')).settings).toEqual(settings);
});

test('config deploy slots use the same command choices as the UI without changing mode or other slots', async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  const job = await work.daily.createJob('project', { schema: 'job-create-request-v1', clientRequestId: 'config_slot', name: 'Fixture command', enabled: false,
    goalId: null, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'deploy', key: 'mode', value: 'automatic' } })).toMatchObject({ ok: true });
  for (const key of ['jobId', 'desktopJobId', 'suiteJobId']) {
    expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'deploy', key, value: job.id } })).toMatchObject({ ok: true });
  }
  expect((await work.settingsView('project')).settings.deploy).toEqual({ mode: 'automatic', jobId: job.id, desktopJobId: job.id, suiteJobId: job.id });
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'deploy', key: 'jobId', value: 'none' } })).toMatchObject({ ok: true });
  const before = (await work.settingsView('project')).settings;
  expect(before.deploy).toEqual({ mode: 'automatic', jobId: null, desktopJobId: job.id, suiteJobId: job.id });
  expect(await f.app.ownerTools.call('config', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'set', args: { project: 'project', section: 'deploy', key: 'jobId', value: 'not_a_project_job' } })).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
  expect((await work.settingsView('project')).settings).toEqual(before);
});
