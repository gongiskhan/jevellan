import { expect, test, vi } from 'vitest';
import {
  AccountSchema, AccountStatusSchema, DeviceRosterSchema, HubUnavailable, PlacementOverrideSchema, ProjectSchema, ProjectWorkSettingsSchema, SecretRedactor, ThreadIndexSchema,
  defaultProjectWorkSettings, seedConfiguration, type Account, type AccountStatus, type ModelOption, type PlacementOverride, type ProjectWorkSettings, type ThreadIndex, type ThreadState,
} from '../packages/core/dist/index.js';
import { PlacementStateSchema, parseJevResponse, type DecisionClient, type JevRequest } from '../packages/decisions/dist/index.js';
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

test('a dispatch to another device counts until its index leaves queued or two minutes pass, and is never counted twice (D264)', async () => {
  const indexes = [index('thread_q', 'queued'), index('thread_r', 'running')]; let clock = Date.parse(at);
  const stub = hub(indexes);
  const value = new Admission({ hub: stub, deviceId: 'dev_mini', deviceName: 'Mac mini', localLive: () => [], now: () => clock });
  value.dispatched('proj_app', 'dev_studio', 'thread_q'); value.dispatched('proj_app', 'dev_studio', 'thread_new'); value.dispatched('proj_app', 'dev_studio', 'thread_r');
  expect(value.isDispatched('thread_q')).toBe(true);
  // thread_r's index already left queued (it runs, and counts from the hub); thread_q's index is still queued; thread_new has none yet.
  let counts = await value.counts('proj_app');
  expect(counts.project).toBe(3); expect(Object.fromEntries(counts.devices)).toEqual({ dev_studio: 3 });
  expect(value.isDispatched('thread_r')).toBe(false);
  // The owner publishes thread_q as preparing: from now on its index counts it, once.
  indexes[0] = index('thread_q', 'preparing');
  counts = await value.counts('proj_app'); expect(counts.project).toBe(3); expect(value.isDispatched('thread_q')).toBe(false);
  // A dispatch whose index never appears stops counting after two minutes; a thread never counts against itself.
  expect((await value.counts('proj_app', 'thread_new')).project).toBe(2);
  clock += 120_000;
  expect((await value.counts('proj_app')).project).toBe(2); expect(value.isDispatched('thread_new')).toBe(false);
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
type PlacementFixture = { indexes?: ThreadIndex[]; local?: ThreadIndex[]; overrides?: PlacementOverride[]; client?: DecisionClient; studio?: 'online' | 'stale' | 'offline';
  gates?: { mainIsolation: boolean; remoteDevices: boolean } };
function placementWith(live: string[] = [], over: PlacementFixture = {}) {
  const { admission: value, stub } = admission(over.indexes ?? [], { local: live }); const reads = { overrides: 0 };
  const recentOverrides = async (projectId: string, limit: number) => {
    reads.overrides += 1; if (stub.state.down) throw new HubUnavailable('Fixture hub');
    return (over.overrides ?? []).filter((entry) => entry.projectId === projectId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  };
  const placement = new Placement({ settings: async () => ({ ...seedConfiguration()['x-jevellan'], menu: [swift], runtimes: { ...seedConfiguration()['x-jevellan'].runtimes, codex: { enabled: true } } }),
    accounts: { list: async () => [{ schema: 'account-view-v1', revision: 1, account, statuses: [status('dev_mini'), status('dev_studio')] }] } as never,
    runtimes: new Map([['codex', adapter]]), roster: async () => DeviceRosterSchema.parse({ schema: 'device-roster-v1', currentDeviceId: 'dev_mini',
      devices: [view('dev_mini', 'Mac mini', 'stale'), view('dev_studio', 'Studio', over.studio ?? 'online')] }),
    admission: value, deviceId: 'dev_mini', deviceName: 'Mac mini', now: () => now, hub: { threads: (projectId, after) => stub.threads(projectId, after), recentOverrides },
    local: (projectId) => (over.local ?? []).filter((entry) => entry.projectId === projectId), redactor: new SecretRedactor(),
    ...(over.client ? { decisionClient: async () => over.client! } : {}), ...(over.gates ? { gates: over.gates } : {}) });
  return { placement, stub, reads };
}
const placement = (live: string[] = []) => placementWith(live).placement;
const place = (value: Placement, over: { fixed?: object; work?: Partial<ProjectWorkSettings>; ignoreRunningLimit?: boolean; project?: typeof project; note?: string } = {}) => value.place({
  project: over.project ?? project, workSettings: settings(over.work), title: 'Fix login', task: 'The redirect loops.', fixed: over.fixed ?? {}, coordinatorDeviceId: 'dev_mini',
  ignoreRunningLimit: over.ignoreRunningLimit ?? false, ...(over.note ? { note: over.note } : {}) });

test('placement without a Jev client falls back on the coordinator device, records why, places on another device when fixed and keeps the main gate (D88)', async () => {
  const value = placement();
  const placed = await place(value, { work: { defaultIsolation: 'main' } });
  expect(placed.kind).toBe('placed'); if (placed.kind !== 'placed') return;
  // This device reads stale in the roster and is still placed (D8); a main default places a worktree until phase 6. Both devices
  // qualify (phase 5), and the fallback prefers the coordinator's device.
  expect(placed.record).toMatchObject({ source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'codex', modelId: 'swift', model: 'swift-version', effortRequested: 'medium',
    effortEffective: 'medium', deviceId: 'dev_mini', accountId: 'acc_work', eligibleDevices: ['dev_mini', 'dev_studio'], excludedDevices: [],
    error: { kind: 'no-key', message: 'no key configured' }, jevCalls: [], decidedAt: at });
  expect(placed.labels).toEqual({ modelLabel: 'Swift', deviceName: 'Mac mini', runtimeName: 'Codex' }); expect(placed.atLimit).toBe(false);
  const fixed = await place(value, { fixed: { isolation: 'worktree', modelId: 'swift', effort: 'high', deviceId: 'dev_mini' } });
  expect(fixed.kind === 'placed' && fixed.record).toMatchObject({ source: 'fixed', fixed: ['isolation', 'model', 'effort', 'device'], effortEffective: 'high' });
  expect(fixed.kind === 'placed' && 'error' in fixed.record).toBe(false);
  expect(await place(value, { fixed: { isolation: 'main' } })).toEqual({ kind: 'refused', message: MAIN_NOT_AVAILABLE });
  expect(await place(value, { fixed: { isolation: 'main' }, project: { ...project, branchPolicy: 'external' } })).toEqual({ kind: 'refused', message: LEAVE_GIT_MAIN });
  const studio = await place(value, { fixed: { deviceId: 'dev_studio' } });
  expect(studio.kind === 'placed' && [studio.record.deviceId, studio.record.fixed, studio.labels.deviceName]).toEqual(['dev_studio', ['device'], 'Studio']);
  // An offline device is no candidate; the device gate, closed before phase 5, still refuses another device.
  expect((await place(placementWith([], { studio: 'offline' }).placement, { fixed: { deviceId: 'dev_studio' } }))).toEqual({ kind: 'refused', message: 'No device can run any enabled model: Studio: offline.' });
  const gated = placementWith([], { gates: { mainIsolation: false, remoteDevices: false } }).placement;
  expect(await place(gated, { fixed: { deviceId: 'dev_studio' } })).toEqual({ kind: 'refused', message: REMOTE_NOT_AVAILABLE });
  expect((await place(gated)).kind === 'placed' && (await place(gated) as { record: { excludedDevices: unknown } }).record.excludedDevices)
    .toEqual([{ deviceId: 'dev_studio', reason: 'not available until remote threads exist' }]);
});

test('placement reports a full device as at its limit so the start queues, unless the project limit already queues it (D9, D133)', async () => {
  // This device is full; the other device has room.
  const room = await place(placement(['thread_a', 'thread_b']), { work: { maxRunningPerDevice: 2 } });
  expect(room.kind === 'placed' && [room.record.deviceId, room.atLimit]).toEqual(['dev_studio', false]);
  const full = placementWith(['thread_a', 'thread_b'], { indexes: [index('thread_s1', 'running'), index('thread_s2', 'publishing')] }).placement;
  const placed = await place(full, { work: { maxRunningPerDevice: 2 } });
  expect(placed.kind === 'placed' && [placed.record.deviceId, placed.atLimit]).toEqual(['dev_mini', true]);
  const ignored = await place(full, { work: { maxRunningPerDevice: 2 }, ignoreRunningLimit: true });
  expect(ignored.kind === 'placed' && ignored.atLimit).toBe(false);
});

test('placement asks Jev with the packet: active threads oldest first with this device\'s own copies, the last overrides with titles and the note; a hub outage leaves the hub part out (D249, D252)', async () => {
  const requests: JevRequest[] = [];
  const client: DecisionClient = { decide: vi.fn(async (request: JevRequest) => {
    requests.push(request);
    return parseJevResponse(JSON.stringify({ model: 'jev-fixture', usage: { input_tokens: 10, output_tokens: 2 }, answers: { effort: { type: 'choice', choice: 'high',
      probabilities: { low: 0, medium: 0.1, high: 0.9, xhigh: 0, max: 0 }, confidence: 0.9 } } }), request.questions);
  }) };
  const thread = (id: string, title: string, state: ThreadState, owner: string, createdAt: string, extra: Partial<ThreadIndex> = {}) => ({ ...index(id, state, owner), title, createdAt, ...extra });
  const override = (id: string, threadId: string, mode: 'next-turn' | 'restart', change: PlacementOverride['changes'][number], when: string) => PlacementOverrideSchema.parse({
    schema: 'placement-override-v1', id, projectId: 'proj_app', threadId, mode, changes: [change], at: when });
  // One device for the packet (Studio is offline here), so only the effort is asked.
  const { placement: value, stub, reads } = placementWith([], { client, studio: 'offline',
    indexes: [thread('thread_b', 'Billing', 'running', 'dev_studio', '2026-10-03T09:00:00.000Z'), thread('thread_a', 'Auth', 'idle', 'dev_mini', '2026-10-03T08:00:00.000Z'),
      thread('thread_c', 'Old', 'done', 'dev_studio', '2026-10-03T07:00:00.000Z'), thread('thread_x', 'Other project', 'running', 'dev_studio', at, { projectId: 'proj_other' })],
    // This device's copy is newer than its hub index.
    local: [thread('thread_a', 'Auth', 'running', 'dev_mini', '2026-10-03T08:00:00.000Z', { effort: 'high' })],
    overrides: [override('povr_b', 'thread_gone', 'next-turn', { field: 'effort', from: 'max', to: 'low' }, '2026-10-03T09:30:00.000Z'),
      override('povr_a', 'thread_c', 'restart', { field: 'model', from: 'deep', to: 'swift' }, '2026-10-03T09:45:00.000Z')] });
  const placed = await place(value, { note: '  The owner asked for speed.  ' });
  expect(placed.kind === 'placed' && placed.record).toMatchObject({ source: 'jev', modelId: 'swift', effortRequested: 'high', effortEffective: 'high', deviceId: 'dev_mini',
    probabilities: { effort: { low: 0, medium: 0.1, high: 0.9, xhigh: 0, max: 0 } }, jevCalls: [{ kind: 'placement', returnedModel: 'jev-fixture' }] });
  expect(placed.kind === 'placed' && 'error' in placed.record).toBe(false);
  // One model, one online device and no main isolation before phase 6: only the effort is asked.
  expect(requests).toHaveLength(1); expect(Object.keys(requests[0]!.questions)).toEqual(['effort']);
  const packet = PlacementStateSchema.parse(JSON.parse(requests[0]!.state));
  expect(packet.thread).toEqual({ title: 'Fix login', task: 'The redirect loops.', coordinatorNote: 'The owner asked for speed.' });
  expect(packet.activeThreads).toEqual([{ title: 'Auth', isolation: 'worktree', device: 'Mac mini', model: 'Swift', effort: 'high', reservedPaths: [] },
    { title: 'Billing', isolation: 'worktree', device: 'Studio', model: 'Swift', effort: 'medium', reservedPaths: [] }]);
  expect(packet.rules.recentOverrides).toEqual(["model changed from deep to swift for 'Old' (restart)", "effort changed from max to low for '(unknown thread)' (next-turn)"]);
  expect(reads.overrides).toBe(1);
  // During a hub outage the packet keeps what this device knows.
  stub.state.down = true;
  expect((await place(value)).kind).toBe('placed');
  const offline = PlacementStateSchema.parse(JSON.parse(requests[1]!.state));
  expect(offline.activeThreads.map((entry) => entry.title)).toEqual(['Auth']); expect(offline.rules.recentOverrides).toEqual([]);
  // All four fields fixed: nothing to ask, so neither Jev nor the packet's hub reads.
  stub.state.down = false;
  const fixed = await place(value, { fixed: { isolation: 'worktree', modelId: 'swift', effort: 'low', deviceId: 'dev_mini' } });
  expect(fixed.kind === 'placed' && fixed.record).toMatchObject({ source: 'fixed', effortRequested: 'low', jevCalls: [] });
  expect(requests).toHaveLength(2); expect(reads.overrides).toBe(2);
  // A fixed effort with one model and one device asks nothing either (D30b).
  expect((await place(value, { fixed: { effort: 'low' } }))).toMatchObject({ kind: 'placed', record: { source: 'fixed', fixed: ['effort'] } });
  expect(requests).toHaveLength(2);
});
