import { afterEach, expect, test, vi } from 'vitest';
import { CursorTranscriptSchema, ThreadCreatedViewSchema, ThreadViewSchema, type CursorTurn } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
const summary = 'Preview ready.\n![Report](shots/report.png)\n![Library](library/outputs/thread_fixture/private.png)';
async function setup(reportSummary = summary) {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: reportSummary }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'image_view_fixture', title: 'Thread image-view fixture', task: 'Inspect simulated image references.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}` };
}

test('thread image view preserves raw gallery refs and filtered timeline refs without fetching files', async () => {
  const { f, id, path } = await setup(), at = '2026-10-21T10:00:00.000Z';
  const turns: CursorTurn[] = [{ id: 'image_prompt', role: 'user', blocks: [{ type: 'text', text: '![Prompt](<shots/prompt view.png>)' }] },
    { id: 'image_tools', role: 'assistant', blocks: [
      { type: 'tool', id: 'image_read', name: 'Read', input: JSON.stringify({ file_path: 'shots/read.png' }), output: '[Image attachment]', state: 'completed' },
      { type: 'tool', id: 'image_pending', name: 'Screenshot', input: JSON.stringify({ path: 'shots/pending.png' }), state: 'running' },
      { type: 'tool', id: 'library_list', name: 'mcp__jevellan__jevellan_library_list', input: '{}', output: JSON.stringify({ path: 'library/outputs/thread_fixture/private.png' }), state: 'completed' },
      { type: 'text', text: summary },
    ] }];
  const transcript = CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: `claude_${'0'.repeat(32)}`,
    ownerDeviceId: f.app.device.deviceId, deviceName: 'Fixture device', title: 'Synthetic image references', cwd: f.checkout, project: f.project.name,
    state: 'idle', lastActivityAt: at, connected: true, canSteer: false, canSend: false }, turns, messages: [], truncated: false, observedAt: at });
  vi.spyOn(f.app.projectWork.transcripts, 'read').mockResolvedValue(transcript); const before = structuredClone(f.thread(id));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.images).toEqual({ schema: 'project-thread-images-v1', projectId: 'project', threadId: id, refs: ['shots/prompt view.png', 'shots/read.png', 'shots/report.png'] });
  expect(view.timeline.items.find((item: { kind: string; turn?: { id: string } }) => item.kind === 'turn' && item.turn?.id === 'image_tools')?.images).toEqual(['shots/read.png']);
  expect(view.timeline.items.find((item: { kind: string }) => item.kind === 'report')?.presentation.images).toEqual(['shots/report.png']);
  expect(f.thread(id)).toEqual(before);
  expect(ThreadViewSchema.safeParse(view).success).toBe(true); const older = structuredClone(view); delete older.images; for (const item of older.timeline.items) { delete item.images; if (item.presentation) delete item.presentation.images; } expect(ThreadViewSchema.safeParse(older).success).toBe(true);
  expect(ThreadViewSchema.safeParse({ ...view, images: { ...view.images, unknown: true } }).success).toBe(false);
});

test('thread image owner reader shares the empty image model without fetching image files or running provider work', async () => {
  const { f, id, path } = await setup('No image references in this simulated report.'), before = structuredClone(f.thread(id));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.images).toEqual({ schema: 'project-thread-images-v1', projectId: 'project', threadId: id, refs: [] });
  expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: id } })).toMatchObject({ ok: true, data: { images: view.images } });
  expect(f.thread(id)).toEqual(before);
});
