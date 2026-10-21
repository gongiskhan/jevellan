import { afterEach, expect, test, vi } from 'vitest';
import { ThreadCreatedViewSchema, ThreadViewSchema, type ThreadState } from '../packages/core/dist/index.js';
import { threadPresentation } from '../packages/projects/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated thread controls ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'controls_fixture', title: 'Thread controls fixture', task: 'Inspect simulated controls.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}` };
}

test('thread controls reader owns confirmation copy and browser takeover visibility without acting', async () => {
  const { f, id, path } = await setup(), before = structuredClone(f.thread(id));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.presentation.controls).toMatchObject({ schema: 'project-thread-controls-v1', browserTakeover: true, attachPanel: true,
    stop: { title: 'Stop this thread?', action: 'Stop', body: 'The current turn ends and the thread takes no more work. Its worktree and branch stay until you discard them.' },
    discard: { title: `Remove the worktree and local branch ${before.branch}?`, action: 'Discard', body: 'Uncommitted work and commits that were not pushed are lost.', notice: 'Worktree discarded.' } });
  expect(f.thread(id)).toEqual(before);
  expect(ThreadViewSchema.safeParse(view).success).toBe(true);
  const older = structuredClone(view); delete older.presentation.controls; expect(ThreadViewSchema.safeParse(older).success).toBe(true);
  expect(ThreadViewSchema.safeParse({ ...view, presentation: { ...view.presentation, controls: { ...view.presentation.controls, unknown: true } } }).success).toBe(false);
});

test('thread controls preserve main and external consequences, no-branch discard and current state rules', async () => {
  const { f, id } = await setup(), view = await f.app.projectWork.views.thread('project', id), before = structuredClone(f.thread(id));
  const external = threadPresentation({ ...view, thread: { ...view.thread, isolation: 'main', gitPolicy: 'external', branch: undefined } });
  expect(external).toMatchObject({ controls: { stop: { body: 'The current turn ends and the thread takes no more work. Your edits stay in the project checkout. Git is left to you.' }, discard: { title: 'Remove the worktree?' } } });
  const managed = threadPresentation({ ...view, thread: { ...view.thread, isolation: 'main', gitPolicy: 'main' } });
  expect(managed).toMatchObject({ controls: { stop: { body: 'The current turn ends and the thread takes no more work. Commits it has not published are saved under refs/jevellan/discard, and the project checkout returns to main.' } } });
  for (const state of ['queued', 'preparing', 'idle', 'publishing', 'in-review', 'waiting-for-you', 'running', 'attached', 'done', 'stopped', 'failed'] as ThreadState[]) {
    const projected = threadPresentation({ ...view, thread: { ...view.thread, state } });
    expect(projected).toMatchObject({ controls: { browserTakeover: !['done', 'stopped', 'failed', 'running', 'attached'].includes(state), attachPanel: !['done', 'stopped', 'failed'].includes(state) } });
  }
  expect(f.thread(id)).toEqual(before);
});

test('thread controls aggregate only existing usage facts and owner readers share the same model', async () => {
  const { f, id, path } = await setup(), view = await f.app.projectWork.views.thread('project', id);
  const usage = { turns: 1, inputTokens: 1000, outputTokens: 240, cacheReadTokens: 4000, cacheWriteTokens: 500, costUsd: 0.12, costUnknownTurns: 0 };
  expect(threadPresentation({ ...view, thread: { ...view.thread, usage } })).toMatchObject({ controls: { usage: { schema: 'project-thread-usage-badge-v1', tokens: 1240, costUsd: 0.12 } } });
  expect(threadPresentation({ ...view, thread: { ...view.thread, usage: undefined } })).toMatchObject({ controls: { usage: null } });
  const response = await f.request(path); expect(response.status).toBe(200); const ui = await response.json(), before = structuredClone(f.thread(id));
  expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: id } })).toMatchObject({ ok: true, data: { presentation: { controls: ui.presentation.controls } } });
  expect(f.thread(id)).toEqual(before);
});
