import { afterEach, expect, test } from 'vitest';
import { exportConfiguration } from '../packages/core/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
test('configuration editor orders history and owns revision and author labels', async () => {
  const f = fixture = await projectFixture(); let current = await f.app.configuration(); const initial = (await f.app.state.configuration.history()).map(row => row.revision);
  current = f.app.hub.configuration.put(current.configuration, current.revision, { deviceId: 'device_missing', source: 'ui' });
  current = f.app.hub.configuration.put(current.configuration, current.revision, { deviceId: f.app.device.deviceId, source: 'improver' });
  const response = await f.request('/api/config/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'configuration-editor-v1', revision: current.revision, yaml: { downloadPath: '/hub/config/export', downloadName: 'apm.yml' } });
  expect(view.rows.map((row: { revision: number }) => row.revision)).toEqual([current.revision, current.revision - 1, ...initial.reverse()]);
  expect(view.rows[0]).toMatchObject({ label: `Revision ${current.revision}`, sourceLabel: 'Jev' }); expect(view.rows[1]).toMatchObject({ deviceLabel: 'device_missing', sourceLabel: 'Settings' });
  expect(f.fake.runs).toHaveLength(0);
});

test('configuration YAML reader wraps the existing canonical export in a versioned view', async () => {
  const f = fixture = await projectFixture(), response = await f.request('/api/config/yaml'); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ schema: 'configuration-yaml-view-v1', yaml: await (await f.request('/hub/config/export')).text() });
});

test('configuration import preparation shares member normalization and the unchanged receipt writer', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f), current = await f.app.configuration(), historyLength = (await f.app.state.configuration.history()).length;
  const proposed = structuredClone(current.configuration); proposed['x-jevellan'].maxRunningThreadsAll++;
  const input = { schema: 'config-import-v1', yaml: exportConfiguration(proposed) };
  const response = await member.request('/api/config/import-preview', 'POST', input); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'configuration-import-view-v1', canApply: true, heading: 'Changes to apply', write: { path: '/hub/config', method: 'PUT', body: { schema: 'config-write-v1', revision: current.revision, configuration: proposed } } });
  const request = { ...view.write.body, clientRequestId: 'configuration_import_fixture' };
  const saved = await member.request(view.write.path, view.write.method, request); expect(saved.status).toBe(200); const result = await saved.json();
  const repeated = await member.request(view.write.path, view.write.method, request); expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(result);
  expect((await f.app.state.configuration.history()).length).toBe(historyLength + 1);
  const unchanged = await member.request('/api/config/import-preview', 'POST', input); expect(unchanged.status).toBe(200); expect(await unchanged.json()).toMatchObject({ canApply: false, heading: 'No changes', write: null });
});
