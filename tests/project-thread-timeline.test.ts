import { afterEach, expect, test, vi } from 'vitest';
import { CursorTranscriptSchema, ThreadCreatedViewSchema, ThreadViewSchema, type CursorTurn } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
async function setup() {
  const f = fixture = await projectFixture();
  f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Recorded fixture summary.\nMore recorded detail.', testsRun: { command: 'node --test', passed: true, summary: 'Simulated checks passed.' } }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', {
    schema: 'thread-create-request-v1', clientRequestId: 'timeline_fixture', title: 'Thread timeline fixture', task: 'Inspect the simulated timeline.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}` };
}
const text = (id: string, role: 'user' | 'assistant', value: string): CursorTurn => ({ id, role, blocks: [{ type: 'text', text: value }] });

test('thread timeline aligns recorded reports, removes echoes, groups tools and flags only the active pending result', async () => {
  const { f, id, path } = await setup(), at = '2026-10-21T10:00:00.000Z';
  const first = { type: 'tool' as const, id: 'read_one', name: 'Read', input: '{}', output: 'First simulated result.', state: 'completed' as const };
  const second = { ...first, id: 'read_two', output: 'Second simulated result.' };
  const pending = { type: 'tool' as const, id: 'pending_tool', name: 'Bash', input: JSON.stringify({ description: 'Wait for the simulated check.' }), state: 'unknown' as const };
  const turns: CursorTurn[] = [text('p1', 'user', 'First simulated prompt.'), { id: 'a1', role: 'assistant', blocks: [first] }, { id: 'a2', role: 'assistant', blocks: [second] },
    { id: 'reported', role: 'assistant', blocks: [{ type: 'tool', id: 'report_call', name: 'jevellan_thread_report', input: JSON.stringify({ summary: 'Recorded fixture summary.\nMore recorded detail.' }), output: 'Recorded.', state: 'completed' }, { type: 'text', text: 'Recorded fixture summary.\nMore recorded detail.' }] },
    text('p2', 'user', 'Second simulated prompt.'), { id: 'pending', role: 'assistant', blocks: [pending] }];
  // Synthetic in-memory transcript only; no native transcript or account is read for this projection probe.
  const transcript = CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: `claude_${'0'.repeat(32)}`,
    ownerDeviceId: f.app.device.deviceId, deviceName: 'Fixture device', title: 'Synthetic timeline', cwd: f.checkout, project: f.project.name,
    state: 'working', lastActivityAt: at, connected: true, canSteer: false, canSend: false }, turns, messages: [], truncated: false, observedAt: at });
  vi.spyOn(f.app.projectWork.transcripts, 'read').mockResolvedValue(transcript);
  f.app.projectWork.store.update(id, row => ({ ...row, state: 'running', turns: 1, queuedMessages: [{ id: 'queued_owner', from: 'owner', text: '  Keep this pending message.\nNext line.  ', at, interrupt: true }] }));
  const before = structuredClone(f.thread(id)), response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.timeline).toMatchObject({ schema: 'project-thread-timeline-v1', projectId: 'project', threadId: id });
  const items = view.timeline.items as Array<{ kind: string; turn?: CursorTurn; report?: { turn: number }; active?: boolean; groups?: unknown; presentation?: unknown }>;
  expect(items.map(item => item.kind === 'turn' ? item.turn!.id : `report:${item.report!.turn}`)).toEqual(['p1', 'a1', 'report:1', 'p2', 'pending']);
  expect(items.find(item => item.turn?.id === 'a1')).toMatchObject({ active: false, groups: [{ type: 'tools', name: 'Read', calls: [first, second], active: false, awaitingResult: false }] });
  expect(items.find(item => item.turn?.id === 'pending')).toMatchObject({ active: true, groups: [{ type: 'tools', name: 'Bash', calls: [pending], active: true, awaitingResult: true }] });
  expect(items.find(item => item.kind === 'report')?.presentation).toMatchObject({ schema: 'project-thread-report-presentation-v1', projectId: 'project', heading: 'Report · turn 1',
    badge: { text: 'Progress', tone: 'muted' }, preview: 'Recorded fixture summary.', tests: { label: 'Tests passed', tone: 'ok', icon: 'check' } });
  expect(view.timeline.queued).toMatchObject([{ message: { id: 'queued_owner', text: '  Keep this pending message.\nNext line.  ' }, presentation: { schema: 'project-thread-queued-presentation-v1', sourceLabel: 'You', interruptsLabel: 'Interrupts the current turn', preview: 'Keep this pending message.' } }]);
  expect(f.thread(id)).toEqual(before);
  expect(ThreadViewSchema.safeParse(view).success).toBe(true); const older = { ...view }; delete older.timeline; expect(ThreadViewSchema.safeParse(older).success).toBe(true);
  expect(ThreadViewSchema.safeParse({ ...view, timeline: { ...view.timeline, unexpected: true } }).success).toBe(false);
});

test('thread timeline owner reader shares report and queue projections without mutating the thread', async () => {
  const { f, id, path } = await setup(), response = await f.request(path); expect(response.status).toBe(200); const ui = await response.json();
  expect(ui.timeline).toMatchObject({ schema: 'project-thread-timeline-v1', threadId: id }); const before = structuredClone(f.thread(id));
  expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: id } })).toMatchObject({ ok: true, data: { timeline: ui.timeline } });
  expect(f.thread(id)).toEqual(before);
});
