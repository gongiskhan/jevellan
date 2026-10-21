import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { DeviceSchema, ProjectSettingsEditorSchema, ProjectPrAutoFixSettingsSchema, ProjectWorkSettingsSchema, SessionCheckpointSettingsSchema } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
const path = '/api/projects/project/config/editor';

test('project settings controls expose canonical numeric bounds and automatic-fix choices', async () => {
  const f = fixture = await projectFixture(), response = await f.request(path); expect(response.status).toBe(200);
  const view = await response.json(); expect(view.controls, 'The engine supplies settings controls.').toBeDefined();
  expect(view.controls.schema).toBe('project-settings-controls-v1');
  const shape = ProjectWorkSettingsSchema.shape;
  const numbers = { maxRunningThreads: shape.maxRunningThreads, maxRunningPerDevice: shape.maxRunningPerDevice, threadTurnCap: shape.threadTurnCap,
    maxNewThreadsPerDay: shape.maxNewThreadsPerDay.removeDefault(), compactAtPercent: shape.compactAtPercent.removeDefault(), coordinatorHandoffAtPercent: shape.coordinatorHandoffAtPercent.removeDefault(),
    checkpointMinTokens: SessionCheckpointSettingsSchema.shape.checkpointMinTokens, perDeviceLimit: shape.perDeviceLimits.removeDefault().valueType, maxRounds: ProjectPrAutoFixSettingsSchema.shape.maxRounds };
  for (const [key, schema] of Object.entries(numbers)) {
    const json = z.toJSONSchema(schema); expect(view.controls.numbers[key]).toMatchObject({ min: json.minimum, max: json.maximum, step: 1 });
  }
  expect(view.controls.startModes).toEqual([{ value: 'start', label: 'Start threads right away' }, { value: 'propose', label: 'Propose threads and wait for me' }]);
  expect(view.controls.automaticFixes).toEqual([{ key: 'checks', label: 'Fix failing checks automatically' }, { key: 'conflicts', label: 'Resolve conflicts automatically' }, { key: 'comments', label: 'Address review comments automatically' }]);
  expect(view.controls.riskyAreasMaxLength).toBe(z.toJSONSchema(shape.riskyAreas.removeDefault()).maxLength);
  const { controls: _controls, ...old } = view; void _controls; expect(ProjectSettingsEditorSchema.safeParse(old).success).toBe(true);
  expect(ProjectSettingsEditorSchema.safeParse({ ...view, controls: { ...view.controls, unexpected: true } }).success).toBe(false);
  expect(f.fake.runs).toHaveLength(0);
});

test('settings device-limit offers share the hub roster and exclude apps-only and revoked devices', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const read = async () => { const response = await f.request(path); expect(response.status).toBe(200); return (await response.json()).controls; };
  const initial = await read(); expect(initial, 'The engine supplies eligible device controls.').toBeDefined();
  expect(initial.devices.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([f.app.device.deviceId, member.deviceId]));
  const remote = await member.request(path); expect(remote.status).toBe(200); expect((await remote.json()).controls).toEqual(initial);
  const device = f.app.hub.get('devices', member.deviceId, DeviceSchema)!;
  f.app.hub.put('devices', member.deviceId, DeviceSchema, { ...device.document, workPolicy: { schema: 'device-work-policy-v1', mode: 'apps-only' } }, device.revision);
  expect((await read()).devices.some((row: { id: string }) => row.id === member.deviceId)).toBe(false);
  const appsOnly = f.app.hub.get('devices', member.deviceId, DeviceSchema)!;
  f.app.hub.put('devices', member.deviceId, DeviceSchema, device.document, appsOnly.revision);
  expect((await read()).devices.some((row: { id: string }) => row.id === member.deviceId)).toBe(true);
  f.app.mesh.devices.revoke(member.deviceId);
  expect((await read()).devices.some((row: { id: string }) => row.id === member.deviceId)).toBe(false);
});

test('normal settings saves enforce bounds and can clear a per-device override', async () => {
  const f = fixture = await projectFixture(), base = (await f.app.projectWork.settingsView('project')).settings;
  const invalid = [{ ...base, maxRunningThreads: 21 }, { ...base, maxRunningPerDevice: 0 }, { ...base, threadTurnCap: 4 },
    { ...base, compactAtPercent: 49 }, { ...base, sessionCheckpoints: { ...base.sessionCheckpoints, checkpointMinTokens: 19999 } },
    { ...base, prAutoFix: { ...base.prAutoFix, maxRounds: 11 } }, { ...base, riskyAreas: 'x'.repeat(2001) }];
  for (const [index, draft] of invalid.entries()) {
    expect((await f.request(path, 'POST', { schema: 'project-settings-editor-save-v1', clientRequestId: `invalid_controls_${index}`, base, draft, secretPresence: {} })).status).toBe(400);
    expect((await f.app.projectWork.settingsView('project')).settings).toEqual(base);
  }
  const draft = { ...base, perDeviceLimits: { [f.app.device.deviceId]: 2 }, startMode: 'propose', prAutoFix: { ...base.prAutoFix, checks: false, maxRounds: 10 } };
  const saved = await f.request(path, 'POST', { schema: 'project-settings-editor-save-v1', clientRequestId: 'controls_override', base, draft, secretPresence: {} });
  expect(saved.status).toBe(200); const current = (await saved.json()).settingsView.settings;
  expect(current).toMatchObject({ perDeviceLimits: { [f.app.device.deviceId]: 2 }, startMode: 'propose', prAutoFix: { checks: false, maxRounds: 10 } });
  const cleared = await f.request(path, 'POST', { schema: 'project-settings-editor-save-v1', clientRequestId: 'controls_clear', base: current, draft: { ...current, perDeviceLimits: {} }, secretPresence: {} });
  expect(cleared.status).toBe(200); expect((await cleared.json()).settingsView.settings.perDeviceLimits).toEqual({});
});
