import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { DeviceSchema, Homes, LifecycleGate, PlacementOverrideSchema, ProjectDecisionSchema, ProjectSchema, SecretRedactor, ThreadIndexSchema, defaultProjectWorkSettings, isProjectHubRead, lifecycleActivity, type PlacementOverride, type ProjectDecision, type ProjectHubOperation, type ThreadIndex } from '../packages/core/dist/index.js';
import { HubProjectAccess, HubProjectStore, HubProtocolError, HubUnavailable, MemberHubClient, MemberProjectStore, joinHub } from '../packages/mesh/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string;
const at = new Date().toISOString();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-hub-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  for (const id of ['project', 'other']) app.hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  return { hub: new MemberProjectStore(client), client, token: joined.membership.token };
}
/** Drops the hub's reply once for the named operation after the hub committed it. */
function losing() {
  const state = { operation: '' };
  const fetcher: typeof fetch = async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (state.operation && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === state.operation) { state.operation = ''; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  };
  return { state, fetcher };
}
function index(id: string, fields: Partial<ThreadIndex> = {}): ThreadIndex {
  return ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId: 'project', title: 'Fixture thread', state: 'running', isolation: 'worktree', ownerDeviceId: 'left',
    runtime: 'fake', modelLabel: 'Fixture model', effort: 'medium', accountLabel: 'Fixture account', turns: 1, createdAt: at, updatedAt: at, ...fields });
}
function question(id: string, fields: Partial<ProjectDecision> = {}): ProjectDecision {
  return ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id, projectId: 'project', from: 'coordinator', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], createdAt: at, ...fields });
}
function override(id: string, fields: Partial<PlacementOverride> = {}): PlacementOverride {
  return PlacementOverrideSchema.parse({ schema: 'placement-override-v1', id, projectId: 'project', threadId: 'thread_a', mode: 'next-turn', changes: [{ field: 'effort', from: 'max', to: 'low' }], at, ...fields });
}
function device(path: string, token: string | undefined, value: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/hub/mesh/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(value) });
}

test('listByField filters on one top-level field in SQL, orders by id and pages after an exclusive cursor', () => {
  const Fixture = z.strictObject({ id: z.string(), projectId: z.string().optional(), nested: z.strictObject({ projectId: z.string() }).optional() });
  for (const [id, document] of [['c', { id: 'c', projectId: 'a' }], ['a', { id: 'a', projectId: 'a' }], ['b', { id: 'b', projectId: 'b' }], ['d', { id: 'd', nested: { projectId: 'a' } }], ['e', { id: 'e', projectId: 'a' }]] as const) app.hub.put('fixture-documents', id, Fixture, document, 0);
  app.hub.put('fixture-other', 'f', Fixture, { id: 'f', projectId: 'a' }, 0);
  const ids = (options?: { limit?: number; after?: string }) => app.hub.listByField('fixture-documents', 'projectId', 'a', Fixture, options).map(row => row.document.id);
  expect(ids()).toEqual(['a', 'c', 'e']);
  expect(ids({ after: 'a' })).toEqual(['c', 'e']); expect(ids({ after: 'c', limit: 1 })).toEqual(['e']); expect(ids({ limit: 2 })).toEqual(['a', 'c']); expect(ids({ after: 'e' })).toEqual([]);
  expect(app.hub.listByField('fixture-documents', 'projectId', 'a', Fixture, { limit: 1 })[0]).toEqual({ revision: 1, document: { id: 'a', projectId: 'a' } });
  for (const field of ['nested.projectId', "x') OR 1=1 --", '1projectId', '', 'project_id']) expect(() => app.hub.listByField('fixture-documents', field, 'a', Fixture)).toThrow('Invalid document field.');
  for (const limit of [0, -1, 1.5]) expect(() => app.hub.listByField('fixture-documents', 'projectId', 'a', Fixture, { limit })).toThrow('Invalid document limit.');
  expect(() => app.hub.listByField('fixture-documents', 'projectId', 'a', Fixture, { after: '../x' })).toThrow();
});

test('settings, coordinators and notebooks are compare-and-swap records whose embedded revision equals the hub row (D3)', async () => {
  const left = await member('left'); const right = await member('right');
  expect(await left.hub.settings('project')).toBeNull();
  const saved = await left.hub.putSettings({ ...defaultProjectWorkSettings('project'), revision: 7, maxRunningThreads: 3 }, 0);
  expect(saved).toMatchObject({ revision: 1, document: { revision: 1, maxRunningThreads: 3 } }); expect(await right.hub.settings('project')).toEqual(saved);
  await expect(right.hub.putSettings(defaultProjectWorkSettings('project'), 0)).rejects.toMatchObject({ status: 409, message: 'This item changed. Reload it before saving.' });
  await expect(right.hub.putSettings(defaultProjectWorkSettings('missing'), 0)).rejects.toMatchObject({ status: 404, message: 'Project not found.' });
  expect(await right.hub.putSettings({ ...saved.document, threadTurnCap: 50 }, 1)).toMatchObject({ revision: 2, document: { revision: 2, threadTurnCap: 50 } });

  expect(await left.hub.coordinator('project')).toBeNull();
  const assigned = await left.hub.assignCoordinator('project', 'left', 0); expect(assigned).toMatchObject({ revision: 1, document: { revision: 1, deviceId: 'left', projectId: 'project' } });
  await expect(right.hub.assignCoordinator('project', 'right', 0)).rejects.toMatchObject({ status: 409 });
  await expect(right.hub.assignCoordinator('project', 'left', 1)).rejects.toMatchObject({ status: 403, message: 'A device can only make itself the coordinator.' });
  const status = { schema: 'project-coordinator-status-v1' as const, revision: 0, projectId: 'project', deviceId: 'left', state: 'idle' as const, failedTurnsInARow: 0, session: null, updatedAt: at };
  await left.hub.putCoordinatorStatus(status); await left.hub.putCoordinatorStatus({ ...status, state: 'running' });
  expect(await right.hub.coordinatorStatus('project')).toMatchObject({ revision: 2, document: { revision: 2, state: 'running', deviceId: 'left' } });
  await expect(right.hub.putCoordinatorStatus({ ...status, deviceId: 'right' })).rejects.toMatchObject({ status: 403, message: 'Only the coordinator device can publish its status.' });
  await expect(right.hub.putCoordinatorStatus(status)).rejects.toMatchObject({ status: 403 });
  expect(await right.hub.assignCoordinator('project', 'right', 1)).toMatchObject({ revision: 2, document: { revision: 2, deviceId: 'right' } });
  await expect(left.hub.putCoordinatorStatus({ ...status, state: 'idle' })).rejects.toMatchObject({ status: 403 });
  await right.hub.putCoordinatorStatus({ ...status, deviceId: 'right' });
  expect(await left.hub.coordinatorStatus('project')).toMatchObject({ revision: 3, document: { revision: 3, deviceId: 'right' } });

  const notebook = { schema: 'project-notebook-v1' as const, projectId: 'project', revision: 0, content: 'Use SQLite.', updatedAt: at, updatedBy: 'coordinator' as const };
  expect(await left.hub.putNotebook(notebook, 0)).toMatchObject({ revision: 1, document: { revision: 1, content: 'Use SQLite.' } });
  await expect(right.hub.putNotebook({ ...notebook, content: 'Stale owner edit.' }, 0)).rejects.toMatchObject({ status: 409, message: 'This item changed. Reload it before saving.' });
  expect(await right.hub.putNotebook({ ...notebook, content: 'Owner edit.', updatedBy: 'owner' }, 1)).toMatchObject({ revision: 2, document: { revision: 2, updatedBy: 'owner' } });
  expect((await left.hub.notebook('project'))?.document.content).toBe('Owner edit.'); expect(await left.hub.notebook('other')).toBeNull();
});

test('the hub refuses to move a coordinator whose device is online and published a running turn, in the same transaction as the move (D269, D283)', async () => {
  const left = await member('left'); const right = await member('right'); const quiet = await member('quiet');
  const beat = (id: string) => app.devices.heartbeat(id, { schema: 'heartbeat-v1', deviceId: id, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [],
    externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  beat('left'); beat('right');
  const status = (projectId: string, deviceId: string, state: 'idle' | 'running') => ({ schema: 'project-coordinator-status-v1' as const, revision: 0, projectId, deviceId, state,
    failedTurnsInARow: 0, session: null, updatedAt: at });
  await left.hub.assignCoordinator('project', 'left', 0);
  // The device announced a turn: the move waits, whatever the mover read before.
  await left.hub.putCoordinatorStatus(status('project', 'left', 'running'));
  await expect(right.hub.assignCoordinator('project', 'right', 1)).rejects.toMatchObject({ status: 409 });
  expect(await left.hub.coordinator('project')).toMatchObject({ revision: 1, document: { deviceId: 'left' } });
  // Idle again: the move goes through, and the former device can no longer announce a turn.
  await left.hub.putCoordinatorStatus(status('project', 'left', 'idle'));
  expect(await right.hub.assignCoordinator('project', 'right', 1)).toMatchObject({ revision: 2, document: { deviceId: 'right' } });
  await expect(left.hub.putCoordinatorStatus(status('project', 'left', 'running'))).rejects.toMatchObject({ status: 403 });
  // A device without a heartbeat for 10 minutes gives the coordinator up although it said it runs a turn (D80).
  await quiet.hub.assignCoordinator('other', 'quiet', 0); await quiet.hub.putCoordinatorStatus(status('other', 'quiet', 'running'));
  expect(await right.hub.assignCoordinator('other', 'right', 1)).toMatchObject({ document: { deviceId: 'right' } });
  // A device that published nothing yet reads as idle: the move back goes through.
  expect(await left.hub.assignCoordinator('project', 'left', 2)).toMatchObject({ document: { deviceId: 'left' } });
});

test('a lost settings reply is reconciled by its request id without replacing a newer save', async () => {
  const { state, fetcher } = losing(); const left = await member('left', fetcher); const right = await member('right');
  const input = { ...defaultProjectWorkSettings('project'), maxRunningPerDevice: 2 }; state.operation = 'settings-put';
  await expect(left.hub.putSettings(input, 0, 'settings_lost')).rejects.toBeInstanceOf(HubUnavailable);
  const original = (await right.hub.settings('project'))!; expect(original.document.maxRunningPerDevice).toBe(2);
  const newer = await right.hub.putSettings({ ...original.document, maxRunningPerDevice: 5 }, original.revision);
  expect(await left.hub.putSettings(input, 0, 'settings_lost')).toEqual(original); expect(await left.hub.settings('project')).toEqual(newer);
  await expect(left.hub.putSettings({ ...input, maxRunningPerDevice: 9 }, 0, 'settings_lost')).rejects.toMatchObject({ status: 409 });
});

test('the hub refuses a stored record whose revision disagrees, and members refuse such replies or the wrong identity', async () => {
  let rewrite: ((body: Record<string, unknown>) => void) | null = null;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args);
    if (!rewrite || !response.ok || !String(args[0]).includes('/hub/mesh/projects/')) return response;
    const body = await response.json() as Record<string, unknown>; rewrite(body); return Response.json(body);
  });
  const notebook = { schema: 'project-notebook-v1' as const, projectId: 'project', revision: 0, content: 'Plan.', updatedAt: at, updatedBy: 'owner' as const };
  await left.hub.putNotebook(notebook, 0); await left.hub.putSettings(defaultProjectWorkSettings('project'), 0);
  rewrite = (body) => { (body.record as { revision: number }).revision = 4; };
  await expect(left.hub.notebook('project')).rejects.toBeInstanceOf(HubProtocolError);
  rewrite = (body) => { (body.record as { document: { projectId: string } }).document.projectId = 'other'; };
  await expect(left.hub.settings('project')).rejects.toBeInstanceOf(HubProtocolError);
  rewrite = (body) => { body.operation = 'settings-put'; };
  await expect(left.hub.settings('project')).rejects.toBeInstanceOf(HubProtocolError);
  rewrite = null;
  app.hub.db.prepare("UPDATE documents SET revision=revision+1 WHERE namespace='project-notebooks' AND id='project'").run();
  expect(() => new HubProjectStore(app.hub, 'left').notebook('project')).toThrow('A project record does not match its hub revision.');
  await expect(left.hub.notebook('project')).rejects.toThrow('A project record does not match its hub revision.');
  await expect(new HubProjectAccess(app.hub, app.device.deviceId).notebook('project')).rejects.toThrow('A project record does not match its hub revision.');
});

test('thread indexes are owner-bound, ordered by ledger event id and replayed only with the same content', async () => {
  const left = await member('left'); const right = await member('right');
  expect(await left.hub.publishThread(index('thread_one', { revision: 9 }), 1)).toEqual({ eventId: 1 });
  expect(await right.hub.thread('thread_one')).toEqual({ revision: 1, document: index('thread_one', { revision: 1 }) });
  await expect(right.hub.publishThread(index('thread_one'), 2)).rejects.toMatchObject({ status: 403, message: 'Only the thread owner can publish its index.' });
  await expect(right.hub.publishThread(index('thread_one', { ownerDeviceId: 'right' }), 2)).rejects.toMatchObject({ status: 403, message: 'This thread belongs to another owner or project.' });
  await expect(left.hub.publishThread(index('thread_one', { projectId: 'other' }), 2)).rejects.toMatchObject({ status: 403, message: 'This thread belongs to another owner or project.' });
  expect(await left.hub.publishThread(index('thread_one', { revision: 3 }), 1)).toEqual({ eventId: 1 });
  await expect(left.hub.publishThread(index('thread_one', { state: 'idle' }), 1)).rejects.toMatchObject({ status: 409, message: 'This thread event already published a different index.' });
  expect((await left.hub.thread('thread_one'))?.revision).toBe(1);
  expect(await left.hub.publishThread(index('thread_one', { state: 'in-review', turns: 2 }), 4)).toEqual({ eventId: 4 });
  expect(await left.hub.publishThread(index('thread_one', { state: 'idle' }), 3)).toEqual({ eventId: 4 });
  expect(await right.hub.thread('thread_one')).toMatchObject({ revision: 2, document: { revision: 2, state: 'in-review', turns: 2 } });
  expect(await left.hub.publishThread(index('thread_one', { state: 'in-review', turns: 2 }), 5)).toEqual({ eventId: 5 });
  expect((await right.hub.thread('thread_one'))?.revision).toBe(2);
  expect(await right.hub.thread('thread_missing')).toBeNull();
});

test('thread and question lists are filtered by project on the hub and paged at 100', async () => {
  const left = await member('left'); const store = new HubProjectStore(app.hub, 'left');
  for (let n = 0; n < 205; n++) store.publishThread(index(`thread_${String(n).padStart(3, '0')}`), 1);
  for (let n = 0; n < 7; n++) store.publishThread(index(`thread_${String(n).padStart(3, '0')}a`, { projectId: 'other' }), 1);
  const first = await left.hub.threads('project'); expect(first.records).toHaveLength(100); expect(first.next).toBe('thread_099');
  const second = await left.hub.threads('project', first.next!); expect(second.records[0]!.id).toBe('thread_100'); expect(second.next).toBe('thread_199');
  const third = await left.hub.threads('project', second.next!); expect(third.records.map(row => row.id)).toEqual(['thread_200', 'thread_201', 'thread_202', 'thread_203', 'thread_204']); expect(third.next).toBeNull();
  expect([...first.records, ...second.records, ...third.records].every(row => row.projectId === 'project' && row.revision === 1)).toBe(true);
  expect((await left.hub.threads('other')).records).toHaveLength(7);

  // Withdrawn and long-answered questions leave the list; a page still holds 100 listed questions and ends on the last one.
  const now = Date.now(); const hub = new HubProjectStore(app.hub, 'left', () => now);
  for (let n = 0; n < 210; n++) {
    const id = `pdec_${String(n).padStart(3, '0')}`; hub.createDecision(question(id));
    if (n % 3 === 1) hub.withdrawDecision(id, at);
    if (n % 3 === 2) hub.answerDecision(id, { optionLabel: 'SQLite' }, new Date(now - (n % 2 ? 15 : 13) * 86_400_000).toISOString(), `answer_${n}`);
  }
  hub.createDecision(question('pdec_other', { projectId: 'other' }));
  const page = hub.decisions('project'); expect(page.records).toHaveLength(100);
  const listed = (n: number) => n % 3 === 0 || n % 3 === 2 && n % 2 === 0;
  const expected = Array.from({ length: 210 }, (_, n) => n).filter(listed).map(n => `pdec_${String(n).padStart(3, '0')}`);
  expect(page.records.map(row => row.id)).toEqual(expected.slice(0, 100)); expect(page.next).toBe(expected[99]);
  expect((await new HubProjectAccess(app.hub, 'left', () => now).decisions('project')).map(row => row.id)).toEqual(expected);
  expect((await left.hub.decisions('project')).map(row => row.id)).toEqual(expected);
});

test('question answers are first-answer-wins, idempotent by request id and refused after withdrawal', async () => {
  const { state, fetcher } = losing(); const left = await member('left', fetcher); const right = await member('right');
  const created = await left.hub.createDecision(question('pdec_db', { threadId: 'thread_one' })); expect(created).toMatchObject({ revision: 1, document: { revision: 1, from: 'coordinator', threadId: 'thread_one' } });
  expect(await left.hub.createDecision(question('pdec_db', { threadId: 'thread_one', revision: 4 }))).toEqual(created);
  await expect(left.hub.createDecision(question('pdec_db', { question: 'Another question?' }))).rejects.toMatchObject({ status: 409 });
  await expect(left.hub.createDecision(question('pdec_new', { answer: { optionLabel: 'SQLite' }, answeredAt: at }))).rejects.toMatchObject({ status: 400 });
  await expect(left.hub.createDecision(question('pdec_x', { projectId: 'missing' }))).rejects.toMatchObject({ status: 404, message: 'Project not found.' });

  const answered = await right.hub.answerDecision('pdec_db', { optionLabel: 'SQLite' }, at, 'ans_1');
  expect(answered).toMatchObject({ repeated: false, decision: { revision: 2, document: { revision: 2, answer: { optionLabel: 'SQLite' }, answeredAt: at } } });
  expect(await right.hub.answerDecision('pdec_db', { optionLabel: 'SQLite' }, '2026-10-03T10:05:00.000Z', 'ans_1')).toEqual({ ...answered, repeated: true });
  expect(await left.hub.answerDecision('pdec_db', { optionLabel: 'SQLite' }, at, 'ans_2')).toEqual({ ...answered, repeated: true });
  await expect(left.hub.answerDecision('pdec_db', { optionLabel: 'Postgres' }, at, 'ans_3')).rejects.toMatchObject({ status: 409, message: 'This question was already answered.' });
  await expect(right.hub.answerDecision('pdec_db', { text: 'Postgres' }, at, 'ans_1')).rejects.toMatchObject({ status: 409 });
  expect(await left.hub.withdrawDecision('pdec_db', at)).toEqual(answered.decision);
  await expect(left.hub.answerDecision('pdec_missing', { text: 'Yes' }, at, 'ans_4')).rejects.toMatchObject({ status: 404, message: 'This question was not found.' });

  await left.hub.createDecision(question('pdec_old'));
  const withdrawn = await left.hub.withdrawDecision('pdec_old', at); expect(withdrawn).toMatchObject({ revision: 2, document: { withdrawnAt: at } });
  expect(await right.hub.withdrawDecision('pdec_old', '2026-10-03T11:00:00.000Z')).toEqual(withdrawn);
  await expect(right.hub.answerDecision('pdec_old', { optionLabel: 'SQLite' }, at, 'ans_5')).rejects.toMatchObject({ status: 409, message: 'This question was withdrawn.' });

  await left.hub.createDecision(question('pdec_lost')); state.operation = 'decision-answer';
  await expect(left.hub.answerDecision('pdec_lost', { optionLabel: 'Postgres', text: 'Use JSONB.' }, at, 'ans_lost')).rejects.toBeInstanceOf(HubUnavailable);
  expect(await left.hub.answerDecision('pdec_lost', { optionLabel: 'Postgres', text: 'Use JSONB.' }, at, 'ans_lost')).toMatchObject({ repeated: true, decision: { revision: 2, document: { answer: { optionLabel: 'Postgres', text: 'Use JSONB.' } } } });
  expect((await right.hub.decisions('project')).map(row => row.id)).toEqual(['pdec_db', 'pdec_lost']);
  expect(await right.hub.decision('pdec_old')).toEqual(withdrawn);
});

test('project collections are device routes: browser headers, other collections and unknown paths are refused', async () => {
  const left = await member('left'); const body = { schema: 'project-hub-request-v1', operation: 'threads-list', projectId: 'project' };
  const browser = await device('projects/threads', left.token, body, { Origin: base });
  expect(browser.status).toBe(403); expect(await browser.json()).toMatchObject({ message: 'Use the device connection for this request.' });
  expect((await device('projects/threads', undefined, body)).status).toBe(401);
  const mismatched = await device('projects/settings', left.token, body);
  expect(mismatched.status).toBe(400); expect(await mismatched.json()).toMatchObject({ message: 'This operation belongs to another project collection.' });
  expect((await device('projects/unknown', left.token, body)).status).toBe(404);
  expect((await device('projects/overrides', left.token, { schema: 'project-hub-request-v1', operation: 'overrides-list', projectId: 'project' })).status).toBe(400);
  const listed = await device('projects/threads', left.token, body); expect(listed.status).toBe(200); expect(await listed.json()).toEqual({ schema: 'project-hub-result-v1', operation: 'threads-list', records: [], next: null });
  await expect(left.client.projects('threads', { schema: 'project-hub-request-v1', operation: 'settings-get', projectId: 'project' })).rejects.toThrow('This operation belongs to another project collection.');
});

test('project hub reads are admitted outside the lifecycle gate and writes are refused while an installer holds maintenance (D247)', async () => {
  const left = await member('left'); await app.started;
  const reads: ProjectHubOperation[] = ['settings-get', 'coordinator-get', 'coordinator-status-get', 'threads-list', 'thread-get', 'decisions-list', 'decision-get', 'notebook-get', 'overrides-recent'];
  const writes: ProjectHubOperation[] = ['settings-put', 'coordinator-assign', 'coordinator-status-put', 'thread-publish', 'decision-create', 'decision-withdraw', 'decision-answer', 'notebook-put', 'override-add'];
  expect(reads.filter(isProjectHubRead)).toEqual(reads); expect(writes.filter(isProjectHubRead)).toEqual([]);
  const installer = new LifecycleGate(app.homes); const release = installer.tryMaintenance();
  try {
    expect(release).toBeTypeOf('function');
    expect(await left.hub.settings('project')).toBeNull(); expect(await left.hub.threads('project')).toEqual({ records: [], next: null });
    expect(await left.hub.decisions('project')).toEqual([]); expect(await left.hub.notebook('project')).toBeNull();
    const refused = await device('projects/settings', left.token, { schema: 'project-hub-request-v1', operation: 'settings-put', settings: defaultProjectWorkSettings('project'), expectedRevision: 0 });
    expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ message: expect.stringContaining('being updated') });
    await expect(left.hub.putNotebook({ schema: 'project-notebook-v1', projectId: 'project', revision: 0, content: 'Held.', updatedAt: at, updatedBy: 'coordinator' }, 0)).rejects.toMatchObject({ status: 503 });
    expect(lifecycleActivity(app.homes)).toEqual([]);
  } finally { release?.(); installer.close(); }
  expect(await left.hub.settings('project')).toBeNull(); expect(await left.hub.notebook('project')).toBeNull();
  expect(await left.hub.putSettings(defaultProjectWorkSettings('project'), 0)).toMatchObject({ revision: 1 });
  expect(lifecycleActivity(app.homes)).toEqual([]);
});

test('placement overrides are append-only, recorded by the thread owner, idempotent by id and listed newest first per project (D252)', async () => {
  const { state, fetcher } = losing(); const left = await member('left', fetcher); const right = await member('right');
  await left.hub.publishThread(index('thread_a'), 1);
  const minute = (n: number) => new Date(Date.parse(at) + n * 60_000).toISOString();
  await left.hub.addOverride(override('povr_1', { at: minute(1) }));
  // A lost reply is retried with a later time and the same change: the first record stays.
  state.operation = 'override-add';
  await expect(left.hub.addOverride(override('povr_2', { mode: 'restart', changes: [{ field: 'model', from: 'deep', to: 'swift' }], note: 'Cheaper.', at: minute(3) }))).rejects.toThrow();
  await left.hub.addOverride(override('povr_2', { mode: 'restart', changes: [{ field: 'model', from: 'deep', to: 'swift' }], note: 'Cheaper.', at: minute(4) }));
  await left.hub.addOverride(override('povr_0', { at: minute(2), changes: [{ field: 'model', from: 'deep', to: 'deep-lite' }] }));
  expect((await right.hub.recentOverrides('project', 8)).map((entry) => [entry.id, entry.at])).toEqual([['povr_2', minute(3)], ['povr_0', minute(2)], ['povr_1', minute(1)]]);
  expect((await right.hub.recentOverrides('project', 2)).map((entry) => entry.id)).toEqual(['povr_2', 'povr_0']);
  expect(await right.hub.recentOverrides('other', 8)).toEqual([]);
  // The same id for another change, another owner's thread and an unknown project are refused.
  await expect(left.hub.addOverride(override('povr_1', { changes: [{ field: 'effort', from: 'max', to: 'high' }] }))).rejects.toMatchObject({ status: 409, message: 'This override id was already used for a different change.' });
  await expect(right.hub.addOverride(override('povr_3'))).rejects.toMatchObject({ status: 403, message: 'Only the thread owner can record its placement overrides.' });
  await expect(left.hub.addOverride(override('povr_4', { projectId: 'missing' }))).rejects.toMatchObject({ status: 404, message: 'Project not found.' });
  await expect(right.hub.recentOverrides('project', 0)).rejects.toThrow();
  // The hub's own access reads the same records.
  expect((await new HubProjectAccess(app.hub, app.device.deviceId).recentOverrides('project', 1)).map((entry) => entry.id)).toEqual(['povr_2']);
});

test('work summaries give every project its counts and coordinator with the device presence in one read, paged by project id (D267)', async () => {
  const left = await member('left'); const right = await member('right');
  app.devices.heartbeat('left', { schema: 'heartbeat-v1', deviceId: 'left', at, version: '0.1.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  const leftAccess = new HubProjectAccess(app.hub, 'left');
  for (const [id, state] of [['thread_a', 'running'], ['thread_b', 'idle'], ['thread_c', 'in-review'], ['thread_d', 'preparing']] as const) await leftAccess.publishThread(index(id, { state }), 1);
  await leftAccess.publishThread(index('thread_o', { projectId: 'other', state: 'publishing' }), 1);
  const hubAccess = new HubProjectAccess(app.hub, app.device.deviceId);
  await hubAccess.createDecision(question('pdec_open')); await hubAccess.createDecision(question('pdec_gone')); await hubAccess.withdrawDecision('pdec_gone', at);
  await hubAccess.createDecision(question('pdec_done')); await hubAccess.answerDecision('pdec_done', { optionLabel: 'SQLite' }, at, 'req_done');
  // `project`: its coordinator on `left`, which published its state; `other`: on `right`, which never reported a heartbeat.
  await leftAccess.assignCoordinator('project', 'left', 0);
  await leftAccess.putCoordinatorStatus({ schema: 'project-coordinator-status-v1', revision: 0, projectId: 'project', deviceId: 'left', state: 'running', failedTurnsInARow: 0, session: null, updatedAt: at });
  await new HubProjectAccess(app.hub, 'right').assignCoordinator('other', 'right', 0);
  const expected = [
    { schema: 'project-work-summary-v1', projectId: 'other', name: 'other', waiting: 0, running: 1, inReview: 0,
      coordinator: { deviceId: 'right', device: { name: 'right', status: 'offline', revoked: false }, state: null } },
    { schema: 'project-work-summary-v1', projectId: 'project', name: 'project', waiting: 1, running: 2, inReview: 1,
      coordinator: { deviceId: 'left', device: { name: 'left', status: 'online', revoked: false }, state: 'running' } },
  ];
  expect(await left.hub.workSummaries()).toEqual(expected);
  expect(await app.projectHub.workSummaries()).toEqual(expected);
  // A store without the roster knows no device; a status published by a former coordinator is not shown after a move.
  expect((await hubAccess.workSummaries())[1]!.coordinator).toEqual({ deviceId: 'left', device: null, state: 'running' });
  await new HubProjectAccess(app.hub, 'right').assignCoordinator('project', 'right', 1);
  expect((await right.hub.workSummaries())[1]!.coordinator).toEqual({ deviceId: 'right', device: { name: 'right', status: 'offline', revoked: false }, state: null });
  // Pages of 100 by project id, read whole by both adapters.
  for (let n = 0; n < 150; n++) app.hub.put('projects', `bulk_${String(n).padStart(3, '0')}`, ProjectSchema, { schema: 'project-v1', id: `bulk_${String(n).padStart(3, '0')}`, name: `Bulk ${n}`, paths: {},
    branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  const first = new HubProjectStore(app.hub, 'left').workSummaries();
  expect(first.records).toHaveLength(100); expect(first.next).toBe(first.records.at(-1)!.projectId);
  expect((await left.hub.workSummaries()).map((summary) => summary.projectId)).toEqual([...Array.from({ length: 150 }, (_, n) => `bulk_${String(n).padStart(3, '0')}`), 'other', 'project']);
  expect(isProjectHubRead('work-summaries')).toBe(true);
});
