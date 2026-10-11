import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DeviceFactsSchema, DeviceViewSchema, Homes, WorktreeDiskSchema, collectDeviceFacts, deviceResourceRefusal, defaultProjectWorkSettings, type DeviceFacts } from '../packages/core/dist/index.js';
import { Admission } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
const healthy = (): DeviceFacts => DeviceFactsSchema.parse({ schema: 'device-facts-v1', cores: 8, load1: 2, load5: 3, totalMemoryBytes: 32e9, freeMemoryBytes: 12e9, freeDiskBytes: 80e9, os: 'darwin', runningThreads: [], runningJobRuns: [] });
let f: ProjectFixture | undefined;
afterEach(async () => { await f?.close(); f = undefined; });
test('facts report the home volume and disk/load thresholds are exact', () => {
  const facts = collectDeviceFacts(new Homes()); expect(facts.cores).toBeGreaterThan(0); expect(facts.freeDiskBytes).toBeGreaterThan(0);
  expect(deviceResourceRefusal('Pro', { ...healthy(), freeDiskBytes: 19e9 })).toBe('Pro has 19 GB free; Jevellan needs at least 20 GB to start work there.');
  expect(deviceResourceRefusal('Pro', { ...healthy(), load5: 16.1 })).toBe('Pro is busy (load 16.1 on 8 cores).');
  expect(deviceResourceRefusal('Pro', { ...healthy(), freeDiskBytes: 20e9, load5: 16 })).toBeUndefined();
});
test('owner tags persist across heartbeats, invalid tags fail, and device-only credentials cannot edit them', async () => {
  f = await projectFixture(); const id = f.app.device.deviceId;
  await f.json('/hub/devices/tags', DeviceViewSchema, 'POST', { schema: 'device-tags-input-v1', deviceId: id, tags: ['mac', 'residential', 'browser-automation'] });
  await f.app.presence.pulse(); expect((await f.app.roster()).devices.find(row => row.device.id === id)?.device.tags).toEqual(['mac', 'residential', 'browser-automation']);
  expect((await f.request('/hub/devices/tags', 'POST', { schema: 'device-tags-input-v1', deviceId: id, tags: ['UPPER'] })).status).toBe(400);
  const unauthorized = await fetch(`${f.base}/hub/devices/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'device-tags-input-v1', deviceId: id, tags: [] }) });
  expect(unauthorized.status).toBe(401);
});
test('fixed new threads obey fresh local disk/load and hard needs with no thread created', async () => {
  let facts = healthy(); f = await projectFixture({ deviceFacts: () => facts });
  const start = () => f!.request(`/api/projects/${f!.project.id}/threads`, 'POST', { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Guarded', task: 'A change.', isolation: 'worktree', modelId: 'fixture', effort: 'high', deviceId: f!.app.device.deviceId });
  facts = { ...facts, freeDiskBytes: 19e9 }; const low = await start(); expect(low.status).toBe(409); expect((await low.json()).message).toContain('has 19 GB free');
  facts = { ...healthy(), load5: 17 }; const busy = await start(); expect(busy.status).toBe(409); expect((await busy.json()).message).toContain('is busy (load 17 on 8 cores)');
  facts = healthy(); const missing = await f.request(`/api/projects/${f.project.id}/threads`, 'POST', { schema: 'thread-create-request-v1', clientRequestId: randomUUID(), title: 'Missing needs', task: 'A change.', deviceId: f.app.device.deviceId, taskContext: { type: 'fix', needs: ['unavailable-tag'], goal: null } });
  expect(missing.status).toBe(409); expect((await missing.json()).message).toContain('missing tags: unavailable-tag'); expect(f.app.projectWork.store.all()).toHaveLength(0);
});
test('per-device admission serializes the last overridden slot and survives legacy defaults', async () => {
  f = await projectFixture(); const projectId = f.project.id, deviceId = f.app.device.deviceId;
  const current = await f.app.projectHub.settings(projectId);
  await f.app.projectHub.putSettings({ ...(current?.document ?? defaultProjectWorkSettings(projectId)), maxRunningPerDevice: 4, perDeviceLimits: { [deviceId]: 1 } }, current?.revision ?? 0);
  const admission = new Admission({ hub: f.app.projectHub, deviceId, deviceName: 'Pro', localLive: () => [], facts: healthy });
  const [a, b] = await Promise.all([admission.admit(projectId, deviceId, 'one'), admission.admit(projectId, deviceId, 'two')]);
  expect(a.ok).toBe(true); expect(b).toMatchObject({ ok: false, limit: 1 }); if (a.ok) a.release();
  const c = await admission.admit(projectId, deviceId, 'two'); expect(c.ok).toBe(true); if (c.ok) c.release();
  const disk = await f.json(`/api/devices/${deviceId}/worktrees`, WorktreeDiskSchema); expect(disk.deviceId).toBe(deviceId);
});
test('a queued workflow job waits on fresh worker resources without a run receipt or dispatch', async () => {
  let facts = healthy(); f = await projectFixture({ deviceFacts: () => facts }); const work = f.app.projectWork;
  await work.prepareDailyWork(f.project.id);
  const job = await work.daily.createJob(f.project.id, { schema: 'job-create-request-v1', clientRequestId: 'job', name: 'Workflow', goalId: null, enabled: true, gate: null, run: { kind: 'github-workflow', workflow: 'nightly.yml', mode: 'dispatch', timeoutMinutes: 5 } });
  facts = { ...facts, freeDiskBytes: 19e9 };
  const receipt = await work.daily.runJob(f.project.id, job.id, { schema: 'project-run-request-v1', clientRequestId: 'run' });
  await work.pulse(); expect((await work.tasks.read(f.project.id, receipt.taskId)).state).toBe('queued');
  expect(await work.jobs.runs(f.project.id)).toEqual([]); expect(f.github.requests.some(row => row.path.endsWith('/dispatches'))).toBe(false);
  facts = healthy(); await work.pulse();
  await f.waitFor(() => f!.github.requests.some(row => row.path.endsWith('/dispatches')));
  expect((await work.jobs.runs(f.project.id)).filter(run => run.taskId === receipt.taskId)).toHaveLength(1);
});
