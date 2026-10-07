import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BridgeToolSchemas, COORDINATOR_TOOLS, CoordinatorEventSchema, DeviceSchema, FileReservationSchema, Homes, MAIL_PAGE_BYTES, PlacementRecordSchema, ProjectMailSchema, ProjectSchema, SecretRedactor, ThreadIndexSchema,
  ThreadSchema, mailReaches, pathsOverlap, projectToolNames, reservationActive,
  type CoordinatorEvent, type ProjectHub, type ProjectMail, type ReservationRequest, type Thread, type ThreadIndex,
} from '../packages/core/dist/index.js';
import {
  HubDatabase, HubProjectAccess, HubProjectStore, HubProtocolError, HubUnavailable, MAIL_RETENTION_MS, MemberHubClient, MemberProjectStore, RESERVATION_RETENTION_MS, joinHub,
} from '../packages/mesh/dist/index.js';
import {
  COORDINATOR_MAIL_NAME, COORDINATOR_MAIL_TO, MAIL_NO_RECIPIENTS, MAIL_THREAD_ENDED, MAIL_TO_SELF, MAIL_WORKTREE_THREAD, MailService, ProjectLedgers, ProjectPaths, ProjectTools, THREAD_MAIL_TO,
  THREAD_NOT_FOUND, TOOL_NOT_IN_TURN, ThreadIndexPublisher, ThreadRunner, ThreadStore, UNKNOWN_THREAD, coordinatorToolHandlers, eventLine,
  type ProjectScope, type ThreadRunnerContext,
} from '../packages/projects/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let homes: Homes; let db: HubDatabase; let now: number;
const start = Date.parse('2026-10-05T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (n: number) => n * 60_000;
const T1 = 'thread_t1'; const T2 = 'thread_t2'; const T3 = 'thread_t3'; const W = 'thread_w';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-mail-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'hub'), join(root, 'user')); db = new HubDatabase(homes, 'hub'); now = start;
  for (const id of ['project', 'other']) db.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

/** The hub store bound to a device, on the test clock. */
const store = (deviceId: string) => new HubProjectStore(db, deviceId, () => now);
const access = (deviceId: string) => new HubProjectAccess(db, deviceId, () => now);
function index(id: string, ownerDeviceId: string, fields: Partial<ThreadIndex> = {}): ThreadIndex {
  return ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 0, id, projectId: 'project', title: `${id.slice(7).toUpperCase()} title`, state: 'running', isolation: 'main',
    ownerDeviceId, runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture account', turns: 1, createdAt: iso(start - minutes(5)), updatedAt: iso(start), ...fields });
}
let events = 0;
const publish = (value: ThreadIndex) => store(value.ownerDeviceId).publishThread(value, ++events);
/** T1 on dev_a, T2 on dev_b, T3 on dev_c (main) and W on dev_a (worktree). */
function threads(): void {
  publish(index(T1, 'dev_a')); publish(index(T2, 'dev_b')); publish(index(T3, 'dev_c')); publish(index(W, 'dev_a', { isolation: 'worktree' }));
}
const request = (fields: Partial<ReservationRequest> & Pick<ReservationRequest, 'id' | 'threadId' | 'paths'>): ReservationRequest => ({ projectId: 'project', reason: '', minutes: 60, ...fields });
const mail = (fields: Partial<ProjectMail> & Pick<ProjectMail, 'id' | 'from' | 'to'>): ProjectMail =>
  ProjectMailSchema.parse({ schema: 'project-mail-v1', revision: 0, projectId: 'project', subject: 'Heads up', body: 'I am changing src/app.txt.', at: iso(now), readBy: [], ...fields });
const ids = (records: readonly { id: string }[]) => records.map((record) => record.id);
const status = (error: unknown) => (error as { status?: number }).status;
function refused(run: () => unknown): { status: number | undefined; message: string } {
  try { run(); } catch (error) { return { status: status(error), message: (error as Error).message }; }
  throw new Error('expected a refusal');
}
const rejects = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => ({ status: status(error), message: (error as Error).message }));

test('the overlap rule is equal paths or a directory prefix ending in /, in either order, and never a glob (brief 5.11)', () => {
  const matrix: Array<[string, string, boolean]> = [
    ['src/app.txt', 'src/app.txt', true], ['src/', 'src/', true], ['src/', 'src/app.txt', true], ['src/', 'src/lib/deep/a.ts', true], ['src/lib/', 'src/', true], ['README.md', 'README.md', true],
    ['src', 'src/app.txt', false], ['src', 'src/', false], ['src/app', 'src/app.txt', false], ['src/a/', 'src/ab/x.ts', false], ['src/app.txt', 'src/app.txt.bak', false],
    ['src/*', 'src/app.txt', false], ['*', 'src/app.txt', false], ['src/**', 'src/a', false], ['**/', 'src/a', false], ['Src/', 'src/a', false], ['./src/', 'src/a', false],
    ['lib/', 'src/lib/a', false], ['docs/', 'README.md', false],
  ];
  for (const [a, b, overlap] of matrix) { expect(pathsOverlap(a, b), `${a} ~ ${b}`).toBe(overlap); expect(pathsOverlap(b, a), `${b} ~ ${a}`).toBe(overlap); }
  // Active means not released and not yet expired; reach is addressed, or all for main threads that existed, never the sender.
  expect(reservationActive({ expiresAt: iso(start + 1) }, start)).toBe(true);
  expect(reservationActive({ expiresAt: iso(start) }, start)).toBe(false);
  expect(reservationActive({ expiresAt: iso(start + 1), releasedAt: iso(start) }, start)).toBe(false);
  const sent = { from: T1, to: 'all', at: iso(start) };
  expect(mailReaches(sent, index(T2, 'dev_b'))).toBe(true);
  expect(mailReaches(sent, index(T1, 'dev_a'))).toBe(false);
  expect(mailReaches(sent, index(W, 'dev_a', { isolation: 'worktree' }))).toBe(false);
  expect(mailReaches(sent, index(T3, 'dev_c', { createdAt: iso(start) }))).toBe(true);
  expect(mailReaches(sent, index(T3, 'dev_c', { createdAt: iso(start + 1) }))).toBe(false);
  expect(mailReaches({ ...sent, to: W }, index(W, 'dev_a', { isolation: 'worktree' }))).toBe(true);
  expect(mailReaches({ ...sent, to: T2 }, index(T3, 'dev_c'))).toBe(false);
});

test('scope lists: main threads get mail and reservations, worktree threads do not, and the coordinator mails without an inbox (brief 7.1, 7.2)', async () => {
  const mainTools = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'];
  expect(projectToolNames({ kind: 'thread', isolation: 'main' })).toEqual(['jevellan_thread_report', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read', ...mainTools]);
  expect(projectToolNames({ kind: 'thread', isolation: 'worktree' })).toEqual(['jevellan_thread_report', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read']);
  expect(projectToolNames({ kind: 'coordinator' })).toEqual([...COORDINATOR_TOOLS]);
  expect(projectToolNames({ kind: 'coordinator' })).toContain('jevellan_mail_send');
  for (const name of ['jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release', 'jevellan_thread_report']) expect(projectToolNames({ kind: 'coordinator' })).not.toContain(name);
  // Through a turn's tools: the list guard refuses before any handler runs.
  threads(); const service = mailService('dev_a');
  const worktree = tools({ kind: 'thread', projectId: 'project', threadId: W, turn: 1, isolation: 'worktree' }, service);
  expect(worktree.list().tools.map((tool) => tool.name)).toEqual(['jevellan_thread_report', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read']);
  for (const name of mainTools) expect(await rejects(worktree.call(name as never, name === 'jevellan_reserve' ? { paths: ['src/'] } : {}))).toEqual({ status: 403, message: TOOL_NOT_IN_TURN });
  const main = tools({ kind: 'thread', projectId: 'project', threadId: T1, turn: 1, isolation: 'main' }, service);
  expect(main.list().tools.map((tool) => tool.name)).toEqual(projectToolNames({ kind: 'thread', isolation: 'main' }));
  expect(main.list().tools.find((tool) => tool.name === 'jevellan_reserve')!.inputSchema).toMatchObject({ required: ['paths'] });
});

test('reservations: the first wins, overlapping requests get the holders, titles and expiry, and the same thread never conflicts with itself (brief 5.11, 7.2)', () => {
  threads(); const a = store('dev_a'); const b = store('dev_b'); const c = store('dev_c');
  const granted = a.reserve(request({ id: 'resv_t1_src', threadId: T1, paths: ['src/', 'README.md', 'lib/'], reason: 'Edit the app' }));
  expect(granted).toEqual({ granted: true, reservation: { revision: 1, document: { schema: 'file-reservation-v1', revision: 1, id: 'resv_t1_src', projectId: 'project', threadId: T1,
    deviceId: 'dev_a', paths: ['src/', 'README.md', 'lib/'], reason: 'Edit the app', createdAt: iso(start), expiresAt: iso(start + minutes(60)) } } });
  // Only the holder's paths that overlap the request are named.
  expect(b.reserve(request({ id: 'resv_t2_app', threadId: T2, paths: ['docs/', 'src/app.txt', 'README.md'] })))
    .toEqual({ granted: false, conflicts: [{ threadId: T1, threadTitle: 'T1 title', paths: ['src/', 'README.md'], expiresAt: iso(start + minutes(60)) }] });
  expect(db.get('project-reservations', 'resv_t2_app', FileReservationSchema)).toBeNull();
  now += minutes(1);
  expect(b.reserve(request({ id: 'resv_t2_docs', threadId: T2, paths: ['docs/'], minutes: 120 }))).toMatchObject({ granted: true, reservation: { document: { expiresAt: iso(now + minutes(120)) } } });
  // Each conflicting reservation is one entry, oldest first; the same thread's own reservations never conflict.
  expect(c.reserve(request({ id: 'resv_t3', threadId: T3, paths: ['docs/guide.md', 'src/main.ts'] }))).toEqual({ granted: false, conflicts: [
    { threadId: T1, threadTitle: 'T1 title', paths: ['src/'], expiresAt: iso(start + minutes(60)) },
    { threadId: T2, threadTitle: 'T2 title', paths: ['docs/'], expiresAt: iso(start + minutes(121)) },
  ] });
  expect(a.reserve(request({ id: 'resv_t1_again', threadId: T1, paths: ['src/app.txt'] }))).toMatchObject({ granted: true });
  // A thread the hub has no index for yet may reserve; its title reads as null for the others.
  expect(c.reserve(request({ id: 'resv_new', threadId: 'thread_new', paths: ['scripts/'] }))).toMatchObject({ granted: true });
  expect(a.reserve(request({ id: 'resv_t1_scripts', threadId: T1, paths: ['scripts/build.sh'] }))).toEqual({ granted: false, conflicts: [{ threadId: 'thread_new', threadTitle: null,
    paths: ['scripts/'], expiresAt: iso(now + minutes(60)) }] });
  // A retry after a lost reply returns the stored reservation; the same id with other paths is refused.
  expect(a.reserve(request({ id: 'resv_t1_src', threadId: T1, paths: ['src/', 'README.md', 'lib/'], reason: 'Edit the app' }))).toEqual(granted);
  expect(refused(() => a.reserve(request({ id: 'resv_t1_src', threadId: T1, paths: ['src/'], reason: 'Edit the app' })))).toEqual({ status: 409, message: 'This reservation id was already used for other paths.' });
  expect(ids(a.reservations('project').records)).toEqual(['resv_new', 'resv_t1_again', 'resv_t1_src', 'resv_t2_docs']);
  // Hub authority: the owner device reserves and releases; the project must exist; minutes stay within 1 to 120.
  expect(refused(() => b.reserve(request({ id: 'resv_x', threadId: T1, paths: ['x/'] })))).toEqual({ status: 403, message: 'Only the thread owner can reserve paths for it.' });
  expect(refused(() => b.release('project', T1))).toEqual({ status: 403, message: 'Only the thread owner can release its reservations.' });
  expect(refused(() => a.reserve(request({ id: 'resv_x', threadId: T1, paths: ['x/'], projectId: 'missing' })))).toEqual({ status: 404, message: 'Project not found.' });
  expect(() => a.reserve(request({ id: 'resv_x', threadId: T1, paths: ['x/'], minutes: 121 }))).toThrow();
  expect(() => a.reserve(request({ id: 'resv_x', threadId: T1, paths: [] }))).toThrow();
});

test('reservations expire by the hub clock, release by id or for the whole thread, and old ones are pruned when the next is made (D90)', () => {
  threads(); const a = store('dev_a'); const b = store('dev_b');
  a.reserve(request({ id: 'resv_src', threadId: T1, paths: ['src/'], minutes: 30 }));
  now += minutes(29);
  expect(b.reserve(request({ id: 'resv_app_1', threadId: T2, paths: ['src/app.txt'] }))).toMatchObject({ granted: false });
  now += minutes(1);
  // At its expiry the paths are free again; the active list follows the same clock.
  expect(ids(a.reservations('project').records)).toEqual([]);
  expect(b.reserve(request({ id: 'resv_app_2', threadId: T2, paths: ['src/app.txt'] }))).toMatchObject({ granted: true });
  expect(a.release('project', T1)).toEqual({ released: 0 });
  // By id: once; another thread's id or an unknown one is not found; without an id every active one of the thread.
  a.reserve(request({ id: 'resv_docs', threadId: T1, paths: ['docs/'] })); a.reserve(request({ id: 'resv_lib', threadId: T1, paths: ['lib/'] }));
  a.reserve(request({ id: 'resv_bin', threadId: T1, paths: ['bin/'] }));
  expect(a.release('project', T1, 'resv_docs')).toEqual({ released: 1 });
  expect(a.release('project', T1, 'resv_docs')).toEqual({ released: 0 });
  expect(db.get('project-reservations', 'resv_docs', FileReservationSchema)?.document.releasedAt).toBe(iso(now));
  expect(refused(() => a.release('project', T1, 'resv_app_2'))).toEqual({ status: 404, message: 'This reservation was not found.' });
  expect(refused(() => a.release('project', T1, 'resv_missing'))).toEqual({ status: 404, message: 'This reservation was not found.' });
  expect(a.release('project', T1)).toEqual({ released: 2 });
  expect(ids(a.reservations('project').records)).toEqual(['resv_app_2']);
  expect(b.reserve(request({ id: 'resv_t2_lib', threadId: T2, paths: ['lib/', 'docs/', 'bin/'] }))).toMatchObject({ granted: true });
  // Pruning when the next reservation is made: released or expired more than a day ago goes, younger history stays. resv_src
  // expired now, resv_docs, resv_lib and resv_bin were released now, resv_app_2 and resv_t2_lib end an hour later; the refused
  // resv_app_1 was never stored.
  const stored = () => ids(db.list('project-reservations', FileReservationSchema).map((row) => row.document));
  const ended = now;
  now = ended + RESERVATION_RETENTION_MS; b.reserve(request({ id: 'resv_t2_one', threadId: T2, paths: ['one/'] }));
  expect(stored()).toEqual(['resv_app_2', 'resv_bin', 'resv_docs', 'resv_lib', 'resv_src', 'resv_t2_lib', 'resv_t2_one']);
  now += 1; b.reserve(request({ id: 'resv_t2_two', threadId: T2, paths: ['two/'] }));
  expect(stored()).toEqual(['resv_app_2', 'resv_t2_lib', 'resv_t2_one', 'resv_t2_two']);
  now = ended + minutes(60) + RESERVATION_RETENTION_MS + 1; b.reserve(request({ id: 'resv_t2_three', threadId: T2, paths: ['three/'] }));
  expect(stored()).toEqual(['resv_t2_one', 'resv_t2_three', 'resv_t2_two']);
  // Another project's reservations are not touched by this project's.
  publish(index('thread_other', 'dev_a', { projectId: 'other' }));
  a.reserve(request({ id: 'resv_other', threadId: 'thread_other', projectId: 'other', paths: ['src/'], minutes: 1 }));
  now += RESERVATION_RETENTION_MS * 2; b.reserve(request({ id: 'resv_t2_four', threadId: T2, paths: ['four/'] }));
  expect(db.get('project-reservations', 'resv_other', FileReservationSchema)).not.toBeNull();
});

test('mail: the hub stamps its time, threads read unread mail addressed to them or to all, reading marks nothing and marking is per reader (brief 5.11, 7.2)', () => {
  threads(); const a = store('dev_a'); const b = store('dev_b'); const c = store('dev_c');
  const sent = a.sendMail(mail({ id: 'mail_direct', from: T1, to: T2, at: '2020-01-01T00:00:00.000Z' }));
  expect(sent).toEqual({ revision: 1, document: mail({ id: 'mail_direct', from: T1, to: T2, revision: 1, at: iso(start) }) });
  now += 1000;
  const all = a.sendMail(mail({ id: 'mail_all', from: T1, to: 'all', subject: 'Everyone', body: 'Holding src/.' })).document;
  // The recipient reads both, oldest first, as often as it asks until it marks them; the sender and the worktree thread get nothing.
  expect(ids(b.inbox('project', T2).records)).toEqual(['mail_direct', 'mail_all']);
  expect(b.inbox('project', T2)).toEqual({ records: [sent.document, all], more: false });
  expect(c.inbox('project', T3)).toEqual({ records: [all], more: false });
  expect(a.inbox('project', T1)).toEqual({ records: [], more: false });
  expect(a.inbox('project', W)).toEqual({ records: [], more: false });
  expect(b.markRead('project', T2, ['mail_direct', 'mail_all', 'mail_direct'])).toEqual({ read: 2 });
  expect(b.inbox('project', T2).records).toEqual([]);
  expect(b.markRead('project', T2, ['mail_all', 'mail_gone'])).toEqual({ read: 0 });
  // Reading for one recipient leaves the other's copy unread.
  expect(c.inbox('project', T3).records.map((entry) => entry.readBy)).toEqual([[T2]]);
  expect(refused(() => c.markRead('project', T3, ['mail_direct']))).toEqual({ status: 403, message: 'This mail is not addressed to that thread.' });
  expect(refused(() => b.inbox('project', T3))).toEqual({ status: 403, message: 'Only the thread owner can read its mail.' });
  // A thread created after mail to all never inherits it; one the hub does not know yet gets only mail addressed to it.
  publish(index('thread_late', 'dev_c', { createdAt: iso(now + 1) }));
  expect(c.inbox('project', 'thread_late').records).toEqual([]);
  a.sendMail(mail({ id: 'mail_unknown', from: T1, to: 'thread_unpublished' }));
  expect(ids(c.inbox('project', 'thread_unpublished').records)).toEqual(['mail_unknown']);
  // Authority: the sender's device, the coordinator's device for the coordinator; mail to the coordinator is an event, never stored.
  expect(refused(() => b.sendMail(mail({ id: 'mail_forged', from: T1, to: T2 })))).toEqual({ status: 403, message: 'Only the thread owner can send its mail.' });
  expect(refused(() => a.sendMail(mail({ id: 'mail_coord', from: 'coordinator', to: 'all' })))).toEqual({ status: 403, message: 'Only the coordinator device can send the coordinator’s mail.' });
  a.assignCoordinator('project', 'dev_a', 0);
  expect(a.sendMail(mail({ id: 'mail_coord', from: 'coordinator', to: 'all', subject: 'Plan' })).document.from).toBe('coordinator');
  expect(refused(() => b.sendMail(mail({ id: 'mail_coord_b', from: 'coordinator', to: 'all' })))).toMatchObject({ status: 403 });
  expect(refused(() => b.sendMail(mail({ id: 'mail_up', from: T2, to: 'coordinator' })))).toMatchObject({ status: 400 });
  expect(refused(() => b.sendMail(mail({ id: 'mail_read', from: T2, to: T1, readBy: [T1] })))).toEqual({ status: 400, message: 'New mail cannot already be read.' });
  expect(refused(() => b.sendMail(mail({ id: 'mail_x', from: T2, to: T1, projectId: 'missing' })))).toEqual({ status: 404, message: 'Project not found.' });
  // A retry returns the stored mail whatever its time and readers; the same id with another text is refused.
  now += 5000;
  expect(a.sendMail(mail({ id: 'mail_direct', from: T1, to: T2 }))).toEqual({ revision: 2, document: { ...sent.document, revision: 2, readBy: [T2] } });
  expect(refused(() => a.sendMail(mail({ id: 'mail_direct', from: T1, to: T2, body: 'Other.' })))).toEqual({ status: 409, message: 'This mail id was already used for a different message.' });
  expect(ids(c.inbox('project', T3).records)).toEqual(['mail_all', 'mail_coord']);
});

test('the inbox pages at 100 mails or about 1 MiB, oldest first, and announces more until everything is marked (D285)', () => {
  threads(); const a = store('dev_a'); const b = store('dev_b');
  for (let n = 0; n < 150; n += 1) { a.sendMail(mail({ id: `mail_${String(n).padStart(3, '0')}`, from: T1, to: T2 })); now -= 1000; }
  // Sent with a clock that runs backwards: the newest id is the oldest mail.
  const first = b.inbox('project', T2);
  expect(first.records).toHaveLength(100); expect(first.more).toBe(true);
  expect(first.records[0]!.id).toBe('mail_149'); expect(first.records[99]!.id).toBe('mail_050');
  b.markRead('project', T2, ids(first.records));
  const second = b.inbox('project', T2);
  expect(second.records).toHaveLength(50); expect(second.more).toBe(false);
  b.markRead('project', T2, ids(second.records));
  // Escaped control characters make an 8,000-character body about 48 KB of JSON.
  for (let n = 0; n < 30; n += 1) a.sendMail(mail({ id: `mail_big_${n}`, from: T1, to: T2, body: '\u0001'.repeat(8000) }));
  const big = b.inbox('project', T2);
  expect(big.more).toBe(true); expect(big.records.length).toBeLessThan(30);
  expect(big.records.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0)).toBeLessThanOrEqual(MAIL_PAGE_BYTES);
});

test('mail older than 14 days goes once every recipient read it or ended, younger mail and unread mail of a running recipient stay (D90, D286)', () => {
  threads(); const a = store('dev_a'); const b = store('dev_b'); const c = store('dev_c');
  a.sendMail(mail({ id: 'mail_read', from: T1, to: T2 })); b.markRead('project', T2, ['mail_read']);
  a.sendMail(mail({ id: 'mail_unread', from: T1, to: T2 }));
  a.sendMail(mail({ id: 'mail_to_ended', from: T1, to: T3 }));
  a.sendMail(mail({ id: 'mail_all', from: T1, to: 'all' })); b.markRead('project', T2, ['mail_all']);
  a.sendMail(mail({ id: 'mail_to_nobody', from: T1, to: 'thread_never_published' }));
  now += MAIL_RETENTION_MS - 1000;
  a.sendMail(mail({ id: 'mail_young', from: T1, to: T2 })); b.markRead('project', T2, ['mail_young']);
  const stored = () => ids(db.list('project-mail', ProjectMailSchema).map((row) => row.document));
  expect(stored()).toEqual(['mail_all', 'mail_read', 'mail_to_ended', 'mail_to_nobody', 'mail_unread', 'mail_young']);
  // T3 ends without reading its mail; 14 days have passed for the first five.
  publish(index(T3, 'dev_c', { state: 'done', endedAt: iso(now) }));
  now += 2000;
  a.sendMail(mail({ id: 'mail_trigger_1', from: T1, to: T2 }));
  // Kept: the unread mail of running T2 and the young one. mail_all went: T2 read it, T3 ended, T1 sent it, W is no main thread.
  expect(stored()).toEqual(['mail_trigger_1', 'mail_unread', 'mail_young']);
  b.markRead('project', T2, ['mail_unread']);
  now += 1000; a.sendMail(mail({ id: 'mail_trigger_2', from: T1, to: T2 }));
  expect(stored()).toEqual(['mail_trigger_1', 'mail_trigger_2', 'mail_young']);
  // Mail to all waits for every main recipient that is still running.
  publish(index('thread_t4', 'dev_c', { createdAt: iso(now - 1) }));
  a.sendMail(mail({ id: 'mail_all_2', from: T1, to: 'all' })); b.markRead('project', T2, ['mail_all_2']);
  now += MAIL_RETENTION_MS + 1000; a.sendMail(mail({ id: 'mail_trigger_3', from: T1, to: T2 }));
  expect(stored()).toContain('mail_all_2');
  c.markRead('project', 'thread_t4', ['mail_all_2']);
  now += 1000; a.sendMail(mail({ id: 'mail_trigger_4', from: T1, to: T2 }));
  expect(stored()).not.toContain('mail_all_2');
  // Another project's old mail is not touched by this project's sends.
  publish(index('thread_o', 'dev_a', { projectId: 'other' })); publish(index('thread_p', 'dev_b', { projectId: 'other' }));
  a.sendMail(mail({ id: 'mail_other', from: 'thread_o', to: 'thread_p', projectId: 'other' }));
  b.markRead('other', 'thread_p', ['mail_other']);
  now += MAIL_RETENTION_MS * 2; a.sendMail(mail({ id: 'mail_trigger_5', from: T1, to: T2 }));
  expect(db.get('project-mail', 'mail_other', ProjectMailSchema)).not.toBeNull();
});

/** A device's mail service over the in-process hub, collecting what reaches the coordinator. */
function mailService(deviceId: string, hub: ProjectHub = access(deviceId), local: Map<string, Thread> = new Map()) {
  const delivered: CoordinatorEvent[] = [];
  const service = new MailService({ hub, toCoordinator: async (_projectId, event) => { delivered.push(event); }, local: (threadId) => local.get(threadId), now: () => now });
  return Object.assign(service, { delivered });
}
function tools(scope: ProjectScope, service: MailService) {
  return new ProjectTools(scope, { isCurrent: () => true, call: (current, name, input) => current.kind === 'thread' ? service.threadTool(current, name, input) : Promise.reject(new Error('No coordinator here.')),
    memory: () => { throw new Error('No memory in this test.'); } }, new SecretRedactor());
}
const result = async (call: Promise<{ result: unknown }>) => (await call).result as Record<string, unknown>;

test('main thread tools reserve, mail each other and the coordinator, read the inbox once, and repeat nothing on a retry (brief 7.2, 9.3; PJ6 steps 1-2)', async () => {
  threads(); const mailA = mailService('dev_a'); const mailB = mailService('dev_b');
  const t1 = tools({ kind: 'thread', projectId: 'project', threadId: T1, turn: 1, isolation: 'main' }, mailA);
  const t2 = tools({ kind: 'thread', projectId: 'project', threadId: T2, turn: 1, isolation: 'main' }, mailB);
  const held = await result(t1.call('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' }));
  expect(held).toEqual({ schema: 'reserve-result-v1', granted: true, id: expect.stringMatching(/^resv_[0-9a-f]{40}$/) });
  expect(await result(t2.call('jevellan_reserve', { paths: ['src/app.txt'] }))).toEqual({ schema: 'reserve-result-v1', granted: false,
    conflicts: [{ threadTitle: 'T1 title', paths: ['src/'], expiresAt: iso(start + minutes(60)) }] });
  // The same call again (a transport retry) holds the same reservation; after a release it is asked for again under a new id.
  expect(await result(t1.call('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' }))).toEqual(held);
  expect(ids((await access('dev_a').reservations('project')))).toEqual([held.id]);
  expect(await result(t1.call('jevellan_release', { id: held.id }))).toEqual({ schema: 'release-result-v1', released: 1 });
  const again = await result(t1.call('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' }));
  expect(again).toMatchObject({ granted: true }); expect(again.id).not.toBe(held.id);
  expect(ids(await access('dev_a').reservations('project'))).toEqual([again.id]);
  expect(await result(t1.call('jevellan_reserve', { paths: ['src/'], reason: 'Edit the app' }))).toEqual(again);
  expect(await rejects(t1.call('jevellan_release', { id: 'resv_missing' }))).toEqual({ status: 404, message: 'This reservation was not found.' });
  // A holder the hub has no index for yet reads as an unknown thread.
  store('dev_c').reserve(request({ id: 'resv_anon', threadId: 'thread_anon', paths: ['assets/'] }));
  expect(await result(t1.call('jevellan_reserve', { paths: ['assets/logo.png'] }))).toEqual({ schema: 'reserve-result-v1', granted: false,
    conflicts: [{ threadTitle: UNKNOWN_THREAD, paths: ['assets/'], expiresAt: iso(start + minutes(60)) }] });
  expect(await rejects(t1.call('jevellan_reserve', { paths: ['src/'], minutes: 121 }))).toMatchObject({ status: 400, message: expect.stringMatching(/^minutes: .*\. Check the tool input\.$/) });

  // Mail in both directions, read once.
  const sent = await result(t1.call('jevellan_mail_send', { to: T2, subject: 'Heads up', body: 'I am changing src/app.txt.' }));
  expect(sent).toEqual({ schema: 'mail-send-result-v1', mailId: expect.stringMatching(/^mail_[0-9a-f]{40}$/) });
  expect(await result(t1.call('jevellan_mail_send', { to: T2, subject: 'Heads up', body: 'I am changing src/app.txt.' }))).toEqual(sent);
  expect(await result(t2.call('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [{ id: sent.mailId, from: T1, fromTitle: 'T1 title', subject: 'Heads up',
    body: 'I am changing src/app.txt.', at: iso(start) }] });
  expect(await result(t2.call('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [] });
  await t2.call('jevellan_mail_send', { to: T1, subject: 'Ack', body: 'I will wait.' });
  expect(await result(t1.call('jevellan_mail_inbox', {}))).toMatchObject({ mail: [{ from: T2, fromTitle: 'T2 title', subject: 'Ack', body: 'I will wait.' }] });
  expect(db.list('project-mail', ProjectMailSchema)).toHaveLength(2);

  // To the coordinator: one mail event, its id derived from the mail, so a repeated call is deduplicated by the coordinator queue.
  const up = await result(t2.call('jevellan_mail_send', { to: 'coordinator', subject: 'Waiting on T1', body: 'Holding src/app.txt until T1 publishes.' }));
  await t2.call('jevellan_mail_send', { to: 'coordinator', subject: 'Waiting on T1', body: 'Holding src/app.txt until T1 publishes.' });
  expect(mailB.delivered).toHaveLength(2); expect(mailB.delivered[0]).toEqual(mailB.delivered[1]);
  expect(mailB.delivered[0]).toEqual({ schema: 'coordinator-event-v1', id: expect.stringMatching(/^cev_[0-9a-f]{40}$/), at: iso(start), kind: 'mail', mailId: up.mailId, fromThreadId: T2,
    subject: 'Waiting on T1', body: 'Holding src/app.txt until T1 publishes.' });
  expect(db.list('project-mail', ProjectMailSchema)).toHaveLength(2);
  // The event is a valid queue document (ids, subject and body bounds).
  expect(CoordinatorEventSchema.parse(mailB.delivered[0])).toEqual(mailB.delivered[0]);
  const titles = new Map([[T2, 'T2 title']]);
  expect(eventLine(mailB.delivered[0]!, { title: (id) => titles.get(id), base: 'main' })).toBe(`[mail from "T2 title" (${T2})] Waiting on T1\nHolding src/app.txt until T1 publishes.`);
  // Mail to all reaches every other main thread.
  await t1.call('jevellan_mail_send', { to: 'all', subject: 'Published', body: 'src/ is free.' });
  expect(await result(t2.call('jevellan_mail_inbox', {}))).toMatchObject({ mail: [{ from: T1, subject: 'Published' }] });
  expect(await result(tools({ kind: 'thread', projectId: 'project', threadId: T3, turn: 4, isolation: 'main' }, mailService('dev_c')).call('jevellan_mail_inbox', {})))
    .toMatchObject({ mail: [{ from: T1, fromTitle: 'T1 title', subject: 'Published' }] });
  expect(await result(t1.call('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [] });
});

test('mail refusals are sentences the model can act on: unknown, worktree, ended and self recipients, nobody on main, the coordinator’s own address (brief 7)', async () => {
  threads(); const t1 = tools({ kind: 'thread', projectId: 'project', threadId: T1, turn: 1, isolation: 'main' }, mailService('dev_a'));
  const send = (to: string) => rejects(t1.call('jevellan_mail_send', { to, subject: 'Hi', body: '' }));
  expect(await send('thread_missing')).toEqual({ status: 404, message: THREAD_NOT_FOUND });
  expect(await send(W)).toEqual({ status: 409, message: MAIL_WORKTREE_THREAD });
  expect(await send(T1)).toEqual({ status: 400, message: MAIL_TO_SELF });
  expect(await send('the other thread')).toEqual({ status: 400, message: THREAD_MAIL_TO });
  publish(index('thread_x', 'dev_b', { projectId: 'other' }));
  expect(await send('thread_x')).toEqual({ status: 404, message: THREAD_NOT_FOUND });
  publish(index(T3, 'dev_c', { state: 'stopped', endedAt: iso(now) }));
  expect(await send(T3)).toEqual({ status: 409, message: MAIL_THREAD_ENDED });
  publish(index(T2, 'dev_b', { state: 'done', endedAt: iso(now) }));
  expect(await send('all')).toEqual({ status: 409, message: MAIL_NO_RECIPIENTS });
  expect(await rejects(t1.call('jevellan_mail_send', { to: T2, subject: '', body: '' }))).toMatchObject({ status: 400, message: expect.stringMatching(/^subject: /) });
  expect(await rejects(t1.call('jevellan_mail_send', { to: T2, subject: 'Hi', body: 'x'.repeat(8001) }))).toMatchObject({ status: 400, message: expect.stringMatching(/^body: /) });
  // This device's own threads are known before their index reaches the hub.
  const local = new Map([['thread_fresh', { title: 'Fresh', projectId: 'project', isolation: 'main', state: 'preparing' } as Thread]]);
  const fresh = tools({ kind: 'thread', projectId: 'project', threadId: T1, turn: 2, isolation: 'main' }, mailService('dev_a', access('dev_a'), local));
  expect(await result(fresh.call('jevellan_mail_send', { to: 'thread_fresh', subject: 'Hi', body: '' }))).toMatchObject({ schema: 'mail-send-result-v1' });
  expect(db.list('project-mail', ProjectMailSchema).map((row) => row.document.to)).toEqual(['thread_fresh']);
  expect(await rejects(mailService('dev_a').coordinatorSend('project', 1, { to: 'coordinator', subject: 'Hi', body: '' }))).toEqual({ status: 400, message: COORDINATOR_MAIL_TO });
});

test('the coordinator mails main threads by id or all, its chat line names the thread, and inboxes show it as Coordinator (brief 7.1, 8.1)', async () => {
  threads(); store('dev_a').assignCoordinator('project', 'dev_a', 0);
  const hub = access('dev_a'); const service = mailService('dev_a', hub);
  const handlers = coordinatorToolHandlers({ deviceId: 'dev_a', deviceName: 'Mac mini', threads: {} as never, store: { get: () => undefined }, decisions: {} as never, pullRequests: {} as never,
    hub, ledgers: {} as never, mail: service, roster: async () => { throw new Error('No roster in this test.'); }, memory: async () => { throw new Error('No memory in this test.'); }, now: () => now });
  const scope = { kind: 'coordinator', projectId: 'project', turn: 3 } as const;
  const call = (input: unknown) => handlers.call(scope, 'jevellan_mail_send', BridgeToolSchemas.jevellan_mail_send.parse(input), new AbortController().signal) as Promise<Record<string, unknown>>;
  const direct = await call({ to: T2, subject: 'Plan', body: 'Wait for T1.' });
  expect(direct).toEqual({ schema: 'mail-send-result-v1', mailId: expect.stringMatching(/^mail_/) });
  expect(await handlers.line('jevellan_mail_send', { to: T2, subject: 'Plan', body: 'Wait for T1.' }, { ok: true, result: direct }, scope))
    .toEqual({ summary: 'Sent mail to "T2 title": Plan', threadId: T2 });
  now += 1000; await call({ to: 'all', subject: 'Freeze', body: 'No edits to src/ until T1 publishes.' });
  expect(await handlers.line('jevellan_mail_send', { to: 'all', subject: 'Freeze' }, { ok: true, result: {} }, scope)).toEqual({ summary: 'Sent mail to all: Freeze' });
  expect(await handlers.line('jevellan_mail_send', { to: W, subject: 'Hi' }, { ok: false, error: MAIL_WORKTREE_THREAD }, scope))
    .toEqual({ summary: `Could not send mail to "W title": ${MAIL_WORKTREE_THREAD}`, threadId: W });
  const read = (deviceId: string, threadId: string) => tools({ kind: 'thread', projectId: 'project', threadId, turn: 1, isolation: 'main' }, mailService(deviceId)).call('jevellan_mail_inbox', {});
  expect((await result(read('dev_b', T2))).mail).toEqual([
    { id: direct.mailId, from: 'coordinator', fromTitle: COORDINATOR_MAIL_NAME, subject: 'Plan', body: 'Wait for T1.', at: iso(start) },
    expect.objectContaining({ from: 'coordinator', fromTitle: COORDINATOR_MAIL_NAME, subject: 'Freeze' }),
  ]);
  expect((await result(read('dev_a', T1))).mail).toMatchObject([{ subject: 'Freeze' }]);
  // Its retry in the same turn sends nothing new; mail to itself is refused.
  expect(await call({ to: T2, subject: 'Plan', body: 'Wait for T1.' })).toEqual(direct);
  expect(db.list('project-mail', ProjectMailSchema)).toHaveLength(2);
  expect(await rejects(call({ to: 'coordinator', subject: 'Hi', body: '' }))).toEqual({ status: 400, message: COORDINATOR_MAIL_TO });
});

test('a main thread gives its reservations back when it stops or fails; a worktree thread asks the hub nothing (brief 7.2, design 3.6)', async () => {
  threads(); const paths = new ProjectPaths(new Homes(join(root, 'device-a'), join(root, 'user'))); const ledgers = new ProjectLedgers(paths);
  const threadStore = new ThreadStore(paths, ledgers, new ThreadIndexPublisher(access('dev_a')));
  const placement = PlacementRecordSchema.parse({ schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: ['isolation'], isolation: 'main', runtime: 'fake', modelId: 'fixture',
    model: 'scripted-model', effortRequested: 'high', effortEffective: 'high', deviceId: 'dev_a', accountId: 'acc_fixture', eligibleModels: ['fixture'], excludedModels: [],
    eligibleDevices: ['dev_a'], excludedDevices: [], jevCalls: [], decidedAt: iso(start) });
  const thread = (id: string, fields: Partial<Thread>) => ThreadSchema.parse({ schema: 'project-thread-v1', id, projectId: 'project', title: `${id} title`, task: 'Edit src/.', createdAt: iso(start),
    createdBy: 'owner', state: 'running', isolation: 'main', placement, ownerDeviceId: 'dev_a', coordinatorDeviceId: 'dev_a', cwd: '/checkout', baseBranch: 'main', baseCommit: 'a'.repeat(40),
    turns: 1, turnAllowance: 30, queuedMessages: [], verificationAttempts: 0, ...fields });
  const real = mailService('dev_a'); const released: string[] = [];
  const context = { deviceId: 'dev_a', deviceName: 'Mac mini', redactor: new SecretRedactor(), store: threadStore, ledgers, now: () => now, rested: () => undefined,
    decisions: { withdrawTurnLimit: async () => undefined }, toCoordinator: async () => undefined, enterOperation: () => () => undefined,
    project: async () => { throw new Error('The checkout is gone.'); },
    mail: { threadTool: real.threadTool.bind(real), releaseThread: async (projectId: string, threadId: string) => { released.push(threadId); return real.releaseThread(projectId, threadId); } },
  } as unknown as ThreadRunnerContext;
  const a = store('dev_a');
  for (const id of [T1, 'thread_failing']) a.reserve(request({ id: `resv_${id}`, threadId: id, paths: [`${id}/`] }));
  threadStore.create(thread(T1, {}), { modelLabel: 'Fixture', accountLabel: 'Fixture account' });
  await new ThreadRunner(T1, context).stop('Stopped by you.', false);
  expect(threadStore.get(T1)!.state).toBe('stopped');
  expect(released).toEqual([T1]); expect(ids(a.reservations('project').records)).toEqual(['resv_thread_failing']);
  // A preparation that fails ends the thread and releases too.
  threadStore.create(thread('thread_failing', { state: 'preparing' }), { modelLabel: 'Fixture', accountLabel: 'Fixture account' });
  await new ThreadRunner('thread_failing', context).prepare();
  expect(threadStore.get('thread_failing')).toMatchObject({ state: 'failed' });
  expect(released).toEqual([T1, 'thread_failing']); expect(a.reservations('project').records).toEqual([]);
  // Worktree threads hold no reservations and never ask.
  threadStore.create(thread(W, { isolation: 'worktree', placement: { ...placement, isolation: 'worktree' } }), { modelLabel: 'Fixture', accountLabel: 'Fixture account' });
  await new ThreadRunner(W, context).stop('Stopped by you.', false);
  expect(released).toEqual([T1, 'thread_failing']);
  // An unreachable hub does not stop the stop: reservations are advisory and expire.
  threadStore.create(thread('thread_offline', {}), { modelLabel: 'Fixture', accountLabel: 'Fixture account' });
  const offline = { ...context, mail: { threadTool: real.threadTool.bind(real), releaseThread: async () => { throw new HubUnavailable('Fixture hub'); } } } as ThreadRunnerContext;
  await new ThreadRunner('thread_offline', offline).stop('Stopped by you.', false);
  expect(threadStore.get('thread_offline')!.state).toBe('stopped');
});

test('members over HTTP: one of two simultaneous overlapping reservations wins, replies are checked, and a lost reply never loses mail (D285)', { timeout: 60_000 }, async () => {
  const appRoot = join(root, 'app'); mkdirSync(join(appRoot, 'user'), { recursive: true });
  const app = new Application({ homes: new Homes(join(appRoot, 'hub'), join(appRoot, 'user')), timers: false, runtimes: () => new Map() });
  const server: Server = createDaemon({ application: app }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const hubDevice = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hubDevice.document, url: base }, hubDevice.revision);
    await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` });
    app.hub.put('projects', 'project', ProjectSchema, { schema: 'project-v1', id: 'project', name: 'project', paths: {}, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
    const drop = { operation: '' };
    const member = async (id: string) => {
      const redactor = new SecretRedactor();
      const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code,
        device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
      // Drops the hub's reply once for the named operation after the hub committed it.
      const fetcher: typeof fetch = async (...args) => {
        const response = await fetch(...args); const body = args[1]?.body;
        if (drop.operation && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === drop.operation) { drop.operation = ''; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
        return response;
      };
      return new MemberProjectStore(new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, fetch: fetcher }));
    };
    const left = await member('left'); const right = await member('right');
    await left.publishThread(index('thread_l', 'left', { title: 'Left work' }), 1); await right.publishThread(index('thread_r', 'right', { title: 'Right work' }), 1);
    const outcomes = await Promise.all([left.reserve(request({ id: 'resv_l', threadId: 'thread_l', paths: ['src/'] })), right.reserve(request({ id: 'resv_r', threadId: 'thread_r', paths: ['src/app.txt'] }))]);
    expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
    const loser = outcomes.find((outcome) => !outcome.granted)!;
    expect(loser).toEqual({ granted: false, conflicts: [expect.objectContaining({ threadTitle: outcomes[0]!.granted ? 'Left work' : 'Right work' })] });
    expect(await left.reservations('project')).toHaveLength(1);
    // Mail through the members; a lost mark reply still returns the mail (it was marked), a lost inbox reply returns an error and loses nothing.
    const sender = mailService('left', left); const reader = mailService('right', right);
    const leftTools = tools({ kind: 'thread', projectId: 'project', threadId: 'thread_l', turn: 1, isolation: 'main' }, sender);
    const rightTools = tools({ kind: 'thread', projectId: 'project', threadId: 'thread_r', turn: 1, isolation: 'main' }, reader);
    await leftTools.call('jevellan_mail_send', { to: 'thread_r', subject: 'First', body: 'One.' });
    drop.operation = 'mail-read';
    expect(await result(rightTools.call('jevellan_mail_inbox', {}))).toMatchObject({ mail: [{ subject: 'First', fromTitle: 'Left work' }] });
    expect(await result(rightTools.call('jevellan_mail_inbox', {}))).toEqual({ schema: 'mail-inbox-result-v1', mail: [] });
    await leftTools.call('jevellan_mail_send', { to: 'thread_r', subject: 'Second', body: 'Two.' });
    drop.operation = 'mail-inbox';
    await expect(rightTools.call('jevellan_mail_inbox', {})).rejects.toBeInstanceOf(HubUnavailable);
    expect(await result(rightTools.call('jevellan_mail_inbox', {}))).toMatchObject({ mail: [{ subject: 'Second' }] });
    // Refusals keep their sentences across the transport.
    expect(await rejects(right.reserve(request({ id: 'resv_forged', threadId: 'thread_l', paths: ['x/'] })))).toEqual({ status: 403, message: 'Only the thread owner can reserve paths for it.' });
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await app.close();
  }
});

test('a member refuses hub replies that do not match the request (D3 pattern)', async () => {
  const reply = (value: object) => new MemberProjectStore({ projects: async (_collection: string, input: { operation: string }) => ({ schema: 'project-hub-result-v1', operation: input.operation, ...value }) } as never);
  const wanted = request({ id: 'resv_1', threadId: T1, paths: ['src/'] });
  await expect(reply({ reservation: null, conflicts: [] }).reserve(wanted)).rejects.toBeInstanceOf(HubProtocolError);
  await expect(reply({ reservation: null, conflicts: [{ threadId: T1, threadTitle: 'Mine', paths: ['src/'], expiresAt: iso(start) }] }).reserve(wanted)).rejects.toBeInstanceOf(HubProtocolError);
  await expect(reply({ reservation: null, conflicts: [{ threadId: T2, threadTitle: 'Other', paths: ['docs/'], expiresAt: iso(start) }] }).reserve(wanted)).rejects.toBeInstanceOf(HubProtocolError);
  const other = { schema: 'file-reservation-v1', revision: 1, id: 'resv_2', projectId: 'project', threadId: T1, deviceId: 'dev_a', paths: ['src/'], reason: '', createdAt: iso(start), expiresAt: iso(start) };
  await expect(reply({ reservation: { revision: 1, document: other }, conflicts: [] }).reserve(wanted)).rejects.toBeInstanceOf(HubProtocolError);
  expect(await reply({ reservation: { revision: 1, document: { ...other, id: 'resv_1' } }, conflicts: [] }).reserve(wanted)).toMatchObject({ granted: true });
  const unread = mail({ id: 'mail_1', from: T1, to: T2, revision: 1 });
  expect(await reply({ records: [unread], more: false }).inbox('project', T2)).toEqual({ records: [unread], more: false });
  for (const records of [[{ ...unread, to: T3 }], [{ ...unread, readBy: [T2] }], [unread, unread], [{ ...unread, projectId: 'other' }]]) {
    await expect(reply({ records, more: false }).inbox('project', T2)).rejects.toBeInstanceOf(HubProtocolError);
  }
  await expect(reply({ records: [], more: true }).inbox('project', T2)).rejects.toBeInstanceOf(HubProtocolError);
  await expect(reply({ record: { revision: 1, document: { ...unread, body: 'Changed.' } } }).sendMail(mail({ id: 'mail_1', from: T1, to: T2 }))).rejects.toBeInstanceOf(HubProtocolError);
  expect(await reply({ record: { revision: 2, document: { ...unread, revision: 2, readBy: [T2] } } }).sendMail(mail({ id: 'mail_1', from: T1, to: T2 }))).toMatchObject({ revision: 2 });
});
