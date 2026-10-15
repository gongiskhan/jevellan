import { afterEach, expect, test, vi } from 'vitest';
import { TaskCreateRequestSchema } from '../packages/core/dist/index.js';
import { HubProtocolError } from '../packages/mesh/dist/index.js';
import { PREPARATION_RETRY_MINUTES } from '../packages/projects/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });

/** Two session tasks on one goal: the goal allows one active session task, so the second waits for the first (B1). */
async function setup(setupCommand = '', timers: { setupTimeoutMs?: number } = {}) {
  let now = Date.parse('2026-10-15T09:00:00Z');
  const f = fixture = await projectFixture({ projectTimers: { now: () => now, ...timers } }), work = f.app.projectWork;
  await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, setupCommand }, settings.revision);
  const { goal } = await work.goals.create('project', { schema: 'goal-create-request-v1', clientRequestId: 'docs', name: 'Docs and tests', motivation: 'Keep the project easy to work on.', health: 'Docs match the code.', autonomy: 'auto' });
  const task = async (id: string) => (await work.tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: id, title: id, brief: `Complete ${id}.`, goalId: goal.id }), 'owner')).taskId;
  const first = await task('first'), second = await task('second');
  const read = (id: string) => work.tasks.read('project', id);
  const events = () => f.coordinatorState().queue.map(event => event as { kind: string; message?: string; threadId?: string });
  return { f, work, first, second, read, events, advance: (minutes: number) => { now += minutes * 60_000; } };
}

test('a transient failure before the first turn retries after 1, 5 and 15 minutes, then fails the task and starts the next on its goal', { timeout: 120_000 }, async () => {
  const { f, work, first, second, read, events, advance } = await setup();
  let blocked = '';
  const admit = work.admission.admit.bind(work.admission);
  vi.spyOn(work.admission, 'admit').mockImplementation(async (projectId, deviceId, threadId) => {
    // The runner's own admission, once the first thread exists here: the readiness case, where the step failed before turn 1.
    const exists = (() => { try { return !!f.thread(threadId); } catch { return false; } })();
    if (!blocked && exists) blocked = threadId;
    if (threadId === blocked) throw new HubProtocolError();
    return admit(projectId, deviceId, threadId);
  });
  await work.pulse(); await work.idle();
  const threadId = (await f.waitFor(() => read(first), task => !!task.threadId)).threadId!;
  for (const [attempt, minutes] of PREPARATION_RETRY_MINUTES.entries()) {
    await f.waitFor(() => f.local(threadId).preparationRetry, retry => retry?.attempts === attempt + 1);
    expect(f.thread(threadId)).toMatchObject({ state: 'idle', turns: 0 }); expect(f.thread(threadId).stateReason).toContain(`Retry ${attempt + 1} of 3`);
    expect((await read(second)).threadId).toBeNull();
    advance(minutes - 0.5); await work.pulse(); await work.idle(); expect(f.local(threadId).preparationRetry?.attempts).toBe(attempt + 1);
    advance(0.5); await work.pulse(); await work.idle();
  }
  await f.waitFor(() => f.thread(threadId).state, state => state === 'failed');
  expect(f.thread(threadId).stateReason).toContain('invalid response');
  await work.pulse(); await work.idle();
  expect(await read(first)).toMatchObject({ state: 'failed' });
  await f.waitFor(() => read(second), task => !!task.threadId && task.state === 'active');
  expect(events().some(event => event.kind === 'thread-interrupted' && event.threadId === threadId && event.message?.includes('Task "first" failed before its first turn'))).toBe(true);
});

test('a non-transient preparation failure fails at once, and a coordinator message restarts preparation once', async () => {
  const { f, work, first, second, read } = await setup('exit 3');
  await work.pulse(); await work.idle();
  const threadId = (await f.waitFor(() => read(first), task => !!task.threadId)).threadId!;
  await f.waitFor(() => f.thread(threadId).state, state => state === 'failed');
  expect(f.local(threadId).preparationRetry).toBeUndefined();
  await work.pulse(); await work.idle();
  expect((await read(first)).state).toBe('failed');
  await f.waitFor(() => read(second), task => !!task.threadId);
  // The second thread fails the same way; fixing the setup and messaging the first restarts it, once.
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, setupCommand: 'true' }, settings.revision);
  const runner = work.threads.runner(threadId)!;
  expect(await runner.deliver({ id: 'msg_restart', from: 'coordinator', text: 'The setup is fixed. Try again.', at: new Date().toISOString(), interrupt: false })).toMatchObject({ delivery: 'started' });
  await f.waitFor(() => f.thread(threadId), thread => thread.turns > 0);
  expect(f.local(threadId).preparationRestarted).toBe(true);
});

test('a setup command that times out before the first turn is transient and is retried', async () => {
  const { f, work, first, read, advance } = await setup('sleep 5', { setupTimeoutMs: 300 });
  await work.pulse(); await work.idle();
  const threadId = (await f.waitFor(() => read(first), task => !!task.threadId)).threadId!;
  await f.waitFor(() => f.local(threadId).preparationRetry, retry => retry?.attempts === 1);
  expect(f.thread(threadId).stateReason).toContain('timed out'); expect((await read(first)).state).toBe('active');
  const settings = await work.admission.settings('project'); await f.app.projectHub.putSettings({ ...settings, setupCommand: 'true' }, settings.revision);
  advance(1); await work.pulse(); await work.idle();
  await f.waitFor(() => f.thread(threadId), thread => thread.turns > 0);
  expect(f.local(threadId).preparationRetry).toBeUndefined();
});

test('messages that arrive while a preparation waits for its retry follow the task turn instead of replacing it', { timeout: 120_000 }, async () => {
  // Crucial review: a message delivered after the one restart ran a first turn with only the messages, and the task was never sent.
  const { f, work, first, read, advance } = await setup();
  let failing = true; const admit = work.admission.admit.bind(work.admission);
  vi.spyOn(work.admission, 'admit').mockImplementation(async (projectId, deviceId, threadId) => {
    const exists = (() => { try { return !!f.thread(threadId); } catch { return false; } })();
    if (failing && exists) throw new HubProtocolError();
    return admit(projectId, deviceId, threadId);
  });
  await work.pulse(); await work.idle();
  const threadId = (await f.waitFor(() => read(first), task => !!task.threadId)).threadId!;
  await f.waitFor(() => f.local(threadId).preparationRetry, retry => retry?.attempts === 1);
  const runner = work.threads.runner(threadId)!;
  await runner.deliver({ id: 'msg_one', from: 'owner', text: 'Also mention the changelog.', at: new Date().toISOString(), interrupt: false }); await work.idle();
  await f.waitFor(() => f.local(threadId).preparationRetry, retry => !!retry);
  await runner.deliver({ id: 'msg_two', from: 'owner', text: 'And keep it short.', at: new Date().toISOString(), interrupt: false }); await work.idle();
  expect(f.thread(threadId).turns).toBe(0);
  failing = false; advance(5); await work.pulse(); await work.idle();
  await f.waitFor(() => f.thread(threadId), thread => thread.turns > 0);
  const turns = f.fake.turnStarts.filter(input => input.owner.kind === 'thread' && input.owner.id === threadId);
  expect(turns[0]!.prompt).toContain('Complete first.');
});
