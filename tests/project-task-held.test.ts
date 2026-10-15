import { afterEach, expect, test } from 'vitest';
import { TaskCreateRequestSchema } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

// Live C3: "Add a task ... Do not start it yet." The coordinator had no way to queue a task without its start, so the task was
// dispatched at once and the coordinator stopped the thread. A held task stays queued until it is released.
test('a held task stays queued without a thread until it is released, by the coordinator or by the owner\'s Start now', { timeout: 120_000 }, async () => {
  const f = fixture = await projectFixture(), work = f.app.projectWork;
  await f.app.projectHub.assignCoordinator('project', f.app.device.deviceId, 0);
  const create = async (id: string) => (await work.tasks.create('project', TaskCreateRequestSchema.parse({ schema: 'task-create-request-v1', clientRequestId: id, title: id, brief: `Complete ${id}.`, held: true }), 'owner')).taskId;
  const coordinatorHeld = await create('readme_section'), ownerHeld = await create('second_section');
  await work.pulse(); await work.idle('project');
  for (const id of [coordinatorHeld, ownerHeld]) expect(await work.tasks.read('project', id)).toMatchObject({ state: 'queued', held: true, threadId: null });
  // The coordinator releases one on the owner's word.
  const first = await work.tasks.read('project', coordinatorHeld);
  await work.tasks.update('project', first.id, { schema: 'task-update-request-v1', expectedRevision: first.revision, held: false }, false);
  await work.pulse();
  const started = await f.waitFor(() => work.tasks.read('project', coordinatorHeld), task => !!task.threadId);
  expect(started.held).toBeUndefined(); expect((await work.tasks.read('project', ownerHeld)).threadId).toBeNull();
  // The owner's Start now releases the other.
  const second = await work.tasks.read('project', ownerHeld);
  await work.tasks.action('project', second.id, { schema: 'task-action-request-v1', expectedRevision: second.revision, action: 'now' });
  await work.pulse();
  expect((await f.waitFor(() => work.tasks.read('project', ownerHeld), task => !!task.threadId)).held).toBeUndefined();
});
