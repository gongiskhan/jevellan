import { afterEach, expect, test } from 'vitest';
import { HubUnavailable, ProjectSchema, ProjectWriteSchema } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });

test('project definition save returns the definition after its normal optional vault restore', async () => {
  f = await projectFixture(); const remoteUrl = 'https://github.com/fixture/definition-restore.git'; let restores = 0;
  f.app.conversations.saveProject = async raw => { const input = ProjectWriteSchema.parse(raw); return f!.app.state.projects.put(input.project, input.revision, input.clientRequestId); };
  f.app.vaultView = () => ({ schema: 'vault-view-v1', remote: null, lastSyncAt: null, lastError: null, pending: false, folders: ['fixture__definition-restore'] });
  // Simulate only the collaborator's resulting definition change; the broad vault drill exercises real restoration.
  f.app.restoreProjectFromVault = async projectId => {
    restores++; const row = f!.app.hub.get('projects', projectId, ProjectSchema)!;
    f!.app.hub.put('projects', projectId, ProjectSchema, { ...row.document, allowedDevices: [f!.app.device.deviceId], branchPolicy: 'external', testCommand: 'fixture-restored-check' }, row.revision);
    return { schema: 'vault-restore-v1', projectId, restored: true };
  };
  const initial = await (await f.request('/api/projects/editor')).json();
  const response = await f.request('/hub/projects', 'PUT', { schema: 'project-definition-save-v1', context: initial.context, fields: { ...initial.fields, name: 'Restore result fixture', remoteUrl, paths: { [f.app.device.deviceId]: f.checkout }, createContext: false }, clientRequestId: 'definition_restore_result' });
  expect(response.status).toBe(200); const returned = await response.json(); const actual = await f.app.state.projects.get(initial.context.projectId);
  expect(restores).toBe(1); expect(returned).toEqual(actual); expect(returned.project).toMatchObject({ branchPolicy: 'external', testCommand: 'fixture-restored-check' });
  expect(f.fake.runs).toHaveLength(0);
});

async function replayFixture(options: { failFirst?: boolean; wait?: () => Promise<void> } = {}) {
  f = await projectFixture(); const fixture = f; let calls = 0;
  fixture.app.conversations.saveProject = async raw => { const input = ProjectWriteSchema.parse(raw); return fixture.app.state.projects.put(input.project, input.revision, input.clientRequestId); };
  fixture.app.vaultView = () => ({ schema: 'vault-view-v1', remote: null, lastSyncAt: null, lastError: null, pending: false, folders: ['fixture__definition-replay'] });
  fixture.app.restoreProjectFromVault = async projectId => {
    calls++; await options.wait?.(); const row = fixture.app.hub.get('projects', projectId, ProjectSchema)!;
    fixture.app.hub.put('projects', projectId, ProjectSchema, { ...row.document, branchPolicy: 'external', testCommand: 'fixture-archive-check' }, row.revision);
    if (options.failFirst && calls === 1) throw new HubUnavailable('Fixture restore interruption');
    return { schema: 'vault-restore-v1', projectId, restored: true };
  };
  const initial = await (await fixture.request('/api/projects/editor')).json();
  const input = { schema: 'project-definition-save-v1', context: initial.context, fields: { ...initial.fields, name: 'Restore replay fixture', remoteUrl: 'https://github.com/fixture/definition-replay.git', paths: { [fixture.app.device.deviceId]: fixture.checkout }, createContext: false }, clientRequestId: 'definition_restore_replay' };
  const write = () => fixture.request('/hub/projects', 'PUT', input);
  const newer = () => { const row = fixture.app.hub.get('projects', initial.context.projectId, ProjectSchema)!; return fixture.app.state.projects.put({ ...row.document, testCommand: 'fixture-newer-owner-check', branchPolicy: 'main' }, row.revision, 'definition_newer_owner'); };
  return { fixture, input, write, newer, calls: () => calls };
}

test('completed project restore request replay preserves newer settings and binds the original request', async () => {
  const testCase = await replayFixture(); expect((await testCase.write()).status).toBe(200); const current = await testCase.newer();
  const replayed = await testCase.write(); expect(replayed.status).toBe(200); expect(testCase.calls()).toBe(1); expect(await replayed.json()).toEqual(current);
  const conflict = await testCase.fixture.request('/hub/projects', 'PUT', { ...testCase.input, fields: { ...testCase.input.fields, name: 'Another request' } }); expect(conflict.status).toBe(409);
  expect(await testCase.fixture.app.state.projects.get(testCase.input.context.projectId)).toEqual(current);
});

test('interrupted project restore request refuses uncertain replay and preserves newer saved work', async () => {
  const testCase = await replayFixture({ failFirst: true }); expect((await testCase.write()).status).toBe(503); const current = await testCase.newer();
  const replayed = await testCase.write(); expect(replayed.status).toBe(409); expect(testCase.calls()).toBe(1);
  expect(await testCase.fixture.app.state.projects.get(testCase.input.context.projectId)).toEqual(current);
});

test('overlapping project restore requests share the same accepted operation', async () => {
  let release!: () => void, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const testCase = await replayFixture({ wait: async () => { entered(); await held; } });
  const first = testCase.write(); await ready; const second = testCase.write(); release();
  const responses = await Promise.all([first, second]); expect(responses.map(response => response.status)).toEqual([200, 200]); expect(testCase.calls()).toBe(1);
});
