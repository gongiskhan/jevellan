import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckoutClaimSchema, CheckoutOwnership, Homes, ProjectSchema, PublicationLeases, PUBLICATION_LEASE_MS, withPublicationLease, type Project } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let db: HubDatabase; let otherDb: HubDatabase; let project: Project;
const a = { conversationId: 'a', conversationTitle: 'First work', workId: 'work_a' };
const b = { conversationId: 'b', conversationTitle: 'Second work', workId: 'work_b' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-ownership-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  db = new HubDatabase(homes, 'hub'); otherDb = new HubDatabase(homes, 'hub');
  const path = join(root, 'project'); execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' });
  project = ProjectSchema.parse({ schema: 'project-v1', id: 'project', name: 'Fixture', paths: { device: path }, branchPolicy: 'main', memory: { mode: 'repo', dir: '.jevellan/memory' }, context: { state: 'none' } });
});
afterEach(() => { otherDb.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

test('undo transfers ownership within one conversation, retaining the reservation and recovering its local mirror', async () => {
  const owner = new CheckoutOwnership(db, homes, 'device'); const other = new CheckoutOwnership(otherDb, homes, 'device');
  const earlier = { ...a, workId: 'earlier_work' }; await owner.acquire(project, a);
  await expect(owner.transfer(project, a, earlier, false)).rejects.toThrow('process termination');
  await expect(owner.transfer(project, a, b, true)).rejects.toThrow('same conversation'); await owner.assert(project, a);
  const put = db.put.bind(db);
  vi.spyOn(db, 'put').mockImplementationOnce((...args) => { put(...args); throw new Error('Simulated interruption after the hub update'); });
  await expect(owner.transfer(project, a, earlier, true)).rejects.toThrow('Simulated interruption'); vi.restoreAllMocks();
  expect(db.list('checkout-ownership', CheckoutClaimSchema)[0]!.document.workId).toBe(earlier.workId);
  const file = join(homes.at('locks'), readdirSync(homes.at('locks'))[0]!);
  expect(JSON.parse(readFileSync(file, 'utf8')).workId).toBe(a.workId);
  await expect(other.acquire(project, b)).rejects.toThrow('First work');
  await other.transfer(project, a, earlier, true); await other.assert(project, earlier);
  await other.transfer(project, a, earlier, true); await expect(owner.assert(project, a)).rejects.toThrow('does not own');
  expect(JSON.parse(readFileSync(file, 'utf8')).workId).toBe(earlier.workId);
});
test('clean paused work keeps ownership; competing work waits until processes and commits are settled', async () => {
  const owner = new CheckoutOwnership(db, homes, 'device'); const other = new CheckoutOwnership(otherDb, homes, 'device');
  await owner.acquire(project, a);
  expect(execFileSync('git', ['-C', project.paths.device!, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  await expect(other.acquire(project, b)).rejects.toThrow('First work');
  await expect(owner.release(project, a, { processesGone: false, commits: 'published' })).rejects.toThrow('termination');
  await expect(owner.release(project, a, { processesGone: true, commits: 'kept' })).rejects.toThrow('Unpublished');
  expect((await owner.current(project))?.held).toBe(true);
  await owner.release(project, a, { processesGone: true, commits: 'published' });
  await other.acquire(project, b); await expect(owner.assert(project, a)).rejects.toThrow('does not own'); await other.assert(project, b);
});
test('simultaneous checkout claims have exactly one winner through hub compare-and-swap', async () => {
  const results = await Promise.allSettled([new CheckoutOwnership(db, homes, 'device').acquire(project, a), new CheckoutOwnership(otherDb, homes, 'device').acquire(project, b)]);
  expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
});
test('a dead daemon leaves its work reserved, and the same work can reattach without freeing the checkout', async () => {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  await new CheckoutOwnership(db, homes, 'device', pid).acquire(project, a);
  const restarted = new CheckoutOwnership(otherDb, homes, 'device');
  await expect(restarted.acquire(project, b)).rejects.toThrow('First work');
  expect((await restarted.acquire(project, a)).pid).toBe(process.pid); await restarted.assert(project, a);
});
test('a crash after hub release leaves a recoverable local file; an unrelated local file is never silently removed', async () => {
  const owner = new CheckoutOwnership(db, homes, 'device'); await owner.acquire(project, a);
  const file = join(homes.at('locks'), readdirSync(homes.at('locks'))[0]!); const stale = readFileSync(file);
  await owner.release(project, a, { processesGone: true, commits: 'unchanged' }); writeFileSync(file, stale);
  await owner.acquire(project, b); await owner.assert(project, b);
  const local = JSON.parse(readFileSync(file, 'utf8')); local.workId = 'unexpected'; writeFileSync(file, JSON.stringify(local));
  await expect(owner.acquire(project, b)).rejects.toThrow('differs from the hub'); expect(JSON.parse(readFileSync(file, 'utf8')).workId).toBe('unexpected');
});
test('missing and invalid project paths never fall back to another checkout', async () => {
  const owner = new CheckoutOwnership(db, homes, 'device');
  await expect(owner.acquire({ ...project, paths: { device: join(root, 'missing') } }, a)).rejects.toThrow("isn't checked out");
  await expect(owner.acquire({ ...project, paths: { device: root } }, a)).rejects.toThrow("isn't checked out");
});
test('adapted Garrison lease regression: renewal protects remote work without inspecting its process id', async () => {
  let now = Date.now(); const first = new PublicationLeases(db, () => now); const second = new PublicationLeases(otherDb, () => now);
  let lease = await first.acquire('fixture-remote', 'work_a');
  now += 90_000; lease = await first.renew(lease); now += 90_000;
  await expect(second.acquire('fixture-remote', 'work_b')).rejects.toThrow('Another work'); await first.assert(lease);
  now += PUBLICATION_LEASE_MS;
  const next = await second.acquire('fixture-remote', 'work_b');
  await expect(first.renew(lease)).rejects.toThrow('lost'); await expect(first.release(lease)).rejects.toThrow('lost'); await second.assert(next);
});
test('terminal publication leases can be acquired again and concurrent requests have one winner', async () => {
  const first = new PublicationLeases(db); const second = new PublicationLeases(otherDb);
  const outcomes = await Promise.allSettled([first.acquire('fixture-remote', 'work_a'), second.acquire('fixture-remote', 'work_b')]);
  expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  const lease = outcomes.find((entry) => entry.status === 'fulfilled')!; if (lease.status !== 'fulfilled') throw new Error('No lease');
  await first.release(lease.value); await second.acquire('fixture-remote', 'work_c');
});
test('renewal failure prevents the final publication check even if the hub later responds', async () => {
  const leases = new PublicationLeases(db); const failure = new Error('hub unavailable'); const renew = vi.spyOn(leases, 'renew').mockRejectedValue(failure);
  let pushed = false;
  await expect(withPublicationLease(leases, 'fixture-remote', 'work_a', async (assertLease) => {
    await vi.waitFor(() => expect(renew).toHaveBeenCalled(), { interval: 5, timeout: 1000 });
    await assertLease(); pushed = true;
  }, 10)).rejects.toBe(failure);
  expect(pushed).toBe(false);
});
test('lost acquisition and release replies reconcile only the exact owner and lease token, including expired cleanup', async () => {
  let now = Date.now(); const leases = new PublicationLeases(db, () => now);
  const first = await leases.acquire('fixture-remote', 'work_a'); expect(await leases.acquire('fixture-remote', 'work_a')).toEqual(first);
  await expect(leases.acquire('fixture-remote', 'work_b')).rejects.toThrow('Another work');
  now += PUBLICATION_LEASE_MS; await expect(leases.assert(first)).rejects.toThrow('lost');
  await leases.release(first); await leases.release(first);
  const next = await leases.acquire('fixture-remote', 'work_a'); expect(next.token).not.toBe(first.token);
  await expect(leases.release(first)).rejects.toThrow('lost'); await leases.assert(next);
});
