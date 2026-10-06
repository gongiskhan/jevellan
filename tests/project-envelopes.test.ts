import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DeviceSchema, Homes, InboxSeenSchema, OutboxSeqSchema, PlacementRecordSchema, ProjectEnvelopeSchema, ProjectSchema, SecretRedactor, ThreadSchema, isProjectHubRead, readDocument, writeDocument,
  type CoordinatorEvent, type ProjectEnvelope, type ProjectHub, type ProjectLedgerEvent, type Thread,
} from '../packages/core/dist/index.js';
import { HubProjectAccess, HubUnavailable, MemberHubClient, MemberProjectStore, joinHub } from '../packages/mesh/dist/index.js';
import { Inbox, Outbox, ProjectPaths, outboxRetryDelay, permanentRefusal, type InboxHandlers } from '../packages/projects/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string; let hubId: string;
const closers: Array<() => Promise<void>> = [];
const at = '2026-10-04T10:00:00.000Z';
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-envelopes-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hubId = app.device.deviceId;
  const hub = app.hub.get('devices', hubId, DeviceSchema)!; app.hub.put('devices', hubId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
  for (const id of ['project', 'other']) app.hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true });
});

async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: 'http://127.0.0.1:9775', os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  return { hub: new MemberProjectStore(client), token: joined.membership.token };
}
/** Fails chosen operations (or everything while `down`) before they reach the hub, and can drop one reply after the hub committed it. */
function gate() {
  const state = { down: false, failing: new Set<string>(), lose: '' };
  const fetcher: typeof fetch = async (...args) => {
    const body = args[1]?.body; const operation = typeof body === 'string' ? (JSON.parse(body) as { operation?: string }).operation ?? '' : '';
    if (state.down || state.failing.has(operation)) throw new Error('Simulated hub outage');
    const response = await fetch(...args);
    if (state.lose && operation === state.lose) { state.lose = ''; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  };
  return { state, fetcher };
}
function device(path: string, token: string | undefined, value: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/hub/mesh/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(value) });
}
const overrideEvent = (id: string, summary = `Override ${id}.`): CoordinatorEvent => ({ schema: 'coordinator-event-v1', kind: 'placement-override', id, at, threadId: 'thread_a', summary });
const toCoordinator = (event: CoordinatorEvent) => ({ kind: 'coordinator-event' as const, event });
const command = (commandId: string, threadId = 'thread_a') => ({ kind: 'thread-command' as const, threadId, commandId, command: { type: 'allow-turns' as const } });
const keyOf = (envelope: Pick<ProjectEnvelope, 'body'>) => envelope.body.kind === 'coordinator-event' ? envelope.body.event.id : envelope.body.kind === 'thread-command' ? envelope.body.commandId : envelope.body.thread.id;
const stored = () => app.hub.list('project-envelopes', ProjectEnvelopeSchema).map((row) => row.document);
function envelope(fields: Partial<ProjectEnvelope> = {}): ProjectEnvelope {
  return ProjectEnvelopeSchema.parse({ schema: 'project-envelope-v1', revision: 0, id: 'env_1', projectId: 'project', sourceDeviceId: 'left', targetDeviceId: 'target', seq: 1, createdAt: at,
    body: command('cmd_1'), ...fields });
}
const placement = (deviceId: string) => PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'codex',
  modelId: 'swift', model: 'swift-version', effortRequested: 'medium', effortEffective: 'medium', deviceId, accountId: 'acc_a', eligibleModels: ['swift'], excludedModels: [],
  eligibleDevices: [deviceId], excludedDevices: [], jevCalls: [], decidedAt: at });
const thread = (id: string, deviceId: string, over: Partial<Thread> = {}): Thread => ThreadSchema.parse({ schema: 'project-thread-v1', id, projectId: 'project', title: 'Fix login',
  task: 'The redirect loops.', createdAt: at, createdBy: 'coordinator', state: 'preparing', isolation: 'worktree', placement: placement(deviceId), ownerDeviceId: deviceId,
  coordinatorDeviceId: hubId, cwd: '', baseBranch: '', baseCommit: '', turns: 0, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, ...over });
/** A thread-start envelope of about `messages` x 20 KB. */
const large = (id: string, seq: number, messages: number, fields: Partial<ProjectEnvelope> = {}) => envelope({ id, seq, ...fields, body: { kind: 'thread-start', thread: thread(`thread_${id}`, 'target', {
  queuedMessages: Array.from({ length: messages }, (_, n) => ({ id: `msg_${n}`, from: 'coordinator' as const, text: 'x'.repeat(20_000), at, interrupt: false })) }) } });

/** One device's relay ends over the given hub access, with handlers that record what they ran. */
function side(deviceId: string, hub: ProjectHub, fail: (envelope: ProjectEnvelope) => unknown = () => undefined) {
  const paths = new ProjectPaths(new Homes(join(root, `device-${deviceId}`), join(root, 'user')));
  const handled: ProjectEnvelope[] = [];
  const handler = async (envelope: ProjectEnvelope) => { const error = fail(envelope); if (error) throw error; handled.push(envelope); };
  const handlers: InboxHandlers = { coordinatorEvent: handler, threadStart: handler, threadCommand: handler };
  const outbox = new Outbox({ paths, hub, deviceId, redactor: new SecretRedactor(), timers: { outboxRetryMs: 60_000, outboxMaxMs: 60_000, now: () => Date.parse(at) } });
  const inbox = new Inbox({ paths, hub, deviceId, handlers, timers: { periodic: false, inboxPollMs: 60_000 } });
  closers.push(() => outbox.close(), () => inbox.close());
  return { paths, outbox, inbox, handled };
}

test('the outbox sends each project in sequence order and the inbox processes by source, project and sequence', async () => {
  const left = await member('left'); const right = await member('right'); const target = side('target', new HubProjectAccess(app.hub, 'target'));
  for (const projectId of ['project', 'other']) await new HubProjectAccess(app.hub, 'target').assignCoordinator(projectId, 'target', 0);
  const l = side('left', left.hub); const r = side('right', right.hub);
  r.outbox.enqueue('project', 'target', command('cmd_r1'));
  l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_l1')));
  l.outbox.enqueue('other', 'coordinator', toCoordinator(overrideEvent('cev_l2')));
  l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_l3')));
  r.outbox.enqueue('project', 'target', command('cmd_r2'));
  await Promise.all([l.outbox.drain(), r.outbox.drain()]);
  expect([...l.outbox.pending(), ...r.outbox.pending()]).toEqual([]); expect(stored()).toHaveLength(5);
  await target.inbox.poll();
  expect(target.handled.map((envelope) => [envelope.sourceDeviceId, envelope.projectId, envelope.seq, keyOf(envelope)])).toEqual([
    ['left', 'other', 1, 'cev_l2'], ['left', 'project', 1, 'cev_l1'], ['left', 'project', 2, 'cev_l3'], ['right', 'project', 1, 'cmd_r1'], ['right', 'project', 2, 'cmd_r2']]);
  expect(target.handled.every((envelope) => envelope.targetDeviceId === 'target')).toBe(true); expect(stored()).toEqual([]);
  // The hub orders by sequence, never by id (ids are random within a millisecond).
  const sender = new HubProjectAccess(app.hub, 'left');
  for (const [id, seq] of [['env_c', 1], ['env_b', 2], ['env_a', 3]] as const) await sender.putEnvelope(envelope({ id, seq, body: command(`cmd_${id}`) }));
  expect((await new HubProjectAccess(app.hub, 'target').pendingEnvelopes('target')).records.map((record) => record.id)).toEqual(['env_c', 'env_b', 'env_a']);
});

test('a message is idempotent at the outbox, at the hub and at the inbox, across a lost put reply, a lost acknowledgement and a restart', async () => {
  const sending = gate(); const receiving = gate(); const left = await member('left', sending.fetcher); const target = await member('target', receiving.fetcher);
  await new HubProjectAccess(app.hub, 'target').assignCoordinator('project', 'target', 0);
  const l = side('left', left.hub); const t = side('target', target.hub);
  sending.state.down = true;
  const first = l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_1')));
  expect(l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_1')))).toEqual(first);
  expect(() => l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_1', 'Other.')))).toThrow('This message is already waiting with different content.');
  expect(() => l.outbox.enqueue('project', 'target', toCoordinator(overrideEvent('cev_2')))).toThrow('Coordinator events, and only they, go to the coordinator device.');
  expect(() => l.outbox.enqueue('project', 'coordinator', command('cmd_1'))).toThrow('Coordinator events, and only they, go to the coordinator device.');
  await l.outbox.drain(); expect(l.outbox.pending()).toEqual([first]);
  // The hub stored the envelope but its reply was lost: the retry answers stored: false and the entry leaves.
  sending.state.down = false; sending.state.lose = 'envelope-put';
  await l.outbox.drain(); expect(l.outbox.pending()).toEqual([{ ...first, target: 'target' }]); expect(stored()).toHaveLength(1);
  await l.outbox.drain(); expect(l.outbox.pending()).toEqual([]); expect(stored()).toEqual([{ ...first.envelope, targetDeviceId: 'target', revision: 1 }]);
  // The acknowledgement fails after the handler ran: the next poll only acknowledges.
  receiving.state.failing.add('envelope-ack');
  await t.inbox.poll(); expect(t.handled.map(keyOf)).toEqual(['cev_1']); expect(stored()).toHaveLength(1);
  receiving.state.failing.clear();
  await t.inbox.poll(); expect(t.handled.map(keyOf)).toEqual(['cev_1']); expect(stored()).toEqual([]);
  // The same message enqueued again repeats its envelope id; stored again after the acknowledgement deleted it, it never runs twice, also after a restart.
  const again = l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_1')));
  expect(again.envelope).toMatchObject({ id: first.envelope.id, seq: 2 });
  await l.outbox.drain(); expect(stored()).toHaveLength(1);
  const restarted = side('target', target.hub);
  await restarted.inbox.poll(); expect(restarted.handled).toEqual([]); expect(stored()).toEqual([]);
  expect(readDocument(t.paths.inboxSeen(), InboxSeenSchema).ids).toEqual([first.envelope.id]);
});

test('the seen set keeps the newest 2,000 envelope ids', async () => {
  const t = side('target', new HubProjectAccess(app.hub, 'target'));
  const old = Array.from({ length: 2000 }, (_, n) => `env_old${n}`);
  writeDocument(t.paths.inboxSeen(), InboxSeenSchema, { schema: 'project-inbox-seen-v1', ids: old });
  await new HubProjectAccess(app.hub, 'left').putEnvelope(envelope({ id: 'env_new' })); await new HubProjectAccess(app.hub, 'left').putEnvelope(envelope({ id: 'env_old5', seq: 2, body: command('cmd_old') }));
  await t.inbox.poll();
  expect(t.handled.map((envelope) => envelope.id)).toEqual(['env_new']); expect(stored()).toEqual([]);
  expect(readDocument(t.paths.inboxSeen(), InboxSeenSchema).ids).toEqual([...old.slice(1), 'env_new']);
});

test('a failed drain retries after 10, 20, 40, 60 and 60 seconds, a delivery resets the schedule and close stops it', async () => {
  expect([1, 2, 3, 4, 5].map((failures) => outboxRetryDelay(failures, 10_000, 60_000))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
  expect([1, 2, 3, 4].map((failures) => outboxRetryDelay(failures, 500, 2_000))).toEqual([500, 1_000, 2_000, 2_000]);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let up = false; let attempts = 0;
  const hub = { coordinator: async () => null, putEnvelope: async () => { attempts += 1; if (!up) throw new HubUnavailable('Fixture hub'); return { stored: true }; } };
  const outbox = new Outbox({ paths: new ProjectPaths(new Homes(join(root, 'backoff'), join(root, 'user'))), hub, deviceId: 'left', redactor: new SecretRedactor(),
    timers: { outboxRetryMs: 10_000, outboxMaxMs: 60_000, now: () => Date.parse(at) } });
  closers.push(() => outbox.close());
  outbox.enqueue('project', 'target', command('cmd_1')); await outbox.drain(); expect(attempts).toBe(1);
  for (const [attempt, delay] of [[2, 10_000], [3, 20_000], [4, 40_000], [5, 60_000], [6, 60_000]] as const) {
    await vi.advanceTimersByTimeAsync(delay - 1); expect(attempts).toBe(attempt - 1);
    await vi.advanceTimersByTimeAsync(1); expect(attempts).toBe(attempt);
  }
  up = true; await vi.advanceTimersByTimeAsync(60_000); expect(attempts).toBe(7); expect(outbox.pending()).toEqual([]);
  up = false; outbox.enqueue('project', 'target', command('cmd_2')); await outbox.drain(); expect(attempts).toBe(8);
  await vi.advanceTimersByTimeAsync(9_999); expect(attempts).toBe(8); await vi.advanceTimersByTimeAsync(1); expect(attempts).toBe(9);
  await outbox.close(); await vi.advanceTimersByTimeAsync(120_000); expect(attempts).toBe(9); expect(outbox.pending()).toHaveLength(1);
});

test('with the hub down the entries wait on disk in order, then arrive in order at the coordinator assigned when they are sent', async () => {
  const sending = gate(); const left = await member('left', sending.fetcher); const l = side('left', left.hub);
  const a = side('dev_a', new HubProjectAccess(app.hub, 'dev_a')); const b = side('dev_b', new HubProjectAccess(app.hub, 'dev_b'));
  await new HubProjectAccess(app.hub, 'dev_a').assignCoordinator('project', 'dev_a', 0);
  sending.state.down = true;
  const entries = ['cev_1', 'cev_2'].map((id) => l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent(id))));
  await l.outbox.drain();
  expect(l.outbox.pending().map((entry) => [entry.envelope.seq, entry.target, keyOf(entry.envelope)])).toEqual([[1, 'coordinator', 'cev_1'], [2, 'coordinator', 'cev_2']]);
  expect(readdirSync(l.paths.outbox('project')).sort()).toEqual([`000000000001-${entries[0]!.envelope.id}.json`, `000000000002-${entries[1]!.envelope.id}.json`, 'seq.json']);
  // The coordinator moves while the hub is unreachable for this device: the entries go where the assignment points when sent.
  await new HubProjectAccess(app.hub, 'dev_b').assignCoordinator('project', 'dev_b', 1);
  sending.state.down = false; await l.outbox.drain();
  expect(l.outbox.pending()).toEqual([]); expect(readDocument(l.paths.outboxSeq('project'), OutboxSeqSchema).seq).toBe(2);
  await a.inbox.poll(); await b.inbox.poll(); expect(a.handled).toEqual([]); expect(b.handled.map(keyOf)).toEqual(['cev_1', 'cev_2']);
  // After a put was tried, the resolved target stays, so a retry repeats the envelope the hub may already hold (D261).
  sending.state.failing.add('envelope-put');
  l.outbox.enqueue('project', 'coordinator', toCoordinator(overrideEvent('cev_3'))); await l.outbox.drain();
  expect(l.outbox.pending().map((entry) => [entry.envelope.seq, entry.target])).toEqual([[3, 'dev_b']]);
  await new HubProjectAccess(app.hub, 'dev_a').assignCoordinator('project', 'dev_a', 2);
  sending.state.failing.clear(); await l.outbox.drain();
  await a.inbox.poll(); await b.inbox.poll(); expect(a.handled).toEqual([]); expect(b.handled.map(keyOf)).toEqual(['cev_1', 'cev_2', 'cev_3']);
});

test('a refused entry or envelope is dropped, while a failing one holds only the rest of its sequence until the next poll', async () => {
  const l = side('left', new HubProjectAccess(app.hub, 'left'));
  l.outbox.enqueue('gone', 'target', command('cmd_x')); l.outbox.enqueue('project', 'target', command('cmd_y'));
  await l.outbox.drain(); expect(l.outbox.pending()).toEqual([]); expect(stored().map(keyOf)).toEqual(['cmd_y']);
  await new HubProjectAccess(app.hub, 'target').ackEnvelope(stored()[0]!.id);
  const failures = new Map<string, Error>([['cmd_a', Object.assign(new Error('Thread not found.'), { status: 404 })], ['cmd_b', new Error('Disk busy.')]]);
  const t = side('target', new HubProjectAccess(app.hub, 'target'), (envelope) => failures.get(keyOf(envelope)));
  const left = new HubProjectAccess(app.hub, 'left'); const right = new HubProjectAccess(app.hub, 'right');
  for (const [seq, key] of [[1, 'cmd_a'], [2, 'cmd_b'], [3, 'cmd_c']] as const) await left.putEnvelope(envelope({ id: `env_${key}`, seq, body: command(key) }));
  await right.putEnvelope(envelope({ id: 'env_cmd_d', sourceDeviceId: 'right', body: command('cmd_d') }));
  await t.inbox.poll();
  expect(t.handled.map(keyOf)).toEqual(['cmd_d']); expect(stored().map(keyOf).sort()).toEqual(['cmd_b', 'cmd_c']);
  expect(readDocument(t.paths.inboxSeen(), InboxSeenSchema).ids).toEqual(['env_cmd_a', 'env_cmd_d']);
  failures.clear(); await t.inbox.poll();
  expect(t.handled.map(keyOf)).toEqual(['cmd_d', 'cmd_b', 'cmd_c']); expect(stored()).toEqual([]);
});

test('the hub keeps envelopes to their source and target, deletes them on acknowledgement and pages them by count and size', async () => {
  const left = new HubProjectAccess(app.hub, 'left'); const target = new HubProjectAccess(app.hub, 'target'); const other = new HubProjectAccess(app.hub, 'other');
  expect(await left.putEnvelope(envelope())).toEqual({ stored: true });
  expect(app.hub.get('project-envelopes', 'env_1', ProjectEnvelopeSchema)).toMatchObject({ revision: 1, document: { revision: 1 } });
  expect(await left.putEnvelope(envelope({ revision: 4 }))).toEqual({ stored: false });
  await expect(left.putEnvelope(envelope({ seq: 2 }))).rejects.toMatchObject({ status: 409, message: 'This envelope id was already used for a different message.' });
  await expect(other.putEnvelope(envelope({ id: 'env_2' }))).rejects.toMatchObject({ status: 403, message: 'Only the source device can send its envelopes.' });
  await expect(left.putEnvelope(envelope({ id: 'env_2', projectId: 'missing' }))).rejects.toMatchObject({ status: 404, message: 'Project not found.' });
  await expect(left.putEnvelope(envelope({ id: 'env_2', deliveredAt: at }))).rejects.toMatchObject({ status: 400 });
  await expect(other.pendingEnvelopes('target')).rejects.toMatchObject({ status: 403, message: 'Only the target device can read its envelopes.' });
  expect(await other.pendingEnvelopes('other')).toEqual({ records: [], more: false });
  for (const access of [other, left]) await expect(access.ackEnvelope('env_1')).rejects.toMatchObject({ status: 403, message: 'Only the target device can acknowledge an envelope.' });
  await target.ackEnvelope('env_1'); expect(stored()).toEqual([]);
  await target.ackEnvelope('env_1');
  // HubDatabase.delete is one statement: inside a transaction that fails, the row stays.
  await left.putEnvelope(envelope({ id: 'env_3' }));
  expect(() => app.hub.transaction(() => { expect(app.hub.delete('project-envelopes', 'env_3')).toBe(true); throw new Error('Rolled back.'); })).toThrow('Rolled back.');
  expect(stored().map((record) => record.id)).toEqual(['env_3']);
  expect(app.hub.delete('project-envelopes', 'env_3')).toBe(true); expect(app.hub.delete('project-envelopes', 'env_3')).toBe(false);
  expect(() => app.hub.delete('project-envelopes', '../x')).toThrow();
  // Pages of 100 in relay order, then the rest.
  for (let seq = 1; seq <= 150; seq++) await left.putEnvelope(envelope({ id: `env_${String(151 - seq).padStart(3, '0')}`, seq, body: command(`cmd_${seq}`) }));
  const page = await target.pendingEnvelopes('target');
  expect(page.more).toBe(true); expect(page.records.map((record) => record.seq)).toEqual(Array.from({ length: 100 }, (_, n) => n + 1));
  for (const record of page.records) await target.ackEnvelope(record.id);
  const rest = await target.pendingEnvelopes('target');
  expect(rest.more).toBe(false); expect(rest.records.map((record) => record.seq)).toEqual(Array.from({ length: 50 }, (_, n) => n + 101));
  for (const record of rest.records) await target.ackEnvelope(record.id);
  // About 1 MiB a page: three 300 KB envelopes, and one larger envelope alone (D260).
  for (let seq = 1; seq <= 4; seq++) await left.putEnvelope(large(`env_big${seq}`, seq, 15));
  await left.putEnvelope(large('env_huge', 5, 60));
  const sizes: number[] = [];
  for (let more = true; more;) { const next = await target.pendingEnvelopes('target'); sizes.push(next.records.length); more = next.more; for (const record of next.records) await target.ackEnvelope(record.id); }
  expect(sizes).toEqual([3, 1, 1]);
});

test('a coordinator move retargets the project\'s coordinator events still waiting for the former device, and a sender\'s retry of one is refused for good', async () => {
  const left = new HubProjectAccess(app.hub, 'left'); const target = new HubProjectAccess(app.hub, 'target'); const mover = new HubProjectAccess(app.hub, 'mover');
  await target.assignCoordinator('project', 'target', 0); await target.assignCoordinator('other', 'target', 0);
  const waiting = envelope({ id: 'env_event', body: toCoordinator(overrideEvent('cev_a')) });
  await left.putEnvelope(waiting);
  await left.putEnvelope(envelope({ id: 'env_command', seq: 2 }));
  await left.putEnvelope(envelope({ id: 'env_other', projectId: 'other', body: toCoordinator(overrideEvent('cev_b')) }));
  // The first assignment and a move to the same device retarget nothing; a move to another device takes only this project's events (D270).
  await target.assignCoordinator('project', 'target', 1);
  expect(stored().map((record) => [record.id, record.targetDeviceId])).toEqual([['env_command', 'target'], ['env_event', 'target'], ['env_other', 'target']]);
  await mover.assignCoordinator('project', 'mover', 2);
  expect(stored().map((record) => [record.id, record.targetDeviceId, record.revision])).toEqual([['env_command', 'target', 1], ['env_event', 'mover', 2], ['env_other', 'target', 1]]);
  expect((await mover.pendingEnvelopes('mover')).records.map(keyOf)).toEqual(['cev_a']);
  // The sender's retry after a lost reply no longer matches what the hub holds: a permanent refusal, so its outbox drops it.
  const retry = await left.putEnvelope(waiting).then(() => null, (error: unknown) => error);
  expect(retry).toMatchObject({ status: 409 }); expect(permanentRefusal(retry)).toBe(true);
  // The former device can no longer acknowledge it; the new coordinator does.
  await expect(target.ackEnvelope('env_event')).rejects.toMatchObject({ status: 403 });
  await mover.ackEnvelope('env_event'); expect(stored().map((record) => record.id)).toEqual(['env_command', 'env_other']);
});

test('members use the relay over HTTP with their device token, and an envelope for the hub runs when it arrives', async () => {
  const left = await member('left'); const body = { schema: 'project-hub-request-v1', operation: 'envelopes-pending', targetDeviceId: 'left' };
  expect(isProjectHubRead('envelopes-pending')).toBe(true); expect(isProjectHubRead('envelope-put')).toBe(false); expect(isProjectHubRead('envelope-ack')).toBe(false);
  expect((await device('projects/envelopes', undefined, body)).status).toBe(401);
  const browser = await device('projects/envelopes', left.token, body, { Origin: base }); expect(browser.status).toBe(403);
  const other = await device('projects/envelopes', left.token, { ...body, targetDeviceId: hubId });
  expect(other.status).toBe(403); expect(await other.json()).toMatchObject({ message: 'Only the target device can read its envelopes.' });
  const listed = await device('projects/envelopes', left.token, body);
  expect(await listed.json()).toEqual({ schema: 'project-hub-result-v1', operation: 'envelopes-pending', records: [], more: false });
  // Large envelopes come in pages that fit the member's 2 MiB reply limit.
  const hub = new HubProjectAccess(app.hub, hubId);
  for (let seq = 1; seq <= 8; seq++) await hub.putEnvelope(large(`env_big${seq}`, seq, 15, { sourceDeviceId: hubId, targetDeviceId: 'left' }));
  const l = side('left', left.hub);
  await l.inbox.poll(); expect(l.handled.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); expect(stored()).toEqual([]);
  // An event for the coordinator on the hub runs without waiting for a poll, exactly once even when the member sends it again.
  await hub.assignCoordinator('project', hubId, 0);
  const report: CoordinatorEvent = { schema: 'coordinator-event-v1', kind: 'thread-report', id: 'cev_relay', at, threadId: 'thread_a',
    report: { schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'Working.', changedFiles: [], synthesized: false } };
  const ledger = app.projectWork.coordinatorLedger('project');
  const received = () => ledger.events().filter((event) => event.type === 'coordinator-event').map((event) => (ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }) as CoordinatorEvent).id);
  for (let round = 0; round < 2; round++) {
    l.outbox.enqueue('project', 'coordinator', toCoordinator(report)); await l.outbox.drain();
    expect(l.outbox.pending()).toEqual([]);
    await vi.waitFor(() => { expect(stored()).toEqual([]); expect(received()).toEqual(['cev_relay']); }, { timeout: 10_000, interval: 20 });
  }
  await app.projectWork.idle('project');
});

test('the facade applies a thread command once per command id and drops envelopes for threads and projects it does not hold', async () => {
  const work = app.projectWork; work.store.create(thread('thread_here', hubId, { state: 'idle', turns: 1 }), { modelLabel: 'Swift', accountLabel: 'Work' });
  const applied = vi.spyOn(work.threads, 'command');
  const left = new HubProjectAccess(app.hub, 'left');
  const send = (id: string, seq: number, fields: Partial<ProjectEnvelope>) => left.putEnvelope(envelope({ id, seq, targetDeviceId: hubId, ...fields }));
  await send('env_1', 1, { body: command('cmd_once', 'thread_here') });
  await send('env_2', 2, { body: command('cmd_once', 'thread_here') });
  await send('env_3', 3, { body: command('cmd_missing', 'thread_gone') });
  // A project removed after its envelope was stored: the event is dropped and no coordinator state appears for it.
  await send('env_4', 1, { projectId: 'other', body: toCoordinator(overrideEvent('cev_gone')) }); app.hub.delete('projects', 'other');
  await work.pulse();
  expect(applied).toHaveBeenCalledTimes(1); expect(applied).toHaveBeenCalledWith('project', 'thread_here', { type: 'allow-turns' });
  expect(work.store.local('thread_here').seenCommands).toEqual(['cmd_once']);
  expect(stored()).toEqual([]); expect(readDocument(work.paths.inboxSeen(), InboxSeenSchema).ids).toEqual(['env_4', 'env_1', 'env_2', 'env_3']);
  expect(work.paths.projectIds()).not.toContain('other');
  await work.idle();
});

test('a member reads a relayed report whose redaction would lengthen it: the hub keeps its reply within the schema (P8 review S-1)', async () => {
  const mem = await member('mem');
  const tail = ' The middleware reads the Bearer token now.';
  const summary = 'Fixed the parser. '.repeat(70).slice(0, 1200 - tail.length) + tail;
  const report = { schema: 'thread-report-v1' as const, turn: 1, status: 'progress' as const, summary, changedFiles: [], synthesized: true };
  await new HubProjectAccess(app.hub, 'left').putEnvelope(envelope({ id: 'env_bearer', targetDeviceId: 'mem',
    body: { kind: 'coordinator-event', event: { schema: 'coordinator-event-v1', kind: 'thread-report', id: 'cev_bearer', at, threadId: 'thread_a', report } } }));
  const page = await mem.hub.pendingEnvelopes('mem');
  expect(page.records.map((record) => record.id)).toEqual(['env_bearer']);
  const relayed = (page.records[0]!.body as { event: { report: { summary: string } } }).event.report.summary;
  expect(relayed.length).toBeLessThanOrEqual(1200); expect(new SecretRedactor().text(relayed)).toBe(relayed); expect(relayed).toContain('Bearer [redacted]');
});

test('a member that cannot read one relayed envelope drops it with a record of what was lost and handles the rest of the page (P8 review S-2)', async () => {
  // A hub that answers one record in a shape this member cannot read (another Jevellan version, for example).
  const rewriting: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    const body = args[1]?.body; const operation = typeof body === 'string' ? (JSON.parse(body) as { operation?: string }).operation : undefined;
    if (operation !== 'envelopes-pending') return response;
    const value = await response.json() as { records: Array<Record<string, unknown>> };
    value.records = value.records.map((record) => record.id === 'env_bad' ? { ...record, body: { ...(record.body as object), extra: true } } : record);
    return new Response(JSON.stringify(value), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  };
  const mem = await member('mem', rewriting);
  await new HubProjectAccess(app.hub, 'left').putEnvelope(envelope({ id: 'env_bad', targetDeviceId: 'mem', seq: 1, body: command('cmd_bad') }));
  await new HubProjectAccess(app.hub, 'left').putEnvelope(envelope({ id: 'env_good', targetDeviceId: 'mem', seq: 2, body: command('cmd_good') }));
  const paths = new ProjectPaths(new Homes(join(root, 'device-mem'), join(root, 'user')));
  const handled: string[] = []; const lost: unknown[] = [];
  const handler = async (received: ProjectEnvelope) => { handled.push(received.id); };
  const inbox = new Inbox({ paths, hub: mem.hub, deviceId: 'mem', handlers: { coordinatorEvent: handler, threadStart: handler, threadCommand: handler },
    timers: { periodic: false, inboxPollMs: 60_000 }, dropped: (item: unknown) => { lost.push(item); } } as ConstructorParameters<typeof Inbox>[0]);
  closers.push(() => inbox.close());
  await inbox.poll();
  expect(handled).toEqual(['env_good']);
  expect(lost).toEqual([{ id: 'env_bad', projectId: 'project', sourceDeviceId: 'left', kind: 'thread-command' }]);
  expect(stored()).toEqual([]);
  // Nothing comes back at the next poll.
  await inbox.poll();
  expect(handled).toEqual(['env_good']); expect(lost).toHaveLength(1);
});
