import { afterEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { ThreadCreatedViewSchema, ThreadViewSchema } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { commitsSavedReason, restartedReason } from '../packages/projects/dist/index.js';
import { projectFixture, projectMember, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated thread ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'presentation_fixture', title: 'Thread presentation fixture', task: 'Inspect the simulated fixture.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}` };
}

test('thread reader owns header actions, canonical allowance copy and composer states without writes', async () => {
  const { f, id, path } = await setup(), before = structuredClone(f.thread(id));
  const read = async () => { const response = await f.request(path); expect(response.status).toBe(200); return await response.json(); };
  expect((await read()).presentation).toMatchObject({ schema: 'project-thread-presentation-v1',
    actions: { stop: true, stopRefusal: null, discard: false, allowTurns: false, allowTurnsStep: 10, allowTurnsLabel: 'Allow 10 more turns', allowedNotice: 'The thread can take 10 more turns.' },
    composer: { running: false, ended: false, block: null, continueNotice: null }, live: { text: null, activity: null },
    readPolicy: { schema: 'project-thread-read-policy-v1', liveMs: 1500, restMs: 10000, afterActionMs: 6000, startingMs: 120000 } });
  expect(f.thread(id)).toEqual(before);
  f.app.projectWork.store.update(id, row => ({ ...row, state: 'waiting-for-you', turns: row.turnAllowance }));
  expect((await read()).presentation.actions).toMatchObject({ stop: true, allowTurns: true, allowTurnsStep: 10 });
  f.app.projectWork.store.update(id, row => ({ ...row, state: 'attached' }));
  const attached = (await read()).presentation;
  expect(attached.actions.stopRefusal).toBeTruthy(); expect(attached.composer.block).toContain('Attached in a terminal on'); expect(attached.composer.ended).toBe(false);
});

test('thread presentation preserves restart and saved-ref reasons and strict older view compatibility', async () => {
  const { f, id, path } = await setup(), ref = 'refs/jevellan/discard/thread_fixture/1';
  f.app.projectWork.store.update(id, row => ({ ...row, state: 'stopped', stateReason: 'Stopped by you.' }));
  const stopped = await f.request(path); expect(stopped.status).toBe(200); expect((await stopped.json()).presentation.actions).toMatchObject({ stop: false, discard: true, allowTurns: false });
  f.app.projectWork.store.update(id, row => ({ ...row, state: 'stopped', stateReason: commitsSavedReason(restartedReason('thread_restarted'), ref) }));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.presentation).toMatchObject({ reason: { text: 'Restarted as thread_restarted.', restartedAs: 'thread_restarted', savedRef: ref }, actions: { stop: false, discard: false, allowTurns: false } });
  expect(view.card.placementLine).toContain(view.deviceName);
  expect(ThreadViewSchema.safeParse(view).success).toBe(true);
  const older = { ...view }; delete older.presentation; expect(ThreadViewSchema.safeParse(older).success).toBe(true);
  expect(ThreadViewSchema.safeParse({ ...view, presentation: { ...view.presentation, unknown: true } }).success).toBe(false);
});

test('thread view owner reads preserve the owning member and match the HTTP presentation', async () => {
  const f = fixture = await projectFixture(), member = await projectMember(f);
  member.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated member ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'member_presentation', title: 'Member presentation', task: 'Inspect the simulated member fixture.', deviceId: member.deviceId });
  await f.waitFor(async () => { await member.app.projectWork.pulse(); return existsSync(member.app.projectWork.paths.threadFile('project', made.threadId)) ? member.thread(made.threadId).state : 'not-arrived'; }, state => state === 'idle');
  await member.app.projectWork.pulse(); await f.app.projectWork.pulse();
  const hubRead = vi.spyOn(f.app.projectWork.views, 'thread'), memberRead = vi.spyOn(member.app.projectWork.views, 'thread');
  const response = await f.request(`/api/projects/project/threads/${made.threadId}`); expect(response.status).toBe(200); const ui = await response.json();
  expect(ui.presentation).toMatchObject({ schema: 'project-thread-presentation-v1', composer: { block: null } });
  const before = structuredClone(member.thread(made.threadId));
  const tool = await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: made.threadId } });
  expect(tool).toMatchObject({ ok: true, data: { presentation: ui.presentation, thread: { id: made.threadId } } });
  expect(hubRead).not.toHaveBeenCalled(); expect(memberRead).toHaveBeenCalledTimes(2); expect(member.thread(made.threadId)).toEqual(before); expect(f.app.projectWork.store.get(made.threadId)).toBeUndefined();
  const canonical = await member.app.projectWork.views.thread('project', made.threadId);
  for (const foreign of [{ ...canonical.thread, id: 'thread_foreign' }, { ...canonical.thread, projectId: 'project_foreign' }]) {
    memberRead.mockResolvedValueOnce({ ...canonical, thread: foreign });
    expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: made.threadId } })).toMatchObject({ ok: false, error: { code: 'failed', text: 'The request could not complete: The returned view does not match the thread.' } });
  }
});
