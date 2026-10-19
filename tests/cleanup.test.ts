import { CleanupStateSchema, ProjectJobSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { afterEach, expect, test } from 'vitest';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStep, projectMember, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

test('owner Clean now removes an expired daemon log and returns a durable per-device receipt', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture();
  const path = join(f.homes.ensure('logs'), 'expired.log'); writeFileSync(path, 'old log\n'.repeat(1000));
  const old = new Date(Date.now() - 20 * 86400000); utimesSync(path, old, old);
  const response = await f.request(`/api/devices/${f.app.device.deviceId}/cleanup`, 'POST', { schema: 'empty-request-v1' });
  expect(response.status).toBe(200);
  const receipt = await response.json() as { schema: string; lastRun: { freedBytes: number; removed: number } };
  expect(receipt.schema).toBe('cleanup-state-v1'); expect(receipt.lastRun.freedBytes).toBeGreaterThan(0); expect(receipt.lastRun.removed).toBe(1);
  expect(existsSync(path)).toBe(false);
  const read = await f.request(`/api/devices/${f.app.device.deviceId}/cleanup`);
  expect(await read.json()).toEqual(receipt);
});

test('Clean now removes only an old resolved worktree, retaining an unlanded 30-day tree, its ledger and the registered checkout', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture();
  const make = async (id: string) => {
    f.fake.enqueueTurn(commitStep({ [`${id}.txt`]: 'A preserved change.\n' }, { status: 'done', summary: 'Ready.' }), forThread());
    const created = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: id, title: id, task: 'Make the fixture change.', modelId: 'fixture', effort: 'high' });
    await f.app.projectWork.idle(f.project.id); return f.thread(created.threadId);
  };
  const resolved = await make('resolved'), unlanded = await make('unlanded');
  const old = new Date(Date.now() - 4 * 86400000).toISOString();
  f.app.projectWork.store.update(resolved.id, thread => ({ ...thread, state: 'done', endedAt: old, resolution: { at: old, by: 'owner' } }));
  const before = f.ledgerText(resolved.id), checkoutHead = f.git(f.checkout, 'rev-parse', 'HEAD');
  const thirtyDays = new Date(Date.now() - 30 * 86400000); utimesSync(unlanded.cwd!, thirtyDays, thirtyDays);
  const response = await f.request(`/api/devices/${f.app.device.deviceId}/cleanup`, 'POST', { schema: 'empty-request-v1' }); expect(response.status).toBe(200);
  const result = await response.json() as { lastRun: { state: string; removed: number } };
  expect(result.lastRun).toMatchObject({ state: 'completed', removed: 1 });
  expect(existsSync(resolved.cwd!)).toBe(false); expect(existsSync(unlanded.cwd!)).toBe(true);
  expect(f.ledgerText(resolved.id)).toBe(before); expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(checkoutHead);
});

test('Clean now waits for a running thread and keeps its files', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture(); let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  f.fake.enqueueTurn(async () => { await gate; return { status: 'completed' }; }, forThread());
  try {
    const created = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'busy_cleanup', title: 'Running work', task: 'Wait for the fixture.', modelId: 'fixture', effort: 'high' });
    await f.waitFor(() => f.thread(created.threadId), thread => thread.state === 'running');
    const path = join(f.homes.ensure('logs'), 'expired.log'); writeFileSync(path, 'keep'); const old = new Date(Date.now() - 20 * 86400000); utimesSync(path, old, old);
    const response = await f.request(`/api/devices/${f.app.device.deviceId}/cleanup`, 'POST', { schema: 'empty-request-v1' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ lastRun: { state: 'deferred', removed: 0 } }); expect(existsSync(path)).toBe(true);
  } finally { finish(); }
});

test('Clean now waits for a running command job even without a coordinator turn', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork, projectId = f.project.id;
  const job = await f.json(`/api/projects/${projectId}/jobs`, ProjectJobSchema, 'POST', { schema: 'job-create-request-v1', clientRequestId: 'cleanup_job', name: 'Running command', goalId: null, enabled: true, run: { kind: 'command', command: 'sleep 60', timeoutMinutes: 2 }, gate: null });
  try {
    await work.daily.runJob(projectId, job.id, { schema: 'project-run-request-v1', clientRequestId: 'cleanup_job_run' }); await work.dispatcher.sweep(projectId);
    await f.waitFor(() => work.jobs.runs(projectId), runs => runs.some(run => run.phase === 'executing' && !run.conclusion));
    const path = join(f.homes.ensure('logs'), 'expired.log'); writeFileSync(path, 'keep'); const old = new Date(Date.now() - 20 * 86400000); utimesSync(path, old, old);
    const response = await f.request(`/api/devices/${f.app.device.deviceId}/cleanup`, 'POST', { schema: 'empty-request-v1' });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ lastRun: { state: 'deferred', removed: 0 } }); expect(existsSync(path)).toBe(true);
  } finally { await work.jobs.cancel(projectId); }
});

test('Clean now forwards the owner session to a member and keeps its receipt on that device', { timeout: 120000 }, async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  const path = join(member.app.homes.ensure('logs'), 'expired.log'); writeFileSync(path, 'old member log\n'); const old = new Date(Date.now() - 20 * 86400000); utimesSync(path, old, old);
  const result = await f.json(`/api/devices/${member.deviceId}/cleanup`, CleanupStateSchema, 'POST', { schema: 'empty-request-v1' });
  expect(result).toMatchObject({ deviceId: member.deviceId, lastRun: { state: 'completed', removed: 1 } }); expect(existsSync(path)).toBe(false);
  expect(member.app.cleanup.state()).toEqual(result);
});
