import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, ProjectSchema, ThreadIndexSchema } from '../packages/core/dist/index.js';
import { HubDatabase, HubProjectStore } from '../packages/mesh/dist/index.js';
let root: string, hub: HubDatabase, now: number, a: HubProjectStore, b: HubProjectStore;
const at = '2026-10-19T12:00:00Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-thread-admission-')); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'hub'), join(root, 'user')); hub = new HubDatabase(homes, 'hub'); now = Date.parse(at);
  a = new HubProjectStore(hub, 'a', () => now); b = new HubProjectStore(hub, 'b', () => now);
  for (const id of ['one', 'two']) hub.put('projects', id, ProjectSchema, ProjectSchema.parse({ schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'main', memory: { mode: 'hub', dir: '.memory' }, context: { state: 'none' } }), 0);
  a.assignCoordinator('one', 'a', 0); b.assignCoordinator('two', 'b', 0);
});
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });
const admit = (store: HubProjectStore, projectId: string, threadId: string, deviceId: string) => store.request({ schema: 'project-hub-request-v1', operation: 'thread-admit', projectId, threadId, deviceId });
const index = (id: string, projectId = 'one', ownerDeviceId = 'a', state = 'preparing') => ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId, title: id, ownerDeviceId, state, isolation: 'worktree', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 0, createdAt: at, updatedAt: at });

test('admission is atomic across projects and devices before index publication', async () => {
  const results = await Promise.all(Array.from({ length: 7 }, (_, i) => Promise.resolve().then(() => admit(i % 2 ? b : a, i % 2 ? 'two' : 'one', `thread_${i}`, i % 2 ? 'b' : 'a'))));
  expect(results.filter(row => (row as { admission?: { admitted: boolean } }).admission?.admitted)).toHaveLength(6);
  expect(results[6]).toMatchObject({ admission: { admitted: false, running: 6, limit: 6 } });
  expect(admit(a, 'one', 'thread_0', 'a')).toMatchObject({ admission: { admitted: true } });
});

test('publishing consumes a short claim without double counting and stopping frees the slot', () => {
  for (let i = 0; i < 6; i++) { admit(a, 'one', `thread_${i}`, 'a'); a.publishThread(index(`thread_${i}`), 1); }
  expect(admit(b, 'two', 'blocked', 'b')).toMatchObject({ admission: { admitted: false, running: 6 } });
  a.publishThread(index('thread_0', 'one', 'a', 'idle'), 2);
  expect(admit(b, 'two', 'blocked', 'b')).toMatchObject({ admission: { admitted: true, running: 5 } });
});

test('an unpublished claim expires, while an active index continues to occupy its slot', () => {
  for (let i = 0; i < 6; i++) admit(a, 'one', `thread_${i}`, 'a');
  a.publishThread(index('thread_0'), 1); now += 121000;
  for (let i = 0; i < 5; i++) expect(admit(b, 'two', `next_${i}`, 'b')).toMatchObject({ admission: { admitted: true } });
  expect(admit(b, 'two', 'seventh', 'b')).toMatchObject({ admission: { admitted: false, running: 6 } });
});

test('a late index cannot exceed the cap after its claim expired and another thread took the slot', () => {
  for (let i = 0; i < 6; i++) admit(a, 'one', `old_${i}`, 'a'); now += 121000;
  for (let i = 0; i < 6; i++) { admit(b, 'two', `new_${i}`, 'b'); b.publishThread(index(`new_${i}`, 'two', 'b'), 1); }
  expect(() => a.publishThread(index('old_0'), 1)).toThrow('Waiting for a free slot: 6 threads are running across all projects (limit 6).');
});


test('a claim cannot change project or device identity, and another project coordinator cannot steal it', () => {
  admit(a, 'one', 'owned', 'a');
  expect(() => admit(b, 'two', 'owned', 'b')).toThrow('another device or project');
  expect(() => admit(b, 'one', 'new', 'b')).toThrow('Only its coordinator');
});

test('the configured cap applies globally and lowering it leaves current live threads intact', async () => {
  const { seedConfiguration } = await import('../packages/core/dist/index.js');
  const config = seedConfiguration(); config['x-jevellan'].maxRunningThreadsAll = 3;
  hub.configuration.put(config, 0, { deviceId: 'a', source: 'ui' });
  for (let i = 0; i < 3; i++) a.publishThread(index(`live_${i}`), 1);
  expect(admit(b, 'two', 'next', 'b')).toMatchObject({ admission: { admitted: false, running: 3, limit: 3 } });
  config['x-jevellan'].maxRunningThreadsAll = 1; hub.configuration.put(config, 1, { deviceId: 'a', source: 'ui' });
  expect(() => a.publishThread({ ...index('live_0'), turns: 2 }, 2)).not.toThrow();
  expect(admit(b, 'two', 'next', 'b')).toMatchObject({ admission: { admitted: false, running: 3, limit: 1 } });
  for (let i = 0; i < 3; i++) a.publishThread(index(`live_${i}`, 'one', 'a', 'idle'), 3);
  expect(admit(b, 'two', 'next', 'b')).toMatchObject({ admission: { admitted: true, running: 0, limit: 1 } });
});
