import { createDaemon, closeListeners } from '../apps/daemon/dist/index.js';
import { LocalDiagnostics } from '../apps/daemon/dist/diagnostics.js';
import { callCommand } from '../packages/cli/dist/owner-commands.js';
import { OwnerToolResultSchema } from '../packages/core/dist/index.js';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { basename } from 'node:path';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('global thread limit editor exposes the canonical shared bounds without starting work', async () => {
  f = await projectFixture(); const before = await f.app.configuration();
  const response = await f.request('/api/config/limits'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'global-thread-limit-editor-v1', revision: before.revision, input: { label: 'Maximum running threads', value: 6, min: 1, max: 20, step: 1 }, write: { path: '/api/config/limits', method: 'PUT', body: { schema: 'global-thread-limit-save-v1', revision: before.revision } } });
  expect(f.fake.runs).toHaveLength(0);
});

test('global thread limit member saves preserve unrelated settings, bind receipts and reject stale drafts', async () => {
  f = await projectFixture(); const member = await projectMember(f), before = await f.app.configuration();
  const input = { schema: 'global-thread-limit-save-v1', revision: before.revision, value: '7', clientRequestId: 'limit_member_fixture' };
  const response = await member.request('/api/config/limits', 'PUT', input); expect(response.status).toBe(200); const saved = await response.json();
  expect(saved.changedBy.deviceId).toBe(member.deviceId); expect(saved.configuration['x-jevellan']).toEqual({ ...before.configuration['x-jevellan'], maxRunningThreadsAll: 7 });
  const next = structuredClone(saved.configuration); next['x-jevellan'].routingProfile += '\nPreserve the newer fixture.';
  const latest = f.app.hub.configuration.put(next, saved.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  expect(await (await member.request('/api/config/limits', 'PUT', input)).json()).toEqual(saved); expect(await f.app.configuration()).toEqual(latest);
  expect((await member.request('/api/config/limits', 'PUT', { ...input, value: '8' })).status).toBe(409);
  expect((await member.request('/api/config/limits', 'PUT', { ...input, clientRequestId: 'limit_stale_fixture' })).status).toBe(409);
  const noChange = await member.request('/api/config/limits', 'PUT', { ...input, revision: latest.revision, clientRequestId: 'limit_unchanged_fixture' }); expect(noChange.status).toBe(200); expect(await noChange.json()).toEqual(latest);
  for (const [i, value] of ['', '0', '21', '1.5', 'Infinity', '4x'].entries()) expect((await member.request('/api/config/limits', 'PUT', { ...input, revision: latest.revision, value, clientRequestId: `limit_invalid_${i}` })).status).toBe(400);
  expect(await f.app.configuration()).toEqual(latest);
});

test('project definition editor mints only a draft id and owns defaults and folder-following name commands', async () => {
  f = await projectFixture(); const before = await f.app.state.projects.list(); const response = await f.request('/api/projects/editor'); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'project-definition-editor-v1', context: { schema: 'project-definition-context-v1', mode: 'create', revision: 0 }, fields: { name: '', paths: { [f.app.device.deviceId]: '' }, branchPolicy: 'main', memory: { mode: 'hub', dir: '.jevellan/memory' }, createContext: true, restore: true, nameFollowsFolder: true } });
  expect(view.context.projectId).toMatch(/^project_[A-Za-z0-9_-]+$/); expect(await f.app.state.projects.list()).toEqual(before);
  const prepare = async (fields: object, command: object) => { const reply = await f!.request('/api/projects/editor/preview', 'POST', { schema: 'project-definition-preview-v1', context: view.context, fields, command }); expect(reply.status).toBe(200); return reply.json(); };
  const path = await prepare(view.fields, { type: 'path', deviceId: f.app.device.deviceId, value: f.checkout + '///' }); expect(path.fields.name).toBe(basename(f.checkout));
  const named = await prepare(path.fields, { type: 'name', value: 'Owner fixture title' });
  const changed = await prepare(named.fields, { type: 'path', deviceId: f.app.device.deviceId, value: f.checkout + '/other/' }); expect(changed.fields.name).toBe('Owner fixture title');
  const cleared = await prepare(changed.fields, { type: 'name', value: '' });
  const follows = await prepare(cleared.fields, { type: 'path', deviceId: f.app.device.deviceId, value: f.checkout + '/final/' }); expect(follows.fields.name).toBe('final');
  const external = await prepare({ ...path.fields, memory: { mode: 'repo', dir: '.jevellan/memory' } }, { type: 'branch-policy', value: 'external' }); expect(external.fields.memory.mode).toBe('device');
  const hub = await prepare(path.fields, { type: 'branch-policy', value: 'external' }); expect(hub.fields.memory.mode).toBe('hub');
  const projectToken = await prepare(path.fields, { type: 'github-token', checked: true }); expect(projectToken.plan.body.project.githubTokenScope).toBe('project');
  const sharedToken = await prepare(projectToken.fields, { type: 'github-token', checked: false }); expect(sharedToken.plan.body.project.githubTokenScope).toBe('shared'); expect(f.fake.runs).toHaveLength(0);
});

test('project definition device commands preserve optional-all and explicit-full choices', async () => {
  f = await projectFixture(); const member = await projectMember(f); const response = await f.request('/api/projects/editor?projectId=project'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.fields.allowedDevices).toBeNull();
  const prepare = async (fields: object, checked: boolean) => { const reply = await f!.request('/api/projects/editor/preview', 'POST', { schema: 'project-definition-preview-v1', context: view.context, fields, command: { type: 'device', deviceId: member.deviceId, checked } }); expect(reply.status).toBe(200); return reply.json(); };
  const without = await prepare(view.fields, false); expect(without.fields.allowedDevices).toContain(f.app.device.deviceId); expect(without.fields.allowedDevices).not.toContain(member.deviceId);
  const restored = await prepare(without.fields, true); expect(restored.fields.allowedDevices).toEqual(expect.arrayContaining([f.app.device.deviceId, member.deviceId])); expect(restored.fields.allowedDevices).not.toBeNull();
  expect((await f.app.state.projects.get('project'))!.project.allowedDevices).toBeUndefined();
});

test('project definition save uses the existing project boundary, normalization and canonical receipts', async () => {
  f = await projectFixture(); const response = await f.request('/api/projects/editor?projectId=project'); expect(response.status).toBe(200); const view = await response.json();
  const input = { schema: 'project-definition-save-v1', context: view.context, fields: { ...view.fields, name: '  Edited fixture  ', remoteUrl: '', testCommand: '', paths: { ...view.fields.paths, device_blank: '' } }, clientRequestId: 'project_definition_save' };
  const savedResponse = await f.request('/hub/projects', 'PUT', input); expect(savedResponse.status).toBe(200); const saved = await savedResponse.json();
  expect(saved.project.name).toBe('Edited fixture'); expect(saved.project.paths.device_blank).toBeUndefined(); expect(saved.project.remoteUrl).toBeUndefined(); expect(saved.project.testCommand).toBeUndefined();
  const repeated = await f.request('/hub/projects', 'PUT', input); expect(repeated.status).toBe(200); expect(await repeated.json()).toEqual(saved);
  expect((await f.request('/hub/projects', 'PUT', { ...input, clientRequestId: 'project_definition_stale', fields: { ...input.fields, name: 'Stale' } })).status).toBe(409);
  expect(f.fake.runs).toHaveLength(0);
});

test('project definition and vault presentation owns device paths, chips and public memory notices', async () => {
  f = await projectFixture(); f.app.vaultView = () => ({ schema: 'vault-view-v1', remote: null, lastSyncAt: null, lastError: null, pending: false, folders: [] }); f.app.projectVisibility.inspect = async (project, deviceId) => ({ schema: 'project-visibility-v1', projectId: project.id, deviceId, visibility: 'PUBLIC', checkedAt: new Date().toISOString() });
  const response = await f.request('/api/projects/view'); expect(response.status).toBe(200); const view = await response.json();
  const row = view.projects.find((entry: { view: { project: { id: string } } }) => entry.view.project.id === 'project');
  expect(row).toMatchObject({ schema: 'project-definition-row-v1', checkedOutHere: true, path: f.checkout, canContext: true, publicMemoryNotice: true, chips: expect.arrayContaining([expect.objectContaining({ label: 'Work on main' })]) });
  expect(view.vault).toMatchObject({ schema: 'project-vault-presentation-v1', label: 'Local only' });
  expect(f.fake.runs).toHaveLength(0);
});

test('member project definition CLI keeps local draft paths and context work on the requesting device', async () => {
  f = await projectFixture(); const member = await projectMember(f);
  const options: { application: typeof member.app; diagnostics?: LocalDiagnostics } = { application: member.app }, server = createDaemon(options); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let diagnostics: LocalDiagnostics | undefined;
  try {
    diagnostics = new LocalDiagnostics(member.app, `http://127.0.0.1:${(server.address() as AddressInfo).port}`); options.diagnostics = diagnostics;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await callCommand(['config', 'project_editor', '--project', 'project'], member.homes)).toBe(0);
    const result = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected local project draft.'); const view = result.data as { context: object; fields: { paths: Record<string, string> }; devices: { id: string; required: boolean }[] };
    expect(view.fields.paths).toEqual({ [member.deviceId]: '' }); expect(view.devices.find(row => row.required)?.id).toBe(member.deviceId);
    const request = { schema: 'project-definition-save-v1', context: view.context, fields: { ...view.fields, name: 'Member definition fixture', paths: { [member.deviceId]: member.checkout } }, clientRequestId: 'member_definition_cli' };
    output.mockClear(); expect(await callCommand(['config', 'project_save', '--project', 'project', '--request', JSON.stringify(request)], member.homes)).toBe(0);
    const saved = OwnerToolResultSchema.parse(JSON.parse(String(output.mock.calls.find(row => String(row[0]).startsWith('{'))?.[0]))); expect(saved).toMatchObject({ ok: true, data: { project: { name: 'Member definition fixture', paths: { [member.deviceId]: member.checkout } } } });
    expect(member.fake.runs).toHaveLength(0); expect(f.fake.runs).toHaveLength(0);
  } finally { diagnostics?.close(); await closeListeners([server]); }
});

test('other-device folder edits never replace the local folder-derived project name', async () => {
  f = await projectFixture(); const member = await projectMember(f), initial = await (await f.request('/api/projects/editor')).json();
  const prepare = async (fields: object, deviceId: string, value: string) => { const response = await f!.request('/api/projects/editor/preview', 'POST', { schema: 'project-definition-preview-v1', context: initial.context, fields, command: { type: 'path', deviceId, value } }); expect(response.status).toBe(200); return response.json(); };
  const local = await prepare(initial.fields, f.app.device.deviceId, f.checkout + '/local-folder/');
  const remote = await prepare(local.fields, member.deviceId, member.checkout + '/other-device-folder/');
  expect(remote.fields.name).toBe('local-folder'); expect(remote.fields.paths[member.deviceId]).toBe(member.checkout + '/other-device-folder/');
});

test('project definition peer transport requires the normal device session and rejects browser entry', async () => {
  f = await projectFixture(); const member = await projectMember(f), url = member.base + '/api/mesh/project-definitions';
  const body = JSON.stringify({ schema: 'project-definition-peer-request-v1', operation: 'view' });
  expect((await fetch(url, { method: 'POST', headers: { Cookie: member.cookie, 'Content-Type': 'application/json' }, body })).status).toBe(401);
  expect((await fetch(url, { method: 'POST', headers: { Origin: member.base, 'Content-Type': 'application/json' }, body })).status).toBe(403);
  expect((await fetch(url)).status).toBe(405); expect(f.fake.runs).toHaveLength(0); expect(member.fake.runs).toHaveLength(0);
});
