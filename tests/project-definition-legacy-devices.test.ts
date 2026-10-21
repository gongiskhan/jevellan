import { afterEach, expect, test } from 'vitest';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

test('project definition controls retain retired device paths and optional-all conversion without granting execution', async () => {
  f = await projectFixture(); const member = await projectMember(f); f.app.devices.revoke(member.deviceId);
  const response = await f.request('/api/projects/editor?projectId=project'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.devices.find((row: { id: string }) => row.id === member.deviceId)).toMatchObject({ id: member.deviceId, required: false, checked: true });
  expect(view.fields.paths[member.deviceId]).toBe(member.checkout);
  const changed = await f.request('/api/projects/editor/preview', 'POST', { schema: 'project-definition-preview-v1', context: view.context, fields: view.fields, command: { type: 'device', deviceId: f.app.device.deviceId, checked: false } }); expect(changed.status).toBe(200);
  expect((await changed.json()).fields.allowedDevices).toContain(member.deviceId);
  expect((await f.app.roster()).devices.find(row => row.device.id === member.deviceId)?.revoked).toBe(true);
  await expect(f.app.saveProjectDefinition({ schema: 'project-definition-save-v1', context: view.context, fields: view.fields, clientRequestId: 'retired_device_execution' }, member.deviceId)).rejects.toMatchObject({ status: 409 });
  expect(f.fake.runs).toHaveLength(0); expect(member.fake.runs).toHaveLength(0);
});
