import { afterEach, expect, test, vi } from 'vitest';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Homes, ProjectWorkSettingsSchema, defaultProjectWorkSettings } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
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
