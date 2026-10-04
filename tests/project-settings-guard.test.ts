import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeviceSchema, Homes, ProjectSchema, SecretRedactor, ThreadIndexSchema, type Project, type ThreadIndex } from '../packages/core/dist/index.js';
import { HubProjectStore, MemberHubClient, MemberState, joinHub } from '../packages/mesh/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string;
const at = new Date().toISOString();
const OPEN_THREADS = 'This project has open threads. Stop or finish them before changing its path or Git policy.';
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-guard-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
async function member(id: string) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  return new MemberState(new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor }), ['codex']);
}
function project(id = 'project', fields: Partial<Project> = {}): Project {
  return ProjectSchema.parse({ schema: 'project-v1', id, name: 'Fixture', paths: { left: join(root, `${id}-left`), right: join(root, `${id}-right`) }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' }, ...fields });
}
function index(id: string, projectId: string, state: ThreadIndex['state']): ThreadIndex {
  return ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId, title: 'Fixture thread', state, isolation: 'worktree', ownerDeviceId: 'left',
    runtime: 'fake', modelLabel: 'Fixture model', effort: 'medium', accountLabel: 'Fixture account', turns: 1, createdAt: at, updatedAt: at });
}

test('a project with an open thread keeps its paths and Git policy while its other settings stay editable (D92)', async () => {
  const left = await member('left'); const right = await member('right'); const owner = new HubProjectStore(app.hub, 'left');
  let saved = await left.projects.put(project(), 0); await left.projects.put(project('other'), 0);
  owner.publishThread(index('thread_other', 'other', 'running'), 1);
  saved = await right.projects.put({ ...saved.project, paths: { ...saved.project.paths, right: join(root, 'moved-right') } }, saved.revision);
  expect(saved.project.paths.right).toBe(join(root, 'moved-right'));

  let event = 0;
  for (const state of ['queued', 'preparing', 'running', 'idle', 'publishing', 'in-review', 'waiting-for-you', 'attached'] as const) {
    owner.publishThread(index('thread_one', 'project', state), ++event);
    for (const changed of [{ paths: { ...saved.project.paths, left: join(root, 'moved-left') } }, { paths: { left: saved.project.paths.left! } }, { branchPolicy: 'external' as const }]) {
      await expect(right.projects.put({ ...saved.project, ...changed }, saved.revision)).rejects.toMatchObject({ status: 409, message: OPEN_THREADS });
    }
  }
  expect(() => app.state.projects.put({ ...saved.project, branchPolicy: 'external' }, saved.revision)).toThrow(OPEN_THREADS);
  expect((await right.projects.get('project'))).toEqual(saved);

  saved = await right.projects.put({ ...saved.project, testCommand: 'npm test', name: 'Renamed', allowedDevices: ['left'] }, saved.revision);
  expect(saved.project).toMatchObject({ testCommand: 'npm test', name: 'Renamed', allowedDevices: ['left'] });
  const reordered = { right: saved.project.paths.right!, left: saved.project.paths.left! };
  saved = await left.projects.put({ ...saved.project, paths: reordered, memory: { mode: 'device', dir: '.jevellan/memory' } }, saved.revision);
  expect(saved.project.memory.mode).toBe('device');

  for (const state of ['done', 'stopped', 'failed'] as const) {
    owner.publishThread(index('thread_one', 'project', state), ++event);
    saved = await right.projects.put({ ...saved.project, branchPolicy: saved.project.branchPolicy === 'main' ? 'external' : 'main' }, saved.revision);
  }
  saved = await right.projects.put({ ...saved.project, paths: { left: join(root, 'final-left') } }, saved.revision);
  expect(saved.project.paths).toEqual({ left: join(root, 'final-left') });
});
