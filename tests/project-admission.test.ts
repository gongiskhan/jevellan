import { expect, test } from 'vitest';
import {
  AccountSchema, AccountStatusSchema, DeviceRosterSchema, HubUnavailable, ProjectSchema, ProjectWorkSettingsSchema, ThreadIndexSchema, defaultProjectWorkSettings, seedConfiguration,
  type Account, type AccountStatus, type ModelOption, type ProjectWorkSettings, type ThreadIndex, type ThreadState,
} from '../packages/core/dist/index.js';
import type { RuntimeAdapter } from '../packages/runtime-contract/dist/index.js';
import { Admission, Placement, queuedReason, waitingForSlotReason, MAIN_NOT_AVAILABLE, REMOTE_NOT_AVAILABLE, LEAVE_GIT_MAIN } from '../packages/projects/dist/index.js';

const at = '2026-10-03T10:00:00.000Z';
function index(id: string, state: ThreadState, ownerDeviceId = 'dev_studio', projectId = 'proj_app'): ThreadIndex {
  return ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id, projectId, title: 'Fixture thread', state, isolation: 'worktree', ownerDeviceId,
    runtime: 'codex', modelLabel: 'Swift', effort: 'medium', accountLabel: 'Work', turns: 1, createdAt: at, updatedAt: at });
}
const settings = (over: Partial<ProjectWorkSettings> = {}) => ProjectWorkSettingsSchema.parse({ ...defaultProjectWorkSettings('proj_app'), revision: 3, ...over });
/** Hub stub: pages of 100 by id like the hub, and an outage switch. */
function hub(indexes: ThreadIndex[], work?: ProjectWorkSettings) {
  const state = { down: false, failure: undefined as Error | undefined, pages: 0 };
  return {
    state,
    async threads(projectId: string, after?: string) {
      if (state.failure) throw state.failure;
      if (state.down) throw new HubUnavailable('Fixture hub');
      state.pages += 1;
      const all = indexes.filter((entry) => entry.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id)).filter((entry) => after === undefined || entry.id > after);
      const records = all.slice(0, 100);
      return { records, next: all.length > 100 ? records.at(-1)!.id : null };
    },
    async settings(projectId: string) {
      if (state.down) throw new HubUnavailable('Fixture hub');
      return work && work.projectId === projectId ? { revision: work.revision, document: work } : null;
    },
  };
}
function admission(indexes: ThreadIndex[], over: { work?: ProjectWorkSettings; local?: string[] } = {}) {
  const stub = hub(indexes, over.work); const local = new Set(over.local ?? []);
  const value = new Admission({ hub: stub, deviceId: 'dev_mini', deviceName: 'Mac mini', localLive: (projectId) => projectId === 'proj_app' ? local : [],
    nameOf: async (deviceId) => deviceId === 'dev_studio' ? 'Studio' : undefined });
  return { admission: value, stub, local };
}

test('admission counts live work only: remote indexes of other devices, local runners and pending dispatches, each thread once (D9)', async () => {
  const states: ThreadState[] = ['queued', 'preparing', 'running', 'idle', 'publishing', 'in-review', 'waiting-for-you', 'attached', 'done', 'stopped', 'failed'];
  // 160 indexes over two hub pages: only preparing, running and publishing count.
  const indexes = Array.from({ length: 160 }, (_, n) => index(`thread_${String(n).padStart(3, '0')}`, states[n % states.length]!));
  // This device's own indexes are counted from memory, never from the hub; another project's never.
  indexes.push(index('thread_mine', 'running', 'dev_mini'), index('thread_other', 'running', 'dev_studio', 'proj_other'));
  const { admission: value, stub } = admission(indexes, { local: ['thread_local', 'thread_000'] });
  const live = indexes.filter((entry) => entry.projectId === 'proj_app' && entry.ownerDeviceId === 'dev_studio' && ['preparing', 'running', 'publishing'].includes(entry.state)).length;
  let counts = await value.counts('proj_app');
  expect(stub.state.pages).toBe(2);
  expect(counts.project).toBe(live + 2);
  expect(Object.fromEntries(counts.devices)).toEqual({ dev_studio: live, dev_mini: 2 });
  expect(counts.limits).toEqual({ project: 6, device: 4 });
  // A pending dispatch counts until released; a thread already counted elsewhere stays one thread.
  const release = value.hold('proj_app', 'dev_studio', 'thread_new'); const again = value.hold('proj_app', 'dev_mini', 'thread_local');
  counts = await value.counts('proj_app');
  expect(counts.project).toBe(live + 3); expect(counts.devices.get('dev_studio')).toBe(live + 1);
  release(); again();
  expect((await value.counts('proj_app')).project).toBe(live + 2);
  expect((await value.counts('proj_app', 'thread_local')).project).toBe(live + 1);
});

test('admission refuses at the project and device limits with the queued and waiting texts, and holds the slot it grants', async () => {
  const work = settings({ maxRunningThreads: 3, maxRunningPerDevice: 2 });
  const { admission: value, local } = admission([index('thread_r1', 'running'), index('thread_r2', 'publishing')], { work, local: ['thread_l1'] });
  // Project: 3 live of 3.
  const project = await value.admit('proj_app', 'dev_mini', 'thread_new');
  expect(project).toEqual({ ok: false, scope: 'project', limit: 3, device: null, reason: waitingForSlotReason(3, null), queued: queuedReason(3, null) });
  expect(project.ok === false && [project.reason, project.queued]).toEqual(['Waiting for a free slot: the project is at its limit of 3 running threads.', 'Queued: the project is at its limit of 3 running threads.']);
  // A thread never counts against itself.
  expect((await value.admit('proj_app', 'dev_mini', 'thread_l1')).ok).toBe(true);
  // Device: Studio holds 2 of 2 once the project allows more.
  local.clear();
  const device = await admission([index('thread_r1', 'running'), index('thread_r2', 'publishing')], { work: settings({ maxRunningPerDevice: 2 }) }).admission.admit('proj_app', 'dev_studio', 'thread_new');
  expect(device).toMatchObject({ ok: false, scope: 'device', limit: 2, device: 'Studio', reason: 'Waiting for a free slot: Studio is at its limit of 2 running threads.', queued: 'Queued: Studio is at its limit of 2 running threads.' });
  // This device's name needs no lookup.
  const mine = admission([], { work: settings({ maxRunningPerDevice: 1 }), local: ['thread_busy'] });
  expect(await mine.admission.admit('proj_app', 'dev_mini', 'thread_new')).toMatchObject({ ok: false, device: 'Mac mini', reason: 'Waiting for a free slot: Mac mini is at its limit of 1 running threads.' });
});

test('concurrent admissions cannot both take the last slot, and a released slot frees it', async () => {
  const { admission: value } = admission([index('thread_r1', 'running')], { work: settings({ maxRunningThreads: 2 }) });
  const [first, second] = await Promise.all([value.admit('proj_app', 'dev_mini', 'thread_a'), value.admit('proj_app', 'dev_mini', 'thread_b')]);
  expect([first.ok, second.ok]).toEqual([true, false]);
  if (first.ok) first.release();
  expect((await value.admit('proj_app', 'dev_mini', 'thread_b')).ok).toBe(true);
});

test('a hub outage reuses the last good count and settings, or counts zero with defaults, and other failures still surface (D9)', async () => {
  const work = settings({ maxRunningThreads: 2 });
  const { admission: value, stub } = admission([index('thread_r1', 'running'), index('thread_r2', 'running')], { work });
  expect((await value.admit('proj_app', 'dev_mini', 'thread_new')).ok).toBe(false);
  stub.state.down = true;
  expect(await value.counts('proj_app')).toMatchObject({ project: 2, limits: { project: 2, device: 4 } });
  expect((await value.admit('proj_app', 'dev_mini', 'thread_new')).ok).toBe(false);
  // Never read: no remote work, default limits, so turns keep running during the outage.
  const fresh = admission([index('thread_r1', 'running')], { work });
  fresh.stub.state.down = true;
  expect(await fresh.admission.counts('proj_app')).toMatchObject({ project: 0, limits: { project: 6, device: 4 } });
  expect((await fresh.admission.admit('proj_app', 'dev_mini', 'thread_new')).ok).toBe(true);
  stub.state.down = false; stub.state.failure = Object.assign(new Error('This thread index belongs to another owner.'), { status: 403 });
  await expect(value.counts('proj_app')).rejects.toThrow('This thread index belongs to another owner.');
});

const now = Date.parse(at);
const swift: ModelOption = { id: 'swift', runtime: 'codex', model: 'swift-version', enabled: true, label: 'Swift', description: 'Fast coding model.', efforts: ['low', 'medium', 'high'] };
const project = ProjectSchema.parse({ schema: 'project-v1', id: 'proj_app', name: 'App', paths: { dev_mini: '/work/app', dev_studio: '/srv/app' }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
const account: Account = AccountSchema.parse({ schema: 'account-v1', id: 'acc_work', runtime: 'codex', label: 'Work', kind: 'subscription', enabled: true, credential: 'per-device' });
const status = (deviceId: string): AccountStatus => AccountStatusSchema.parse({ schema: 'account-status-v2', accountId: 'acc_work', deviceId, auth: 'ready', observedAt: new Date(now - 60_000).toISOString() });
const adapter = { id: 'codex', displayName: 'Codex', capabilities: { edit: true, shell: true, mcp: true, images: false, interrupt: true, usage: true, continueSession: true, perLaunchConfig: true, readOnlyEnforced: true, turns: true } } as unknown as RuntimeAdapter;
const view = (id: string, name: string, presence: 'online' | 'stale' | 'offline') => ({ schema: 'device-view-v1', status: presence, heartbeat: null, revoked: false,
  device: { schema: 'device-v1', id, name, role: id === 'dev_mini' ? 'hub' : 'member', url: `https://${id}.example.invalid`, os: 'darwin', version: '1.0.0', joinedAt: at } });
function placement(local: string[] = []) {
  const { admission: value } = admission([], { local });
  return new Placement({ settings: async () => ({ ...seedConfiguration()['x-jevellan'], menu: [swift], runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, codex: { enabled: true } } }),
    accounts: { list: async () => [{ schema: 'account-view-v1', revision: 1, account, statuses: [status('dev_mini'), status('dev_studio')] }] } as never,
    runtimes: new Map([['codex', adapter]]), roster: async () => DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: 'dev_mini',
      devices: [view('dev_mini', 'Mac mini', 'stale'), view('dev_studio', 'Studio', 'online')] }),
    admission: value, deviceId: 'dev_mini', deviceName: 'Mac mini', now: () => now });
}
const place = (value: Placement, over: { fixed?: object; work?: Partial<ProjectWorkSettings>; ignoreRunningLimit?: boolean; project?: typeof project } = {}) => value.place({
  project: over.project ?? project, workSettings: settings(over.work), title: 'Fix login', task: 'The redirect loops.', fixed: over.fixed ?? {}, coordinatorDeviceId: 'dev_mini',
  ignoreRunningLimit: over.ignoreRunningLimit ?? false });

test('placement uses the fallback on this device only, records why, and keeps the phase gates (D82, D88)', async () => {
  const value = placement();
  const placed = await place(value, { work: { defaultIsolation: 'main' } });
  expect(placed.kind).toBe('placed'); if (placed.kind !== 'placed') return;
  // This device reads stale in the roster and is still placed (D8); a main default places a worktree until phase 6.
  expect(placed.record).toMatchObject({ source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'codex', modelId: 'swift', model: 'swift-version', effortRequested: 'medium',
    effortEffective: 'medium', deviceId: 'dev_mini', accountId: 'acc_work', eligibleDevices: ['dev_mini'], excludedDevices: [{ deviceId: 'dev_studio', reason: 'not available until remote threads exist' }],
    error: { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' }, decidedAt: at });
  expect(placed.labels).toEqual({ modelLabel: 'Swift', deviceName: 'Mac mini', runtimeName: 'Codex' }); expect(placed.atLimit).toBe(false);
  const fixed = await place(value, { fixed: { isolation: 'worktree', modelId: 'swift', effort: 'high', deviceId: 'dev_mini' } });
  expect(fixed.kind === 'placed' && fixed.record).toMatchObject({ source: 'fixed', fixed: ['isolation', 'model', 'effort', 'device'], effortEffective: 'high' });
  expect(fixed.kind === 'placed' && 'error' in fixed.record).toBe(false);
  expect(await place(value, { fixed: { isolation: 'main' } })).toEqual({ kind: 'refused', message: MAIN_NOT_AVAILABLE });
  expect(await place(value, { fixed: { isolation: 'main' }, project: { ...project, branchPolicy: 'external' } })).toEqual({ kind: 'refused', message: LEAVE_GIT_MAIN });
  expect(await place(value, { fixed: { deviceId: 'dev_studio' } })).toEqual({ kind: 'refused', message: REMOTE_NOT_AVAILABLE });
});

test('placement reports a full device as at its limit so the start queues, unless the project limit already queues it (D9, D133)', async () => {
  const full = placement(['thread_a', 'thread_b']);
  const placed = await place(full, { work: { maxRunningPerDevice: 2 } });
  expect(placed.kind === 'placed' && [placed.record.deviceId, placed.atLimit]).toEqual(['dev_mini', true]);
  const ignored = await place(full, { work: { maxRunningPerDevice: 2 }, ignoreRunningLimit: true });
  expect(ignored.kind === 'placed' && ignored.atLimit).toBe(false);
});
