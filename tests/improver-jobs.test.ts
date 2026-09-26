import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, defaultImproverSettings, type ImproverJobScope } from '../packages/core/dist/index.js';
import { HubDatabase, ImproverJobs, dueImproverDate } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase; let peer: HubDatabase; let jobs: ImproverJobs; let other: ImproverJobs; let now: number;
const scope: ImproverJobScope = { kind: 'memory', projectId: 'project', cycle: { kind: 'nightly', date: '2026-09-25' } };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-improver-jobs-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'home'), join(root, 'user'));
  hub = new HubDatabase(homes, 'hub'); peer = new HubDatabase(homes, 'hub'); now = Date.parse('2026-09-25T03:00:00Z');
  jobs = new ImproverJobs(hub, () => now); other = new ImproverJobs(peer, () => now);
});
afterEach(() => { hub.close(); peer.close(); rmSync(root, { recursive: true, force: true }); });

test('one hub claim wins across connections; completed nightly work never runs twice, including after restart', async () => {
  const claims = await Promise.all([Promise.resolve().then(() => jobs.claim(scope, 'hub')), Promise.resolve().then(() => other.claim(scope, 'peer'))]);
  expect(claims.filter(value => value.claimed)).toHaveLength(1);
  jobs.finish(claims[0]!.job, 'complete', 'Memory care completed.');
  hub.close(); hub = new HubDatabase(homes, 'hub'); jobs = new ImproverJobs(hub, () => now);
  expect(jobs.claim(scope, 'hub', true)).toMatchObject({ claimed: false, job: { status: 'complete', attempt: 1 } });
  expect(other.list()).toHaveLength(1);
});

test('failed jobs need explicit retry; old and wrong workers lose authority', () => {
  const first = jobs.claim(scope, 'hub').job; jobs.finish(first, 'failed', 'Provider unavailable.');
  expect(other.claim(scope, 'peer').claimed).toBe(false);
  const next = other.claim(scope, 'peer', true); expect(next).toMatchObject({ claimed: true, job: { attempt: 2, status: 'running' } });
  expect(() => jobs.finish(first, 'complete', 'Late worker')).toThrow('newer worker');
  expect(() => jobs.renew({ ...next.job, deviceId: 'hub' })).toThrow('newer worker');
  expect(other.assertOwned(next.job).token).toBe(next.job.token);
});

test('leases renew, expire and recover with a new token; expired workers cannot finish', () => {
  const first = jobs.claim(scope, 'hub').job; now += 119_000;
  const renewed = jobs.renew(first); expect(Date.parse(renewed.leaseUntil)).toBe(now + 120_000);
  now += 2_000; expect(other.claim(scope, 'peer').claimed).toBe(false);
  now = Date.parse(renewed.leaseUntil); expect(() => jobs.finish(first, 'complete', 'Expired')).toThrow('expired');
  const recovered = other.claim(scope, 'peer'); expect(recovered.claimed).toBe(true); expect(recovered.job.token).not.toBe(first.token);
  expect(() => jobs.renew(first)).toThrow('newer worker');
  expect(other.finish(recovered.job, 'complete', 'Recovered').attempt).toBe(2);
});

test('manual requests, project scope and context jobs cannot suppress nightly memory care', () => {
  const manual = jobs.claim({ ...scope, cycle: { kind: 'manual', id: 'request_one' } }, 'hub'); jobs.finish(manual.job, 'complete', 'Manual care.');
  expect(jobs.claim({ ...scope, cycle: { kind: 'manual', id: 'request_one' } }, 'hub').claimed).toBe(false);
  expect(jobs.claim({ ...scope, cycle: { kind: 'manual', id: 'request_two' } }, 'hub').claimed).toBe(true);
  expect(jobs.claim(scope, 'hub').claimed).toBe(true);
  expect(jobs.claim({ ...scope, projectId: 'another' }, 'hub').claimed).toBe(true);
  expect(jobs.claim({ ...scope, kind: 'context' }, 'hub').claimed).toBe(true);
  expect(() => jobs.claim({ ...scope, kind: 'routing' }, 'hub')).toThrow();
});

test('an owned-checkout skip is retained for the night and a later manual request has its own identity', () => {
  const first = jobs.claim(scope, 'hub').job; jobs.finish(first, 'skipped', 'Checkout belongs to open work.');
  expect(jobs.claim(scope, 'peer', true).claimed).toBe(false);
  expect(jobs.claim({ ...scope, cycle: { kind: 'manual', id: 'later' } }, 'peer').claimed).toBe(true);
});

test('nightly due time uses the hub local calendar and does not replay earlier missed days', () => {
  const settings = defaultImproverSettings();
  expect(dueImproverDate(settings, new Date(2026, 8, 25, 2, 59))).toBeNull();
  expect(dueImproverDate(settings, new Date(2026, 8, 25, 3, 0))).toBe('2026-09-25');
  expect(dueImproverDate(settings, new Date(2026, 8, 28, 23, 59))).toBe('2026-09-28');
  settings.schedule.time = '23:30'; expect(dueImproverDate(settings, new Date(2026, 8, 25, 23, 29))).toBeNull();
  settings.schedule.enabled = false; expect(dueImproverDate(settings, new Date(2026, 8, 25, 23, 59))).toBeNull();
  expect(() => dueImproverDate(settings, new Date(NaN))).toThrow('valid schedule');
});
