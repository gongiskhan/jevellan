import { afterEach, expect, test, vi } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('settings workspace assembles the existing readers and navigation without starting work', async () => {
  f = await projectFixture(); const before = await f.app.configuration(), roster = await f.app.roster();
  const retired = { ...roster.devices[0]!, device: { ...roster.devices[0]!.device, id: 'device_retired', name: 'Retired fixture' }, revoked: true };
  vi.spyOn(f.app, 'roster').mockResolvedValue({ ...roster, devices: [...roster.devices, retired] });
  const response = await f.request('/api/config/workspace'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'settings-workspace-v1', config: before, navigation: { schema: 'settings-navigation-v1', defaultPage: 'runtimes' }, configurationWrite: { path: '/hub/config', method: 'PUT', body: { schema: 'config-write-v1', revision: before.revision }, savedNotice: 'Settings saved.' } });
  expect(view.navigation.pages.map((row: { id: string }) => row.id)).toEqual(['runtimes', 'notifications', 'rigging', 'decisions', 'improver', 'devices', 'projects', 'git', 'ekoa', 'agents', 'cleanup', 'configuration', 'about']);
  expect(view.devices).toEqual({ currentDeviceId: roster.currentDeviceId, devices: [...roster.devices.map(row => row.device), retired.device] });
  expect(view.accounts).toEqual((await (await f.request('/hub/accounts')).json()).accounts);
  expect(view.runtimes).toEqual((await (await f.request('/api/runtimes')).json()).runtimes);
  expect(view.rigging).toEqual(await (await f.request('/hub/rigging')).json());
  expect(view.jev).toEqual(await f.app.state.jev.summary()); expect(f.fake.runs).toHaveLength(0); expect(await f.app.configuration()).toEqual(before);
});

test('settings workspace save metadata retains the canonical configuration writer and revision guard', async () => {
  f = await projectFixture(); const response = await f.request('/api/config/workspace'); expect(response.status).toBe(200); const view = await response.json();
  const configuration = structuredClone(view.config.configuration); configuration['x-jevellan'].guards.pauseAfterPlan = !configuration['x-jevellan'].guards.pauseAfterPlan;
  const input = { ...view.configurationWrite.body, configuration, clientRequestId: 'workspace_save_fixture' };
  const savedResponse = await f.request(view.configurationWrite.path, view.configurationWrite.method, input); expect(savedResponse.status).toBe(200); const saved = await savedResponse.json();
  expect(saved.configuration).toEqual(configuration); expect(saved.changedBy.deviceId).toBe(f.app.device.deviceId);
  expect(await (await f.request('/hub/config', 'PUT', input)).json()).toEqual(saved);
  expect((await f.request('/hub/config', 'PUT', { ...input, clientRequestId: 'workspace_stale_fixture' })).status).toBe(409);
});

test('cleanup editor exposes canonical defaults and limits without running cleanup', async () => {
  f = await projectFixture(); const before = await f.app.configuration(), response = await f.request('/api/config/cleanup'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'cleanup-settings-editor-v1', revision: before.revision, fields: { logs: { days: '14', maxGb: '5' }, evidence: { days: '30', maxGb: '10' }, worktrees: { days: '3', maxGb: '20' }, workspaces: { days: '2', maxGb: '20' }, freeDiskFloorGb: '50' }, days: { min: 0, max: 3650, step: 1 }, maxGb: { min: 0, max: 10000, step: 'any' }, floor: { min: 0, max: 100000, step: 'any' }, write: { path: '/api/config/cleanup', method: 'PUT' }, savedNotice: 'Settings saved.' });
  expect(view.categories.map((row: { id: string }) => row.id)).toEqual(['logs', 'evidence', 'worktrees', 'workspaces']);
  expect(f.fake.runs).toHaveLength(0); expect(await f.app.configuration()).toEqual(before);
});

test('member cleanup saves preserve unrelated settings and recover receipts without overwriting newer work', async () => {
  f = await projectFixture(); const member = await projectMember(f), response = await member.request('/api/config/cleanup'); expect(response.status).toBe(200); const view = await response.json(), before = await f.app.configuration();
  const input = { schema: 'cleanup-settings-save-v1', revision: view.revision, fields: { ...view.fields, logs: { days: '15', maxGb: '5.5' } }, clientRequestId: 'cleanup_member_save' };
  const savedResponse = await member.request('/api/config/cleanup', 'PUT', input); expect(savedResponse.status).toBe(200); const saved = await savedResponse.json();
  expect(saved.changedBy.deviceId).toBe(member.deviceId); expect(saved.configuration['x-jevellan']).toEqual({ ...before.configuration['x-jevellan'], cleanup: { ...before.configuration['x-jevellan'].cleanup, logs: { days: 15, maxGb: 5.5 } } });
  const newer = structuredClone(saved.configuration); newer['x-jevellan'].routingProfile += '\nKeep this later fixture change.'; const latest = f.app.hub.configuration.put(newer, saved.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  expect(await (await member.request('/api/config/cleanup', 'PUT', input)).json()).toEqual(saved); expect(await f.app.configuration()).toEqual(latest);
  expect((await member.request('/api/config/cleanup', 'PUT', { ...input, fields: { ...input.fields, freeDiskFloorGb: '51' } })).status).toBe(409);
  expect((await member.request('/api/config/cleanup', 'PUT', { ...input, clientRequestId: 'cleanup_stale' })).status).toBe(409);
  expect(await (await member.request('/api/config/cleanup', 'PUT', { ...input, revision: latest.revision, clientRequestId: 'cleanup_noop' })).json()).toEqual(latest);
});

test('cleanup save rejects blank, nonfinite and out-of-range raw values before changing configuration', async () => {
  f = await projectFixture(); const response = await f.request('/api/config/cleanup'); expect(response.status).toBe(200); const view = await response.json(), before = await f.app.configuration();
  const input = { schema: 'cleanup-settings-save-v1', revision: view.revision, fields: view.fields, clientRequestId: 'cleanup_invalid' };
  for (const value of ['', ' ', '-1', '3651', '1.5', 'Infinity', '4x']) expect((await f.request('/api/config/cleanup', 'PUT', { ...input, fields: { ...view.fields, logs: { ...view.fields.logs, days: value } } })).status).toBe(400);
  for (const [key, value] of [['maxGb', '10001'], ['maxGb', 'NaN'], ['freeDiskFloorGb', '100001'], ['freeDiskFloorGb', '-1']]) {
    const fields = key === 'freeDiskFloorGb' ? { ...view.fields, [key!]: value } : { ...view.fields, evidence: { ...view.fields.evidence, [key!]: value } };
    expect((await f.request('/api/config/cleanup', 'PUT', { ...input, fields })).status).toBe(400);
  }
  expect((await f.request('/api/config/cleanup', 'PUT', { ...input, command: 'never' })).status).toBe(400); expect(await f.app.configuration()).toEqual(before);
});
