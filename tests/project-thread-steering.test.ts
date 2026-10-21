import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { ThreadCreatedViewSchema, ThreadViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });

test('thread steering reads share interrupt availability and retain older views without steering work', async () => {
  const f = fixture = await projectFixture(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated steering ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'thread_steering_fixture', title: 'Steering view fixture', task: 'Inspect simulated steering state.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle'); const path = `/api/projects/project/threads/${made.threadId}`, before = structuredClone(f.thread(made.threadId)), runs = f.fake.runs.length;
  const read = async () => { const response = await f.request(path); expect(response.status).toBe(200); return await response.json(); }; const idle = await read();
  expect(idle.presentation.composer.steering).toEqual({ schema: 'project-thread-steering-view-v1', offered: false, label: 'Interrupt current turn' });
  expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: made.threadId } })).toMatchObject({ ok: true, data: { presentation: { composer: { steering: idle.presentation.composer.steering } } } });
  expect(f.thread(made.threadId)).toEqual(before); expect(f.fake.runs).toHaveLength(runs);
  const older = structuredClone(idle); delete older.presentation.composer.steering; expect(ThreadViewSchema.safeParse(older).success).toBe(true);
  expect(ThreadViewSchema.safeParse({ ...idle, presentation: { ...idle.presentation, composer: { ...idle.presentation.composer, steering: { ...idle.presentation.composer.steering, unknown: true } } } }).success).toBe(false);
  f.app.projectWork.store.update(made.threadId, row => ({ ...row, state: 'running' })); expect((await read()).presentation.composer.steering.offered).toBe(true);
  f.app.projectWork.store.update(made.threadId, row => ({ ...row, state: 'attached' })); const attached = await read(); expect(attached.presentation.composer.block).toBeTruthy(); expect(attached.presentation.composer.steering.offered).toBe(false);
  expect(f.fake.runs).toHaveLength(runs);
});

test('shared steering policy hides unavailable interrupts and never sends a stale idle choice', () => {
  expect(core.threadSteeringView).toBeTypeOf('function'); expect(core.threadMessageInterrupt).toBeTypeOf('function');
  expect(core.threadSteeringView({ running: false, block: null })).toEqual({ schema: 'project-thread-steering-view-v1', offered: false, label: 'Interrupt current turn' });
  expect(core.threadSteeringView({ running: true, block: null }).offered).toBe(true);
  expect(core.threadSteeringView({ running: true, block: 'Attached in a terminal.' }).offered).toBe(false);
  expect(core.threadSteeringView({ running: false, block: 'The thread is concluded.' }).offered).toBe(false);
  expect(core.threadMessageInterrupt(false, true)).toBe(false); expect(core.threadMessageInterrupt(false, false)).toBe(false);
  expect(core.threadMessageInterrupt(true, false)).toBe(false); expect(core.threadMessageInterrupt(true, true)).toBe(true);
});
