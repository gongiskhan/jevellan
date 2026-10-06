import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, PlacementRecordSchema, ThreadSchema, writeDocument, type ProjectHub, type Thread, type ThreadIndex } from '../packages/core/dist/index.js';
import { HubDatabase, HubProjectAccess } from '../packages/mesh/dist/index.js';
import {
  CoordinatorStore, ProjectLedger, ProjectLedgers, ProjectPaths, StartReceipts, ThreadIndexPublisher, ThreadStore, projectLedgerData, publicProjectData, threadIndex,
} from '../packages/projects/dist/index.js';

let root: string; let homes: Homes; let db: HubDatabase; let paths: ProjectPaths;
const at = '2026-10-03T10:00:00.000Z';
const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fallback', fixed: [], isolation: 'worktree', runtime: 'codex',
  modelId: 'swift', model: 'swift-version', effortRequested: 'medium', effortEffective: 'medium', deviceId: 'dev_a', accountId: 'acc_a', eligibleModels: ['swift'],
  excludedModels: [], eligibleDevices: ['dev_a'], excludedDevices: [], error: { kind: 'not-enabled', message: 'Jev placement is not enabled yet.' }, jevCalls: [], decidedAt: at });
const thread = (over: Partial<Thread> = {}): Thread => ThreadSchema.parse({ schema: 'project-thread-v1', id: 'thread_01K6ABCDEF', projectId: 'proj_a', title: 'Fix login',
  task: 'The redirect loops.', createdAt: at, createdBy: 'owner', state: 'preparing', isolation: 'worktree', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a',
  cwd: '', baseBranch: '', baseCommit: '', turns: 0, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, ...over });
const labels = { modelLabel: 'Swift', accountLabel: 'Work' };
function stores(hub: Pick<ProjectHub, 'publishThread'> = new HubProjectAccess(db, 'dev_a'), retryMs = 30_000) {
  const ledgers = new ProjectLedgers(paths); const publisher = new ThreadIndexPublisher(hub, retryMs);
  return { ledgers, publisher, threads: new ThreadStore(paths, ledgers, publisher) };
}
const types = (ledger: ProjectLedger) => ledger.events().map((event) => event.type);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-stores-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'data'), join(root, 'user')); db = new HubDatabase(homes, 'hub'); paths = new ProjectPaths(homes);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test('project paths validate ids, refuse aliases and keep worktrees outside the project folders', () => {
  expect(paths.threadFile('proj_a', 'thread_1')).toBe(join(homes.root, 'projects', 'proj_a', 'threads', 'thread_1', 'thread.json'));
  expect(paths.request('proj_a', 'req_1')).toBe(join(homes.root, 'projects', 'proj_a', 'requests', 'req_1.json'));
  expect(paths.worktree('proj_a', 'thread_1')).toBe(join(homes.root, 'worktrees', 'proj_a', 'thread_1'));
  expect(() => paths.thread('proj_a', '..')).toThrow(); expect(() => paths.project('a/b')).toThrow();
  mkdirSync(join(homes.root, 'projects', 'proj_a', 'threads', 'thread_1'), { recursive: true }); mkdirSync(join(homes.root, 'projects', 'not an id'), { recursive: true });
  writeFileSync(join(homes.root, 'projects', 'file'), ''); expect(paths.projectIds()).toEqual(['proj_a']); expect(paths.threadIds('proj_a')).toEqual(['thread_1']);
  mkdirSync(join(homes.root, 'elsewhere')); symlinkSync(join(homes.root, 'elsewhere'), join(homes.root, 'projects', 'proj_b'));
  expect(() => paths.coordinator('proj_b')).toThrow('Project files cannot alias another location.');
});

test('project ledgers validate payloads, share one instance per folder and recover abandoned locks', async () => {
  const ledgers = new ProjectLedgers(paths); const ledger = ledgers.coordinator('proj_a');
  expect(ledgers.coordinator('proj_a')).toBe(ledger); expect(ledgers.thread('proj_a', 'thread_1')).toBe(ledgers.thread('proj_a', 'thread_1'));
  expect(ledger.dir).toBe(paths.project('proj_a')); expect(ledgers.thread('proj_a', 'thread_1').dir).toBe(paths.thread('proj_a', 'thread_1'));
  const seen: number[] = []; ledgers.coordinator('proj_a').subscribe((event) => seen.push(event.id));
  ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Started "Fix login".' } });
  ledger.append({ type: 'coordinator-tool', data: { schema: 'coordinator-tool-v1', tool: 'jevellan_thread_start', ok: true, summary: 'Started "Fix login"' } });
  await Promise.resolve(); expect(seen).toEqual([1, 2]);
  expect(() => ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: '' } })).toThrow();
  expect(() => ledger.append({ type: 'coordinator-tool', data: { schema: 'coordinator-tool-v1', tool: 'not_a_tool', ok: true, summary: 'x' } })).toThrow();
  expect(() => ledger.append({ type: 'conversation-started' as 'notice', data: { schema: 'project-notice-v1', text: 'x', kind: 'info' } })).toThrow();
  expect(ledger.lastId()).toBe(2);
  expect(projectLedgerData('thread-report', { schema: 'thread-report-v1', turn: 1, status: 'done', summary: 'Done.', synthesized: false }).changedFiles).toEqual([]);
  expect(publicProjectData({ a: { nativeSessionId: 'x', keep: [{ nativeSessionId: 'y', b: 1 }] } })).toEqual({ a: { keep: [{ b: 1 }] } });
  // The owner startup clears a crashed writer's lock on every ledger (brief 8.6).
  mkdirSync(paths.thread('proj_a', 'thread_1'), { recursive: true }); writeFileSync(join(paths.thread('proj_a', 'thread_1'), '.append-lock'), '');
  expect(() => ledgers.thread('proj_a', 'thread_1').append({ type: 'notice', data: { schema: 'project-notice-v1', text: 'x', kind: 'info' } })).toThrow('Project ledger is locked');
  ledgers.recoverAll();
  expect(ledgers.thread('proj_a', 'thread_1').append({ type: 'notice', data: { schema: 'project-notice-v1', text: 'x', kind: 'info' } }).id).toBe(1);
});

test('thread store writes the state file first, records every index change and publishes under the last event id', async () => {
  const { threads, ledgers, publisher } = stores(); const ledger = ledgers.thread('proj_a', 'thread_01K6ABCDEF');
  const created = threads.create(thread(), labels);
  expect(types(ledger)).toEqual(['thread-placement', 'thread-state']);
  expect(ledger.data(ledger.events()[1]!)).toMatchObject({ from: null, to: 'preparing', changed: [] });
  expect(threads.create(thread({ title: 'Other' }), labels)).toEqual(created); expect(types(ledger)).toHaveLength(2);
  await publisher.flush();
  const published = (await new HubProjectAccess(db, 'dev_a').thread(created.id))!.document;
  expect(published).toMatchObject({ id: created.id, state: 'preparing', modelLabel: 'Swift', accountLabel: 'Work', runtime: 'codex', effort: 'medium', updatedAt: ledger.events()[1]!.t });
  for (const key of ['cwd', 'nativeSessionId', 'queuedMessages', 'placement']) expect(published).not.toHaveProperty(key);

  // Owner-local fields only: no event, no publish.
  threads.update(created.id, (value) => ({ ...value, cwd: '/w/t', nativeSessionId: 'session-1', queuedMessages: [{ id: 'tmsg_1', from: 'owner', text: 'Hi', at, interrupt: false }] }));
  expect(types(ledger)).toHaveLength(2); expect(publisher.pending).toBe(0);
  // An index field without a state change: one thread-state naming it.
  threads.update(created.id, (value) => ({ ...value, branch: 'jv/fix-login-abcdef', baseBranch: 'main', baseCommit: 'a'.repeat(40) }));
  expect(ledger.data(ledger.events().at(-1)!)).toEqual({ schema: 'thread-state-v1', from: 'preparing', to: 'preparing', changed: ['branch'] });
  // An explicit event plus a state change: both, the explicit event first (D139).
  const report = { schema: 'thread-report-v1', turn: 1, status: 'progress', summary: 'x'.repeat(1000), synthesized: false };
  threads.update(created.id, (value) => ({ ...value, state: 'idle', turns: 1, lastReport: projectLedgerData('thread-report', report) }), { type: 'thread-report', data: report, turn: 1 });
  expect(types(ledger).slice(-2)).toEqual(['thread-report', 'thread-state']); expect(ledger.events().at(-2)!.turn).toBe(1);
  expect(ledger.data(ledger.events().at(-1)!)).toEqual({ schema: 'thread-state-v1', from: 'preparing', to: 'idle', changed: ['lastSummary', 'state', 'turns'] });
  // A reason-only change is a state change too.
  threads.update(created.id, (value) => ({ ...value, stateReason: 'Queued: the project is at its limit of 6 running threads.' }));
  expect(ledger.data(ledger.events().at(-1)!)).toMatchObject({ from: 'idle', to: 'idle', reason: 'Queued: the project is at its limit of 6 running threads.', changed: ['stateReason'] });
  await publisher.flush();
  const latest = (await new HubProjectAccess(db, 'dev_a').thread(created.id))!.document;
  expect(latest).toMatchObject({ state: 'idle', branch: 'jv/fix-login-abcdef', turns: 1, updatedAt: ledger.events().at(-1)!.t });
  expect(latest.lastSummary).toHaveLength(400);
  expect(() => threads.update(created.id, (value) => ({ ...value, id: 'thread_other' }))).toThrow('cannot change its identity');
  expect(() => threads.update('thread_missing', (value) => value)).toThrow('This thread was not found.');

  // Account changes are index changes (D138); the same labels append nothing.
  threads.setLabels(created.id, { accountLabel: 'Personal' }); threads.setLabels(created.id, { accountLabel: 'Personal' });
  expect(ledger.data(ledger.events().at(-1)!)).toMatchObject({ changed: ['accountLabel'] });
  expect(threads.local(created.id).labels).toEqual({ modelLabel: 'Swift', accountLabel: 'Personal' });

  // A new store reads the same files, and the startup rebuild publishes byte-identical content for the same event id.
  const again = stores(); expect(again.threads.all()).toEqual([threads.get(created.id)]); expect(again.threads.list('proj_b')).toEqual([]);
  await publisher.flush(); const last = ledger.lastId(); again.threads.publishAll(); await again.publisher.flush();
  expect(ledger.lastId()).toBe(last); expect(again.publisher.pending).toBe(0);
});

test('index publishing retries, ignores stale updates and moves past a conflicting event id', async () => {
  let failures = 1; const hub = new HubProjectAccess(db, 'dev_a'); const calls: number[] = [];
  const flaky = { publishThread: async (index: ThreadIndex, eventId: number) => {
    calls.push(eventId); if (failures-- > 0) throw Object.assign(new Error('Hub unavailable'), { status: 503 });
    return hub.publishThread(index, eventId);
  } };
  const first = stores(flaky, 20); const created = first.threads.create(thread(), labels);
  await expect(first.publisher.flush()).rejects.toThrow('Hub unavailable'); expect(first.publisher.pending).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 100)); expect(first.publisher.pending).toBe(0); expect(calls).toEqual([2, 2]);
  const stale = first.threads.current(created.id)!; first.publisher.enqueue({ ...stale.index, title: 'Older' }, 1); await first.publisher.flush();
  expect((await hub.thread(created.id))!.document.title).toBe('Fix login');
  // A crash wrote thread.json without its ledger event: the rebuilt index differs under the published id, the hub refuses
  // it (D124), and the store appends a fresh event so the index moves forward (D139).
  writeDocument(paths.threadFile('proj_a', created.id), ThreadSchema, { ...created, branch: 'jv/after-crash' });
  const second = stores(); expect(second.threads.reconcile(created.id)).toBe(false);
  second.threads.publishAll(); await second.publisher.flush();
  const ledger = second.ledgers.thread('proj_a', created.id); expect(ledger.lastId()).toBe(3);
  expect(ledger.data(ledger.events()[2]!)).toMatchObject({ from: 'preparing', to: 'preparing', changed: [] });
  expect((await hub.thread(created.id))!.document.branch).toBe('jv/after-crash');
  // A state written without its thread-state event is repaired at startup.
  writeDocument(paths.threadFile('proj_a', created.id), ThreadSchema, { ...created, branch: 'jv/after-crash', state: 'idle', stateReason: 'Jevellan restarted during this step.' });
  const third = stores(); expect(third.threads.reconcile(created.id)).toBe(true); expect(third.threads.reconcile(created.id)).toBe(false);
  await third.publisher.flush(); expect((await hub.thread(created.id))!.document).toMatchObject({ state: 'idle', stateReason: 'Jevellan restarted during this step.' });
});

test('a permanently refused index is dropped so other threads still publish', async () => {
  const hub = new HubProjectAccess(db, 'dev_a');
  let unauthorized = true;
  const refusing = { publishThread: async (index: ThreadIndex, eventId: number) => {
    if (index.id === 'thread_refused') throw Object.assign(new Error('Only the thread owner can publish its index.'), { status: 403 });
    if (index.id === 'thread_auth' && unauthorized) throw Object.assign(new Error('Sign in again.'), { status: 401 });
    return hub.publishThread(index, eventId);
  } };
  const { threads, publisher } = stores(refusing);
  threads.create(thread({ id: 'thread_refused' }), labels); threads.create(thread({ id: 'thread_ok' }), labels);
  await publisher.flush(); expect(publisher.pending).toBe(0);
  expect(await hub.thread('thread_refused')).toBeNull(); expect((await hub.thread('thread_ok'))!.document.state).toBe('preparing');
  // An authentication failure is passing: the update stays pending and goes out on the next flush.
  threads.create(thread({ id: 'thread_auth' }), labels); await expect(publisher.flush()).rejects.toThrow('Sign in again.'); expect(publisher.pending).toBe(1);
  unauthorized = false; await publisher.flush(); expect(publisher.pending).toBe(0); expect(await hub.thread('thread_auth')).not.toBeNull();
});

test('threadIndex keeps owner-local fields out and uses the given labels and time', () => {
  const index = threadIndex(thread({ cwd: '/w/t', nativeSessionId: 's', endedAt: at, state: 'done' }), labels, '2026-10-03T11:00:00.000Z');
  expect(index).toEqual({ schema: 'project-thread-index-v1', revision: 0, id: 'thread_01K6ABCDEF', projectId: 'proj_a', title: 'Fix login', state: 'done', isolation: 'worktree',
    ownerDeviceId: 'dev_a', runtime: 'codex', modelLabel: 'Swift', effort: 'medium', accountLabel: 'Work', turns: 0, createdAt: at, updatedAt: '2026-10-03T11:00:00.000Z', endedAt: at });
  const { threads } = stores(); const created = threads.create(thread({ id: 'thread_nolabels' }), labels);
  rmSync(paths.threadLocal('proj_a', created.id)); const fresh = stores();
  expect(fresh.threads.labels(created.id)).toEqual({ modelLabel: 'swift', accountLabel: 'acc_a' });
});

test("threadIndex redacts a stored report's summary before it fits it, so token-like words keep the rest of the sentence (P8 review N-1)", () => {
  // thread.json written before the runner redacted agent reports holds the agent's own words.
  const said = 'Fixed the Bearer token parsing in the auth middleware and added tests for expired tokens.';
  const report = { schema: 'thread-report-v1' as const, turn: 1, status: 'progress' as const, summary: said, changedFiles: [], synthesized: false };
  expect(threadIndex(thread({ state: 'idle', turns: 1, lastReport: report }), labels, at).lastSummary)
    .toBe('Fixed the Bearer [redacted] parsing in the auth middleware and added tests for expired tokens.');
  // Long summaries still fit 400 characters at a point no later redaction rewrites.
  const long = threadIndex(thread({ state: 'idle', turns: 1, lastReport: { ...report, summary: `${'x'.repeat(390)} Bearer abcdefghij more` } }), labels, at).lastSummary!;
  expect(long.length).toBeLessThanOrEqual(400); expect(long.startsWith('x'.repeat(390))).toBe(true); expect(long).not.toContain('abcdefghij');
});

test('coordinator store and start receipts persist owner-local documents', () => {
  const coordinators = new CoordinatorStore(paths);
  expect(coordinators.get('proj_a')).toEqual({ schema: 'coordinator-state-v1', projectId: 'proj_a', state: 'idle', session: null, queue: [], failedTurnsInARow: 0 });
  coordinators.update('proj_a', (state) => ({ ...state, failedTurnsInARow: 1, lastTurnAt: at }));
  expect(new CoordinatorStore(paths).get('proj_a')).toMatchObject({ failedTurnsInARow: 1, lastTurnAt: at });
  expect(() => coordinators.update('proj_a', (state) => ({ ...state, projectId: 'proj_b' }))).toThrow();
  expect(coordinators.local('proj_a')).toEqual({ schema: 'coordinator-local-v1', deliveredTurn: 0, fallbackEventIds: [] });
  coordinators.updateLocal('proj_a', (local) => ({ ...local, fallbackEventIds: ['cev_1'] }));
  expect(new CoordinatorStore(paths).local('proj_a').fallbackEventIds).toEqual(['cev_1']);
  expect(JSON.parse(readFileSync(paths.coordinator('proj_a'), 'utf8')).schema).toBe('coordinator-state-v1');

  const receipts = new StartReceipts(paths, () => Date.parse(at)); const request = { title: 'Fix login', task: 'Loops.', fixed: {} };
  expect(receipts.get('proj_a', 'req_1', request)).toBeNull();
  receipts.put('proj_a', 'req_1', request, 'thread_1'); receipts.put('proj_a', 'req_1', { fixed: {}, task: 'Loops.', title: 'Fix login' }, 'thread_2');
  expect(new StartReceipts(paths).get('proj_a', 'req_1', { task: 'Loops.', fixed: {}, title: 'Fix login' })).toEqual({ threadId: 'thread_1' });
  expect(() => receipts.get('proj_a', 'req_1', { ...request, task: 'Other' })).toThrow(expect.objectContaining({ message: 'This request id was already used for a different thread.', status: 409 }));
});
