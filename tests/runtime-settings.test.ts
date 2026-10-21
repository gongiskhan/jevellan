import { createDaemon, closeListeners } from '../apps/daemon/dist/index.js';
import { LocalDiagnostics } from '../apps/daemon/dist/diagnostics.js';
import { callCommand } from '../packages/cli/dist/owner-commands.js';
import { OwnerToolResultSchema } from '../packages/core/dist/index.js';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { HubUnavailable } from '../packages/mesh/dist/index.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('runtime settings reader owns canonical controls and stays optional on legacy runtime responses', async () => {
  f = await projectFixture(); const response = await f.request('/api/config/runtimes'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'runtime-settings-editor-v1', rows: [{ id: 'fake', enabled: { checked: true }, cache: { value: 10, min: 1, max: 1440, step: 1 }, ownSetup: null, write: { path: '/api/config/runtimes', method: 'PUT', body: { schema: 'runtime-settings-save-v1', runtime: 'fake' } } }] });
  const list = await (await f.request('/api/runtimes')).json(); expect(list.settings).toEqual(view);
  const { RuntimeListSchema } = await import('../packages/core/dist/index.js'); const { settings: _settings, ...legacy } = list; void _settings;
  expect(RuntimeListSchema.parse(legacy)).not.toHaveProperty('settings'); expect(RuntimeListSchema.safeParse({ ...list, settings: { ...view, unexpected: true } }).success).toBe(false);
  expect(f.fake.runs).toHaveLength(0);
});

test('runtime settings member save preserves other sections, recovers receipts and refuses stale edits', async () => {
  f = await projectFixture(); const member = await projectMember(f), before = await f.app.configuration();
  const request = { schema: 'runtime-settings-save-v1', revision: before.revision, runtime: 'fake', patch: { cacheWindowMinutes: '35' }, clientRequestId: 'runtime_member_save' };
  const response = await member.request('/api/config/runtimes', 'PUT', request); expect(response.status).toBe(200); const saved = await response.json();
  expect(saved.changedBy.deviceId).toBe(member.deviceId); expect(saved.configuration['x-jevellan'].runtimes.fake).toMatchObject({ enabled: true, cacheWindowMinutes: 35 });
  expect(saved.configuration['x-jevellan'].guards).toEqual(before.configuration['x-jevellan'].guards);
  const next = structuredClone(saved.configuration); next['x-jevellan'].routingProfile += '\nAnother setting.';
  const latest = f.app.hub.configuration.put(next, saved.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  expect(await (await member.request('/api/config/runtimes', 'PUT', request)).json()).toEqual(saved);
  expect(await f.app.configuration()).toEqual(latest);
  expect((await member.request('/api/config/runtimes', 'PUT', { ...request, patch: { cacheWindowMinutes: '36' } })).status).toBe(409);
  expect((await member.request('/api/config/runtimes', 'PUT', { ...request, clientRequestId: 'runtime_stale' })).status).toBe(409);
  const noChange = await member.request('/api/config/runtimes', 'PUT', { ...request, revision: latest.revision, clientRequestId: 'runtime_no_change' });
  expect(noChange.status).toBe(200); expect(await noChange.json()).toEqual(latest);
});

test('runtime settings invalid raw cache values and unknown fields cannot create revisions', async () => {
  f = await projectFixture(); const before = await f.app.configuration(), history = (await f.app.state.configuration.history()).length;
  for (const [i, value] of ['', '1.5', '0', '1441', 'Infinity', '3x'].entries()) {
    const response = await f.request('/api/config/runtimes', 'PUT', { schema: 'runtime-settings-save-v1', revision: before.revision, runtime: 'fake', patch: { cacheWindowMinutes: value }, clientRequestId: `runtime_bad_${i}` });
    expect(response.status).toBe(400);
  }
  expect((await f.request('/api/config/runtimes', 'PUT', { schema: 'runtime-settings-save-v1', revision: before.revision, runtime: 'fake', patch: { enabled: true, unknown: true }, clientRequestId: 'runtime_unknown' })).status).toBe(400);
  expect((await f.app.state.configuration.history()).length).toBe(history); expect(await f.app.configuration()).toEqual(before);
});

test('runtime settings retry recovers a save after post-commit hub loss without overwriting newer configuration', async () => {
  f = await projectFixture(); const before = await f.app.configuration();
  const request = { schema: 'runtime-settings-save-v1', revision: before.revision, runtime: 'fake', patch: { useOwnSetup: false }, clientRequestId: 'runtime_lost_reply' };
  vi.spyOn(f.app, 'applyRigging').mockRejectedValueOnce(new HubUnavailable('Fixture hub'));
  const lost = await f.request('/api/config/runtimes', 'PUT', request); expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ retryable: true, code: 'hub-unavailable' });
  const saved = await f.app.configuration(), next = structuredClone(saved.configuration); next['x-jevellan'].maxRunningThreadsAll++;
  const latest = f.app.hub.configuration.put(next, saved.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  const recovered = await f.request('/api/config/runtimes', 'PUT', request); expect(recovered.status).toBe(200); expect(await recovered.json()).toEqual(saved); expect(await f.app.configuration()).toEqual(latest);
});

test('member runtime settings CLI reads local inventory metadata while scoped writes remain hub-authoritative', async () => {
  f = await projectFixture(); const member = await projectMember(f);
  Object.defineProperty(member.fake, 'displayName', { value: 'Member runtime fixture' });
  const options: { application: typeof member.app; diagnostics?: LocalDiagnostics } = { application: member.app }, server = createDaemon(options);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); let diagnostics: LocalDiagnostics | undefined;
  try {
    diagnostics = new LocalDiagnostics(member.app, `http://127.0.0.1:${(server.address() as AddressInfo).port}`); options.diagnostics = diagnostics;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await callCommand(['config', 'runtimes_editor', '--project', 'project'], member.homes)).toBe(0);
    const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true);
    const view = result.ok ? result.data as { rows: Array<{ enabled: { ariaLabel: string }; write: { body: object } }> } : undefined;
    expect(view!.rows[0]!.enabled.ariaLabel).toBe('Enable Member runtime fixture');
    const request = { ...view!.rows[0]!.write.body, patch: { enabled: false }, clientRequestId: 'member_runtime_cli_save' };
    expect(await callCommand(['config', 'runtimes_save', '--project', 'project', '--request', JSON.stringify(request)], member.homes)).toBe(0);
    const saved = await f.app.configuration(); expect(saved.changedBy.deviceId).toBe(member.deviceId); expect(saved.configuration['x-jevellan'].runtimes.fake?.enabled).toBe(false);
    expect(f.fake.runs).toHaveLength(0); expect(member.fake.runs).toHaveLength(0);
  } finally { diagnostics?.close(); await closeListeners([server]); }
});
