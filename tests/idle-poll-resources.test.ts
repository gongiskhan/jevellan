import { afterEach, expect, test, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Homes, ProjectWorkSettingsSchema, StoredProjectWorkSettingsSchema, TimestampSchema, defaultProjectWorkSettings } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { ThreadGit } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { git, projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
let hub: HubDatabase | undefined;
let root: string | undefined;
afterEach(async () => {
  try { await fixture?.close(); } finally {
    fixture = undefined; hub?.close(); hub = undefined;
    if (root) rmSync(root, { recursive: true, force: true }); root = undefined;
  }
});

test('idle worktree indexes bound subprocesses while observing every new head', async () => {
  const f = fixture = await projectFixture({ github: false });
  const ids: string[] = [];
  for (let n = 0; n < 8; n++) {
    f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'No source change is needed.' }), forThread());
    const created = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: `idle_${n}`,
      title: `Inspect ${n}`, task: 'Inspect without changes.', modelId: 'fixture', deviceId: f.app.device.deviceId });
    await f.waitFor(() => f.thread(created.threadId), thread => thread.state === 'idle');
    await f.app.projectWork.idle(); ids.push(created.threadId);
  }
  const clone = structuredClone, schema = f.thread(ids[0]!).schema; let idleCopies = 0;
  const copies = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if (value && typeof value === 'object' && 'schema' in value && value.schema === schema && 'id' in value && typeof value.id === 'string' && ids.includes(value.id)) idleCopies++;
    return clone(value, options);
  });
  try { for (let n = 0; n < 3; n++) await f.app.projectWork.threads.sweepWaiting(); }
  finally { copies.mockRestore(); }
  expect(idleCopies, 'Waiting sweeps must select candidates before copying full idle thread payloads.').toBe(0);
  let launches = 0;
  const spawned = () => { launches++; }, children = channel('child_process');
  children.subscribe(spawned);
  try { for (let n = 0; n < 3; n++) await f.app.projectWork.threads.refreshIndexes(); }
  finally { children.unsubscribe(spawned); }
  for (const id of ids) expect(f.local(id).fixable?.publish).toBe(false);
  const changed = f.thread(ids[0]!);
  git(changed.cwd, 'commit', '--allow-empty', '-m', 'New fixture head');
  await f.app.projectWork.threads.refreshIndexes(); expect(f.local(changed.id).fixable?.publish).toBe(true);
  git(changed.cwd, 'reset', '--hard', changed.baseCommit);
  await f.app.projectWork.threads.refreshIndexes(); expect(f.local(changed.id).fixable?.publish).toBe(false);
  expect(launches, 'Three unchanged polls of eight worktrees must use at most two subprocesses per project poll.').toBeLessThanOrEqual(6);
}, 120_000);

test('repeated project settings validate a supported time zone without reconstructing its formatter', () => {
  const settings = defaultProjectWorkSettings('project'); settings.nightlyWindow.timezone = 'Asia/Tokyo';
  const formatter = vi.spyOn(Intl, 'DateTimeFormat'); let constructions: number;
  try {
    for (let n = 0; n < 250; n++) expect(ProjectWorkSettingsSchema.parse(settings).nightlyWindow.timezone).toBe('Asia/Tokyo');
    constructions = formatter.mock.calls.filter(([, options]) => options?.timeZone === 'Asia/Tokyo').length;
  } finally { formatter.mockRestore(); }
  expect(ProjectWorkSettingsSchema.safeParse({ ...settings, nightlyWindow: { ...settings.nightlyWindow, timezone: 'Invalid/Zone' } }).success).toBe(false);
  expect(ProjectWorkSettingsSchema.safeParse({ ...settings, unknownField: true }).success).toBe(false);
  expect(ProjectWorkSettingsSchema.parse({ ...settings, nightlyWindow: { ...settings.nightlyWindow, timezone: 'Etc/UTC' } }).nightlyWindow.timezone).toBe('Etc/UTC');
  expect(constructions!, 'A supported time zone is stable for the lifetime of this Intl implementation.').toBeLessThanOrEqual(1);
});

test('idle nonempty worktree indexes batch fresh commit ranges', async () => {
  const f = fixture = await projectFixture({ github: false }), ids: string[] = [];
  for (let n = 0; n < 8; n++) {
    f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'Inspection finished.' }), forThread());
    const created = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: `nonempty_${n}`,
      title: `Inspect ${n}`, task: 'Inspect without changes.', modelId: 'fixture', deviceId: f.app.device.deviceId });
    await f.waitFor(() => f.thread(created.threadId), thread => thread.state === 'idle');
    await f.app.projectWork.idle(); ids.push(created.threadId);
    git(f.thread(created.threadId).cwd, 'commit', '--allow-empty', '-m', 'Fixture work');
  }
  let launches = 0; const spawned = () => { launches++; }, children = channel('child_process'); children.subscribe(spawned);
  try { for (let n = 0; n < 3; n++) await f.app.projectWork.threads.refreshIndexes(); }
  finally { children.unsubscribe(spawned); }
  expect(ids.every(id => f.local(id).fixable?.publish)).toBe(true);
  expect(launches, 'Nonempty ranges sharing a base must not spawn a separate Git process for every idle thread.').toBeLessThanOrEqual(6);
  const reset = f.thread(ids[0]!); git(reset.cwd, 'reset', '--hard', reset.baseCommit);
  const detached = f.thread(ids[1]!); git(detached.cwd, 'checkout', '--detach');
  await f.app.projectWork.threads.refreshIndexes(); expect(f.local(reset.id).fixable?.publish).toBe(false); expect(f.local(detached.id).fixable?.publish).toBe(true);
  const run = ThreadGit.prototype.run; let refused = 0;
  const unavailable = vi.spyOn(ThreadGit.prototype, 'run').mockImplementation(function(this: ThreadGit, ...args: Parameters<ThreadGit['run']>) {
    if (args[1][0] === 'for-each-ref' && args[1].some(arg => arg.includes('ahead-behind:'))) { refused++; return Promise.reject(new Error('Simulated unsupported Git format.')); }
    return run.apply(this, args);
  });
  try {
    await f.app.projectWork.threads.refreshIndexes(); expect(refused).toBeGreaterThan(0);
    expect(f.local(reset.id).fixable?.publish).toBe(false); expect(ids.slice(1).every(id => f.local(id).fixable?.publish)).toBe(true);
  } finally { unavailable.mockRestore(); }
  const changed = f.thread(ids[2]!); let moved = false;
  const changing = vi.spyOn(ThreadGit.prototype, 'run').mockImplementation(function(this: ThreadGit, ...args: Parameters<ThreadGit['run']>) {
    if (!moved && args[1][0] === 'for-each-ref' && args[1].some(arg => arg.includes('ahead-behind:'))) { moved = true; git(changed.cwd, 'reset', '--hard', changed.baseCommit); }
    return run.apply(this, args);
  });
  try { await f.app.projectWork.threads.refreshIndexes(); expect(moved).toBe(true); expect(f.local(changed.id).fixable?.publish).toBe(false); }
  finally { changing.mockRestore(); }
}, 120_000);

test('idle nonempty worktrees with distinct bases share one fresh range query', async () => {
  const f = fixture = await projectFixture({ github: false, remote: false }), ids: string[] = [];
  for (let n = 0; n < 8; n++) {
    git(f.checkout, 'commit', '--allow-empty', '-m', `Fixture base ${n}`);
    f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'Inspection finished.' }), forThread());
    const created = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: `distinct_${n}`,
      title: `Inspect ${n}`, task: 'Inspect without changes.', modelId: 'fixture', deviceId: f.app.device.deviceId });
    await f.waitFor(() => f.thread(created.threadId), thread => thread.state === 'idle');
    await f.app.projectWork.idle(); ids.push(created.threadId);
    git(f.thread(created.threadId).cwd, 'commit', '--allow-empty', '-m', 'Fixture work');
  }
  expect(new Set(ids.map(id => f.thread(id).baseCommit)).size).toBe(8);
  let launches = 0; const spawned = () => { launches++; }, children = channel('child_process'); children.subscribe(spawned);
  try { for (let n = 0; n < 3; n++) await f.app.projectWork.threads.refreshIndexes(); }
  finally { children.unsubscribe(spawned); }
  expect(ids.every(id => f.local(id).fixable?.publish)).toBe(true);
  expect(launches, 'Different base commits must not turn a project poll back into one subprocess per thread.').toBeLessThanOrEqual(6);
  const behind = f.thread(ids[4]!); git(behind.cwd, 'reset', '--hard', f.thread(ids[1]!).baseCommit);
  await f.app.projectWork.threads.refreshIndexes(); expect(f.local(behind.id).fixable?.publish).toBe(false);
  expect(ids.filter(id => id !== behind.id).every(id => f.local(id).fixable?.publish)).toBe(true);
}, 120_000);

test('unchanged hub reads reuse bounded query plans while validating fresh rows', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-query-resources-')); mkdirSync(join(root, 'user'));
  const database = hub = new HubDatabase(new Homes(join(root, 'data'), join(root, 'user')), 'hub');
  const schema = z.strictObject({ schema: z.literal('poll-resource-v1'), group: z.string(), value: z.number().int() });
  database.put('resource-rows', 'first', schema, { schema: 'poll-resource-v1', group: 'one', value: 1 }, 0);
  database.put('resource-rows', 'second', schema, { schema: 'poll-resource-v1', group: 'two', value: 2 }, 0);
  const prepared = vi.spyOn(database.db, 'prepare'); let preparations: number;
  try {
    for (let n = 0; n < 40; n++) {
      expect(database.get('resource-rows', 'first', schema)?.document.value).toBe(1);
      expect(database.list('resource-rows', schema).map(row => row.document.value)).toEqual([1, 2]);
      expect(database.listByField('resource-rows', 'group', 'two', schema).map(row => row.document.value)).toEqual([2]);
    }
    preparations = prepared.mock.calls.length;
  } finally { prepared.mockRestore(); }
  const exposed = database.get('resource-rows', 'first', schema)!; exposed.document.value = 99;
  expect(database.get('resource-rows', 'first', schema)?.document.value).toBe(1);
  database.put('resource-rows', 'first', schema, { schema: 'poll-resource-v1', group: 'three', value: 3 }, 1);
  expect(database.get('resource-rows', 'first', schema)?.document.value).toBe(3);
  expect(database.listByField('resource-rows', 'group', 'three', schema).map(row => row.document.value)).toEqual([3]);
  expect(() => database.get('resource-rows', 'first', schema.extend({ value: z.literal(1) }))).toThrow();
  expect(preparations!, 'Read polling must not compile the same three SQL statements for every document read.').toBeLessThanOrEqual(3);
});

test('stored project and notification settings share supported time zone validation', () => {
  const settings = defaultProjectWorkSettings('project'); settings.nightlyWindow.timezone = 'Asia/Tokyo'; settings.notifications.quietHours.timezone = 'Asia/Tokyo';
  const formatter = vi.spyOn(Intl, 'DateTimeFormat'); let constructions: number;
  try {
    for (let n = 0; n < 250; n++) expect(StoredProjectWorkSettingsSchema.parse(settings).notifications.quietHours.timezone).toBe('Asia/Tokyo');
    constructions = formatter.mock.calls.filter(([, options]) => options?.timeZone === 'Asia/Tokyo').length;
  } finally { formatter.mockRestore(); }
  expect(StoredProjectWorkSettingsSchema.safeParse({ ...settings, notifications: { ...settings.notifications, quietHours: { ...settings.notifications.quietHours, timezone: 'Invalid/Zone' } } }).success).toBe(false);
  expect(StoredProjectWorkSettingsSchema.safeParse({ ...settings, notifications: { ...settings.notifications, quietHours: { ...settings.notifications.quietHours, unexpected: true } } }).success).toBe(false);
  expect(constructions!, 'Reading stored settings must not rebuild notification time zone formatters on every read.').toBeLessThanOrEqual(1);
});

test('selective hub reads retain timestamp boundaries, fresh validation and byte-sensitive generation', () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-selection-resources-')); mkdirSync(join(root, 'user'));
  const database = hub = new HubDatabase(new Homes(join(root, 'data'), join(root, 'user')), 'hub');
  const schema = z.strictObject({ schema: z.literal('selection-resource-v1'), id: z.string(), group: z.string(), createdAt: TimestampSchema, value: z.number().int(), dropped: z.string().optional() });
  const early = { schema: 'selection-resource-v1' as const, id: 'early', group: 'one', createdAt: '2026-10-17T00:59:59.999+01:00', value: 1, dropped: 'Concluded.' };
  const boundary = { ...early, id: 'boundary', createdAt: '2026-10-17T01:00:00.000+01:00', dropped: undefined };
  const precise = { ...early, id: 'precise', createdAt: '2026-10-17T00:59:59.9999+01:00' };
  database.put('selection-rows', early.id, schema, early, 0); database.put('selection-rows', boundary.id, schema, boundary, 0);
  database.put('selection-rows', precise.id, schema, precise, 0);
  const cutoff = { before: { field: 'createdAt', at: '2026-10-17T00:00:00.000Z' } };
  expect(database.list('selection-rows', schema, cutoff).map(row => row.document.id)).toEqual(['early', 'precise']);
  const selected = database.list('selection-rows', schema, { missing: ['dropped'] });
  expect(selected.map(row => row.document.id)).toEqual(['boundary']);
  expect(database.listByField('selection-rows', 'group', 'one', schema, { missing: ['dropped'] }).map(row => row.document.id)).toEqual(['boundary']);
  expect(database.ids('selection-rows')).toEqual(['boundary', 'early', 'precise']);
  const generation = database.generation(['selection-rows']); selected[0]!.document.value = 99;
  expect(database.generation(['selection-rows'])).toBe(generation);
  expect(database.list('selection-rows', schema, { missing: ['dropped'] })[0]?.document.value).toBe(1);
  database.db.prepare('UPDATE documents SET document=? WHERE namespace=? AND id=?').run(JSON.stringify({ ...boundary, value: 2 }), 'selection-rows', boundary.id);
  expect(database.generation(['selection-rows'])).not.toBe(generation);
  expect(database.list('selection-rows', schema, { missing: ['dropped'] })[0]?.document.value).toBe(2);
  database.db.prepare('UPDATE documents SET document=? WHERE namespace=? AND id=?').run(JSON.stringify({ ...boundary, value: 'invalid' }), 'selection-rows', boundary.id);
  expect(() => database.list('selection-rows', schema, { missing: ['dropped'] })).toThrow();
  database.db.prepare('UPDATE documents SET document=? WHERE namespace=? AND id=?').run(JSON.stringify({ ...boundary, createdAt: 'invalid' }), 'selection-rows', boundary.id);
  expect(() => database.list('selection-rows', schema, cutoff)).toThrow();
});


test('project thread lists avoid cloning archived projects and keep returned records isolated', async () => {
  const f = fixture = await projectFixture({ github: false });
  f.fake.enqueueTurn(reportStep({ status: 'blocked', summary: 'Inspection finished.' }), forThread());
  const created = await f.app.projectWork.createThread('project', { schema: 'thread-create-request-v1', clientRequestId: 'scoped_list',
    title: 'Current project thread', task: 'Inspect without changes.', modelId: 'fixture', deviceId: f.app.device.deviceId });
  await f.waitFor(() => f.thread(created.threadId), thread => thread.state === 'idle'); await f.app.projectWork.idle();
  const base = f.thread(created.threadId), store = f.app.projectWork.store;
  for (let n = 0; n < 12; n++) store.create({ ...base, id: `archived_${n}`, projectId: 'archived_project', task: 'Archived project history. '.repeat(1000) }, { modelLabel: 'Fixture', accountLabel: 'Fixture' });
  const clone = structuredClone; let unrelatedCopies = 0;
  const copies = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if (value && typeof value === 'object' && 'schema' in value && value.schema === base.schema && 'projectId' in value && value.projectId === 'archived_project') unrelatedCopies++;
    return clone(value, options);
  });
  let listed: ReturnType<typeof store.list>;
  try { listed = store.list('project'); } finally { copies.mockRestore(); }
  expect(unrelatedCopies, 'Reading one project must not copy archived projects and their task or transcript metadata.').toBe(0);
  expect(listed!).toHaveLength(1); expect(listed![0]!.id).toBe(created.threadId);
  listed![0]!.title = 'A returned-object mutation'; expect(store.get(created.threadId)?.title).toBe(base.title);
  store.update(created.threadId, thread => ({ ...thread, title: 'Fresh current title' }));
  expect(store.list('project')[0]!.title).toBe('Fresh current title');
}, 60_000);
