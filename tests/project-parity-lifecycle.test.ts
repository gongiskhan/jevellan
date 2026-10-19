import { afterEach, expect, test, vi } from 'vitest';
import { ProjectEnvSecretSummarySchema, ProjectWorkSettingsSchema, TaskReceiptSchema, type ProjectWorkSettings } from '../packages/core/dist/index.js';
import { forCoordinator, forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function settings(f: ProjectFixture, patch: Partial<ProjectWorkSettings>) {
  const base = (await f.app.projectWork.settingsView(f.project.id)).settings;
  const { schema: _schema, projectId: _project, revision, ...fields } = { ...base, ...patch }; void _schema; void _project;
  return f.app.projectWork.putSettings(f.project.id, { schema: 'project-work-settings-request-v1', revision, settings: fields });
}

test('overlapping project pulses join one task sweep instead of multiplying background work', async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  await f.app.projectWork.pulse();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sweep = vi.spyOn(f.app.projectWork.daily, 'sweep').mockImplementation(async () => { await gate; });
  const pulses = Array.from({ length: 4 }, () => f.app.projectWork.pulse());
  let closing: Promise<void> | undefined;
  try {
    await f.waitFor(() => sweep.mock.calls.length, count => count > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(sweep).toHaveBeenCalledTimes(1);
    let closed = false;
    closing = f.app.projectWork.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closed, 'shutdown must drain the in-flight sweep before closing its services').toBe(false);
  } finally { release(); await Promise.all(pulses); await closing; sweep.mockRestore(); }
});

test('shutdown cancels owned jobs before waiting for a sweep that needs their cancellation', async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  await f.app.projectWork.pulse();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sweep = vi.spyOn(f.app.projectWork.daily, 'sweep').mockImplementation(async () => { await gate; });
  const closeJobs = f.app.projectWork.jobs.close.bind(f.app.projectWork.jobs);
  const cancel = vi.spyOn(f.app.projectWork.jobs, 'close').mockImplementation(async () => { release(); await closeJobs(); });
  const pulse = f.app.projectWork.pulse(); let closing: Promise<void> | undefined;
  try {
    await f.waitFor(() => sweep.mock.calls.length, count => count > 0);
    closing = f.app.projectWork.close();
    await f.waitFor(() => cancel.mock.calls.length, count => count > 0, 1_000);
  } finally { release(); await pulse; await closing; sweep.mockRestore(); cancel.mockRestore(); }
});

test('a job completion during a task sweep requests one follow-up without overlapping sweeps', async () => {
  const f = fixture = await projectFixture({ coordinator: true });
  const work = f.app.projectWork;
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0); await work.pulse(); await work.idle();
  let release!: () => void, entered!: () => void, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
  const sweep = vi.spyOn(work.daily, 'sweep').mockImplementation(async () => {
    active += 1; maximum = Math.max(maximum, active);
    if (sweep.mock.calls.length === 1) { entered(); await gate; }
    active -= 1;
  });
  const pulse = work.pulse();
  try {
    await inside; work.jobs.o.changed(); work.jobs.o.changed(); release(); await pulse; await work.idle();
    expect(sweep).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
  } finally { release(); await pulse; sweep.mockRestore(); }
});

test.each(['paused', 'archived'] as const)('%s keeps coordinator events, tasks, goals and nightly work queued; resume starts them', { timeout: 120_000 }, async status => {
  let clock = Date.parse('2026-10-17T23:59:00Z');
  const f = fixture = await projectFixture({ coordinator: true, projectTimers: { now: () => clock } });
  await f.app.projectHub.assignCoordinator(f.project.id, f.app.device.deviceId, 0);
  await settings(f, { status, nightlyWindow: { enabled: true, time: '00:00', timezone: 'UTC' } });
  await f.app.projectWork.goals.create(f.project.id, { schema: 'goal-create-request-v1', clientRequestId: 'goal', name: 'Useful work', motivation: 'Keep it useful.', autonomy: 'auto' });
  const job = await f.app.projectWork.daily.createJob(f.project.id, { schema: 'job-create-request-v1', clientRequestId: 'job', name: 'A command', goalId: null, enabled: true, gate: null, run: { kind: 'command', command: 'true', timeoutMinutes: 1 } });
  await f.app.projectWork.daily.createDaily(f.project.id, { schema: 'daily-create-request-v1', clientRequestId: 'daily', name: 'Night command', goalId: null, order: 1, enabled: true, target: { kind: 'job', jobId: job.id } });
  clock += 120_000;
  await f.app.projectWork.daily.runJob(f.project.id, job.id, { schema: 'project-run-request-v1', clientRequestId: 'extra-run' });
  await f.request(`/api/projects/${f.project.id}/coordinator/messages`, 'POST', { schema: 'coordinator-message-request-v1', clientMessageId: 'owner', text: 'What is queued?' });
  const task = await f.json(`/api/projects/${f.project.id}/tasks`, TaskReceiptSchema, 'POST', { schema: 'task-create-request-v1', clientRequestId: 'task', title: 'Small task', brief: 'Inspect the checkout.', type: 'analysis' });
  for (let sweep = 0; sweep < 2; sweep++) await f.app.projectWork.pulse();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.fake.runs).toHaveLength(0);
  expect(f.coordinatorState().queue.some(event => event.kind === 'user-message')).toBe(true);
  expect((await f.app.projectWork.tasks.read(f.project.id, task.taskId)).state).toBe('queued');
  expect(await f.app.projectWork.daily.windows(f.project.id)).toEqual([]);
  expect(await f.app.projectWork.jobs.runs(f.project.id)).toEqual([]);
  expect(await f.app.projectHub.refill(f.project.id)).toBeNull();
  f.fake.enqueueTurn(async turn => { turn.say('The task is queued.'); return { status: 'completed' }; }, forCoordinator);
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Inspected the checkout.' }), forThread());
  await settings(f, { status: 'active', nightlyWindow: { enabled: false, time: '00:00', timezone: 'UTC' }, refill: { enabled: false, minIntervalMinutes: 30 } });
  await f.waitFor(() => f.fake.runs.length, count => count >= 2);
  expect((await f.app.projectWork.tasks.read(f.project.id, task.taskId)).threadId).not.toBeNull();
});

test('a running turn finishes after pause while a later message waits and resumes once', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  let release!: () => void, entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.fake.enqueueTurn(async turn => { entered(); await gate; await turn.bridge('jevellan_thread_report', { status: 'progress', summary: 'The running turn finished.' }); return { status: 'completed' }; }, forThread());
  const start = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'first', title: 'Small work', task: 'Inspect the files.' });
  await inside; await settings(f, { status: 'paused' });
  await f.request(`/api/projects/${f.project.id}/threads/${start.threadId}/messages`, 'POST', { schema: 'thread-message-request-v1', clientMessageId: 'next', text: 'Continue with the next step.', interrupt: false });
  release();
  await f.waitFor(() => f.thread(start.threadId), thread => thread.turns === 1 && thread.state === 'idle');
  await f.app.projectWork.pulse();
  expect(f.thread(start.threadId).queuedMessages).toHaveLength(1);
  expect(f.fake.turnStarts).toHaveLength(1);
  expect(f.thread(start.threadId).stateReason).toBe('The project is paused.');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Continued once.' }), forThread());
  await settings(f, { status: 'active' });
  await f.waitFor(() => f.thread(start.threadId).turns, turns => turns === 2);
  expect(f.thread(start.threadId).queuedMessages).toHaveLength(0);
});

test('environment secret owner APIs never return values; a member fetches only registered names and restart retains redaction', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const path = `/api/projects/${f.project.id}/env-secrets/SERVICE_TOKEN`, value = 'fixture-project-secret-for-environment';
  await settings(f, { environment: { variables: [], secrets: ['SERVICE_TOKEN'], copyFiles: [] } });
  const write = await f.request(path, 'PUT', { schema: 'save-secret-v1', value });
  expect(write.status).toBe(200); const text = await write.text(); expect(text).not.toContain(value);
  expect(ProjectEnvSecretSummarySchema.parse(JSON.parse(text))).toMatchObject({ name: 'SERVICE_TOKEN', saved: true });
  const stored = f.app.hub.db.prepare('SELECT document FROM secrets WHERE id=?').get(`project-env/${f.project.id}/SERVICE_TOKEN`)!;
  expect(String(stored.document)).not.toContain(value);
  expect(String(stored.document)).toContain('secret-envelope-v2');
  expect((await fetch(`${f.base}${path}`)).status).toBe(401);
  await f.restart();
  expect(await f.app.state.environment.credentials(f.project.id)).toEqual({ SERVICE_TOKEN: value });
  expect(f.app.redactor.text(value)).not.toContain(value);
  const member = await projectMember(f);
  expect(await member.app.state.environment.credentials(f.project.id)).toEqual({ SERVICE_TOKEN: value });
  const read = await member.request(path); expect(read.status).toBe(200); expect(await read.text()).not.toContain(value);
  const removed = await member.json(path, ProjectEnvSecretSummarySchema, 'DELETE', { schema: 'empty-request-v1' }); expect(removed.saved).toBe(false);
  expect(await f.app.state.environment.credentials(f.project.id)).toEqual({});
  expect((await f.request(`/api/projects/${f.project.id}/env-secrets/PATH`, 'PUT', { schema: 'save-secret-v1', value })).status).toBe(400);
});

test('v4 settings round trip through the hub without losing unrelated fields on a partial owner save', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  const saved = await settings(f, { instructions: 'Keep each change small.', status: 'paused', maxNewThreadsPerDay: 17,
    placement: { allowedModelIds: ['fixture'], minEffort: 'high', guidance: 'Prefer careful changes.' }, environment: { variables: [{ name: 'TEST_DATA', value: '/tmp/data' }], secrets: ['SERVICE_TOKEN'], copyFiles: ['.env.local'] } });
  expect((await f.app.projectHub.settings(f.project.id))?.document).toEqual(saved.settings);
  const before = saved.settings;
  const next = await f.app.projectWork.putSettings(f.project.id, { schema: 'project-work-settings-request-v1', revision: before.revision,
    settings: { ...Object.fromEntries(Object.entries(before).filter(([key]) => !['schema', 'projectId', 'revision'].includes(key))), landingChecks: before.landingChecks, smokeCheck: before.smokeCheck, mergeCommitPaths: before.mergeCommitPaths, delivery: before.delivery, coordinator: before.coordinator, setupCommand: before.setupCommand, maxRunningThreads: 2, maxRunningPerDevice: before.maxRunningPerDevice, threadTurnCap: before.threadTurnCap } });
  expect(next.settings).toEqual(ProjectWorkSettingsSchema.parse({ ...before, revision: before.revision + 1, maxRunningThreads: 2 }));
});

test('a task at the daily cap stays queued and starts once the owner raises the limit', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture();
  await settings(f, { maxNewThreadsPerDay: 1 });
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'First task inspected.' }), forThread());
  const first = await f.app.projectWork.createThread(f.project.id, { schema: 'thread-create-request-v1', clientRequestId: 'first-cap', title: 'First task', task: 'Inspect the checkout.' });
  await f.waitFor(() => f.thread(first.threadId).state, state => state === 'idle');
  const receipt = await f.json(`/api/projects/${f.project.id}/tasks`, TaskReceiptSchema, 'POST', { schema: 'task-create-request-v1', clientRequestId: 'second-cap', title: 'Second task', brief: 'Inspect one more file.', type: 'analysis' });
  await f.app.projectWork.pulse();
  const queued = await f.app.projectWork.tasks.read(f.project.id, receipt.taskId);
  expect(queued.state).toBe('queued'); expect(queued.threadId).toBeNull();
  expect(queued.endNote).toBe('New threads per day reached (1). The next one starts tomorrow, or after you raise the limit in Project settings.');
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Second task inspected.' }), forThread());
  await settings(f, { maxNewThreadsPerDay: 2 }); await f.app.projectWork.pulse();
  await f.waitFor(() => f.app.projectWork.tasks.read(f.project.id, receipt.taskId), task => task.threadId !== null);
  expect(f.app.projectWork.store.all().filter(thread => thread.projectId === f.project.id)).toHaveLength(2);
});
