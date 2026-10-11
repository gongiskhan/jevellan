import { afterEach, expect, test, vi } from 'vitest';
import { SecretRedactor, TaskCreateRequestSchema, ThreadCreateRequestSchema, ThreadIndexSchema, type CoordinatorEvent, type ProjectWorkTask } from '../packages/core/dist/index.js';
import { HubProjectAccess } from '../packages/mesh/dist/index.js';
import { ProjectDispatcher, ProjectTasks, StartReceipts, taskRankBetween, type StartRequest } from '../packages/projects/dist/index.js';
import { holdStep, never, projectFixture, type ProjectFixture } from './helpers/project-fixture.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function setup(draft = false) {
  const f = fixture = await projectFixture();
  await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  const tasks = new ProjectTasks({ hub: f.app.projectHub, deviceId: f.app.device.deviceId, redactor: new SecretRedactor(), now: Date.now,
    ...(draft ? { validateGoal: async () => 'draft' as const } : {}) });
  const create = async (id: string, over: object = {}) => { const receipt = await tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: id, title: id, brief: `Implement ${id}.`, ...over })); return tasks.read('project', receipt.taskId); };
  return { f, tasks, create };
}
const edit = (task: ProjectWorkTask, patch: object) => ({ schema: 'task-update-request-v1' as const, expectedRevision: task.revision, ...patch });
const action = (task: ProjectWorkTask, kind: string) => ({ schema: 'task-action-request-v1', expectedRevision: task.revision, action: kind });

test('queue retries preserve identity and owner ordering without rewriting neighbours; dependencies cannot cycle or cross projects', async () => {
  const { f, tasks, create } = await setup();
  const a = await create('a'), b = await create('b', { after: [a.id] }), c = await create('c', { now: true });
  expect((await tasks.list('project')).map(task => task.id)).toEqual([c.id, a.id, b.id]);
  const moved = await tasks.update('project', b.id, edit(b, { position: 'top' }));
  expect(moved.ownerRanked).toBe(true); expect((await tasks.read('project', a.id)).revision).toBe(a.revision);
  expect((await tasks.list('project')).map(task => task.id)).toEqual([c.id, b.id, a.id]);
  await expect(tasks.update('project', b.id, edit(moved, { position: 'bottom' }), false)).rejects.toMatchObject({ status: 403 });
  await expect(tasks.update('project', a.id, edit(a, { after: [b.id] }))).rejects.toMatchObject({ status: 400 });
  await expect(create('unknown', { after: ['task_elsewhere'] })).rejects.toMatchObject({ status: 400 });
  await expect(tasks.update('project', a.id, edit(a, { after: [a.id] }))).rejects.toMatchObject({ status: 400 });
  const changed = await tasks.update('project', a.id, edit(a, { title: 'Edited title' }));
  const retried = await tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'a', title: 'a', brief: 'Implement a.' }));
  expect(retried).toMatchObject({ taskId: a.id, repeated: true }); expect((await tasks.read('project', a.id)).title).toBe(changed.title);
  await expect(create('a', { brief: 'Different request' })).rejects.toMatchObject({ status: 409 });
  await expect(new HubProjectAccess(f.app.hub, 'dev_other').putTask({ ...a, revision: 0, id: 'task_other' }, 0)).rejects.toMatchObject({ status: 403 });
  const history = await f.app.projectHub.taskHistory(a.id);
  expect(history.map(row => row.sequence)).toEqual([1, 2]); expect(history[1]?.title).toBe('Edited title');
});

test('dense fractional ranks stay ordered without a partial multi-row rebalance', () => {
  const high = taskRankBetween(null, null); let low = taskRankBetween(null, high);
  for (let index = 0; index < 200; index++) { const between = taskRankBetween(low, high); expect(between > low && between < high).toBe(true); low = between; }
  expect(low.length).toBeLessThanOrEqual(64);
  expect(taskRankBetween('7fffffffffffffffffffffffffffffff', '80000000000000000000000000000000')).toBe('7fffffffffffffffffffffffffffffff8');
});

test('draft approval, rejection, revisions and source authority are enforced', async () => {
  const { tasks, create } = await setup(true); const draft = await create('proposal');
  await expect(tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'false_claim', title: 'Claim', brief: 'Work.' }), 'owner-request')).rejects.toMatchObject({ status: 403 });
  await expect(tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: 'urgent_finding', title: 'Finding', brief: 'Work.', now: true }), 'finding')).rejects.toMatchObject({ status: 403 });
  const approved = await tasks.action('project', draft.id, action(draft, 'approve')); expect(approved.state).toBe('queued');
  await expect(tasks.action('project', draft.id, action(draft, 'cancel'))).rejects.toMatchObject({ status: 409 });
  const rejected = await create('reject'); expect(await tasks.action('project', rejected.id, action(rejected, 'reject'))).toMatchObject({ state: 'cancelled', endNote: 'Rejected by you.', endedAt: expect.any(String) });
});

function dispatcher(tasks: ProjectTasks) {
  const indexes = new Map<string, ReturnType<typeof ThreadIndexSchema.parse>>(), starts: StartRequest[] = [], events: CoordinatorEvent[] = [];
  let loseResponse = true;
  const service = { list: async () => [...indexes.values()], sweepQueue: vi.fn(async () => undefined),
    start: vi.fn(async (input: StartRequest) => {
      starts.push(structuredClone(input)); const id = `thread_${input.clientRequestId}`;
      if (!indexes.has(id)) indexes.set(id, ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id, projectId: 'project', title: input.title,
        state: 'running', isolation: 'worktree', ownerDeviceId: 'dev_remote', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 0, createdAt: tasks.at(), updatedAt: tasks.at() }));
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after remote dispatch.'); }
      return { threadId: id, state: 'running' as const, placement: 'Fixture', repeated: starts.length > 1 };
    }) };
  let rules = 'Original rules.';
  const make = () => new ProjectDispatcher({ tasks, threads: service, deviceId: tasks.o.deviceId, text: async task => ({ brief: task.brief, assembled: `${task.brief}\n${rules}` }), event: async (_id, event) => { events.push(event); } });
  return { indexes, starts, events, service, make, changeRules: () => { rules = 'New rules.'; } };
}

test('dispatch races and restart after a lost remote response preserve one thread and frozen input; dependencies wait for completion', async () => {
  const { tasks, create } = await setup(); const parent = await create('parent'), child = await create('child', { after: [parent.id], now: true });
  const d = dispatcher(tasks), first = d.make();
  const results = await Promise.allSettled([first.sweep('project'), first.sweep('project')]); expect(results.every(row => row.status === 'rejected')).toBe(true);
  expect(d.starts).toHaveLength(1); expect(d.indexes.size).toBe(1); expect((await tasks.read('project', parent.id)).threadId).toBeNull();
  d.changeRules(); await d.make().sweep('project'); expect(d.starts).toHaveLength(2); expect(d.starts[0]).toEqual(d.starts[1]); expect(d.indexes.size).toBe(1);
  expect((await tasks.read('project', parent.id)).state).toBe('active'); expect((await tasks.read('project', child.id)).threadId).toBeNull();
  const thread = [...d.indexes.values()][0]!; d.indexes.set(thread.id, { ...thread, state: 'done', endedAt: tasks.at() });
  await d.make().sweep('project'); expect((await tasks.read('project', parent.id)).state).toBe('done'); expect((await tasks.read('project', child.id)).state).toBe('active');
  const restarted = { ...thread, id: 'thread_restarted', state: 'running' as const }; d.indexes.set(restarted.id, restarted); d.indexes.set(thread.id, { ...thread, state: 'stopped', restartedAs: restarted.id });
  await d.make().sweep('project'); expect(await tasks.read('project', parent.id)).toMatchObject({ threadId: restarted.id, state: 'active' });
});

test('legacy queued thread adoption is durable and never starts a duplicate thread', async () => {
  const { tasks } = await setup(), d = dispatcher(tasks), at = tasks.at();
  d.indexes.set('thread_legacy', ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id: 'thread_legacy', projectId: 'project', title: 'Legacy', state: 'queued', isolation: 'worktree', ownerDeviceId: 'dev_remote', runtime: 'fake', modelLabel: 'Fixture', effort: 'high', accountLabel: 'Fixture', turns: 0, createdAt: at, updatedAt: at }));
  await d.make().sweep('project'); await d.make().sweep('project');
  const rows = await tasks.list('project'); expect(rows).toHaveLength(1); expect(rows[0]?.threadId).toBe('thread_legacy'); expect(d.service.start).not.toHaveBeenCalled(); expect(d.service.sweepQueue).toHaveBeenCalledTimes(2);
});

test('a missing start receipt after actual thread creation repairs the original thread instead of placing a second one', { timeout: 120_000 }, async () => {
  const { f } = await setup(); f.fake.enqueueTurn(holdStep(never()), forThread());
  const input = { schema: 'thread-create-request-v1' as const, clientRequestId: 'lost_receipt', title: 'Original', task: 'Wait for the owner.' };
  vi.spyOn(StartReceipts.prototype, 'put').mockImplementationOnce(() => { throw new Error('Simulated crash before writing the start receipt.'); });
  await expect(f.app.projectWork.createThread('project', input)).rejects.toThrow('Simulated crash');
  const first = { threadId: f.app.projectWork.paths.threadIds('project')[0]! };
  expect(f.thread(first.threadId).state).toBe('preparing');
  const repeated = await f.app.projectWork.createThread('project', input);
  expect(repeated.threadId).toBe(first.threadId); expect(f.app.projectWork.paths.threadIds('project')).toEqual([first.threadId]);
  await f.waitFor(() => f.thread(first.threadId).state, state => state === 'running');
  await f.waitFor(() => f.fake.turnStarts.filter(input => input.owner.kind === 'thread').length, count => count === 1);
});


test('assembled task allowance survives internal restart transport and refuses overflow before creating a thread', async () => {
  const { f } = await setup();
  const input = ThreadCreateRequestSchema.parse({ schema: 'thread-create-request-v1', clientRequestId: 'large_task', title: 'Large task', task: 'x'.repeat(24000) });
  expect(input.task).toHaveLength(24000);
  await expect(f.app.projectWork.threads.start({ projectId: 'project', coordinatorDeviceId: f.app.device.deviceId, createdBy: 'owner', fixed: {}, title: input.title, task: input.task, assembledTask: 'x'.repeat(32769) })).rejects.toMatchObject({ status: 400 });
  expect(f.app.projectWork.paths.threadIds('project')).toEqual([]);
});
