import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { CursorTranscriptSchema, ThreadCreatedViewSchema, ThreadViewSchema, type CursorTurn } from '../packages/core/dist/index.js';
import { forThread } from '../packages/runtime-contract/dist/index.js';
import { projectFixture, reportStep, type ProjectFixture } from './helpers/project-fixture.js';

let fixture: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); fixture = undefined; });
const at = '2026-10-20T12:00:00.000Z';
async function setup() {
  const f = fixture = await projectFixture(); f.fake.enqueueTurn(reportStep({ status: 'progress', summary: 'Simulated transcript view ready.' }), forThread());
  const made = await f.json('/api/projects/project/threads', ThreadCreatedViewSchema, 'POST', { schema: 'thread-create-request-v1', clientRequestId: 'transcript_view_fixture', title: 'Transcript view fixture', task: 'Inspect the simulated transcript.' });
  await f.waitFor(() => f.thread(made.threadId), row => row.state === 'idle');
  return { f, id: made.threadId, path: `/api/projects/project/threads/${made.threadId}` };
}
function transcript(f: ProjectFixture, turns: CursorTurn[]) {
  return CursorTranscriptSchema.parse({ schema: 'cursor-transcript-v1', session: { schema: 'cursor-session-v1', id: `claude_${'0'.repeat(32)}`,
    ownerDeviceId: f.app.device.deviceId, deviceName: 'Fixture device', title: 'Synthetic transcript', cwd: f.checkout, project: f.project.name,
    state: 'idle', lastActivityAt: at, connected: true, canSteer: false, canSend: false }, turns, messages: [], truncated: false, observedAt: at });
}

test('thread reader prepares labels, prompt previews and tool evidence without steering work', async () => {
  const { f, id, path } = await setup(); const before = structuredClone(f.thread(id));
  vi.spyOn(f.app.projectWork.transcripts, 'read').mockResolvedValue(transcript(f, [
    { id: 'prompt', role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(1201) }] },
    { id: 'automatic', role: 'user', automated: true, blocks: [{ type: 'text', text: 'Recorded update.' }] },
    { id: 'tools', role: 'assistant', blocks: [{ type: 'tool', id: 'read', name: 'Read', input: JSON.stringify({ path: 'src/a.ts', file_path: 'src/a.ts', filePath: 'src/b.ts' }), state: 'unknown' }] },
  ]));
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  const turns = view.timeline.items.filter((item: { kind: string }) => item.kind === 'turn').map((item: { turn: CursorTurn }) => item.turn);
  expect(turns[0].presentation).toMatchObject({ schema: 'transcript-turn-presentation-v1', label: 'Prompt', collapsed: false, preview: `${'x'.repeat(159)}…` });
  expect(turns[1].presentation.label).toBe('Automatic update');
  expect(turns[2].presentation.groups[0].calls).toEqual([{ stateLabel: 'Recorded', files: ['src/a.ts', 'src/b.ts'], noResultText: 'The saved transcript does not include this tool’s result.' }]);
  expect(view.historyView).toMatchObject({ schema: 'session-history-view-v1', projectId: 'project', visible: false, entries: [] });
  expect(f.thread(id)).toEqual(before); const older = structuredClone(view); delete older.historyView; for (const item of older.timeline.items) if (item.kind === 'turn') delete item.turn.presentation;
  expect(ThreadViewSchema.safeParse(older).success).toBe(true); expect(ThreadViewSchema.safeParse({ ...view, historyView: { ...view.historyView, unexpected: true } }).success).toBe(false);
});

test('earlier-session links and historical prompt display share the owner-bound reader without exposing native identity', async () => {
  const { f, id, path } = await setup(); const key = 'a'.repeat(64), native = 'synthetic-earlier-session';
  f.app.projectWork.store.updateLocal(id, local => ({ ...local, sessionHistory: [{ schema: 'project-session-history-v1', key, nativeSessionId: native, runtime: 'fake', model: 'Fixture model', accountId: 'account_fixture', at }] }));
  vi.spyOn(f.app.projectWork.transcripts, 'read').mockResolvedValue(transcript(f, [{ id: 'long_history', role: 'user', blocks: [{ type: 'text', text: 'h'.repeat(3001) }] }]));
  const before = structuredClone(f.thread(id)), runs = f.fake.runs.length;
  const old = await f.request(`${path}?session=${key}`); expect(old.status).toBe(200); const historical = await old.json(); expect(historical.turns[0].blocks[0].text).toBe('h'.repeat(3001)); expect(JSON.stringify(historical)).not.toContain(native);
  expect(historical.turns[0].presentation).toMatchObject({ schema: 'transcript-turn-presentation-v1', label: 'Prompt', collapsed: true, preview: `${'h'.repeat(159)}…` });
  const response = await f.request(path); expect(response.status).toBe(200); const view = await response.json();
  expect(view.historyView).toEqual({ schema: 'session-history-view-v1', projectId: 'project', visible: true, summary: 'Earlier sessions (1)', title: 'Earlier session', entries: [{ key, href: `${path}?session=${key}`, runtime: 'fake', model: 'Fixture model', at }] });
  expect(await f.app.ownerTools.call('thread', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'view', args: { project: 'project', thread: id } })).toMatchObject({ ok: true, data: { historyView: view.historyView } });
  expect((await f.request(`${path}?session=${'b'.repeat(64)}`)).status).toBe(404); expect(f.thread(id)).toEqual(before); expect(f.fake.runs).toHaveLength(runs);
});

test('project status shares the hidden empty earlier-session model without starting work', async () => {
  const f = fixture = await projectFixture(); const response = await f.request('/api/projects/project/work'); expect(response.status).toBe(200); const view = await response.json();
  expect(view.historyView).toEqual({ schema: 'session-history-view-v1', projectId: 'project', visible: false, summary: 'Earlier sessions (0)', title: 'Earlier session', entries: [] });
  expect(await f.app.ownerTools.call('status', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'status', args: { project: 'project' } })).toMatchObject({ ok: true, data: { historyView: view.historyView } }); expect(f.fake.runs).toHaveLength(0);
});

test('shared transcript display preserves exact collapse boundaries, automated labels and current tool state', () => {
  const display = core.transcriptTurnPresentation;
  expect(display).toBeTypeOf('function');
  const user = (text: string): CursorTurn => ({ id: 'u', role: 'user', blocks: [{ type: 'text', text }] });
  expect(display(user('x'.repeat(1200)), { collapseLongUser: 1200 })).toMatchObject({ label: 'You', collapsed: false });
  expect(display(user('x'.repeat(1201)), { collapseLongUser: 1200 })).toMatchObject({ collapsed: true, preview: `${'x'.repeat(159)}…` });
  expect(display(user('a'), { collapseLongUser: 0, focus: true, userLabel: 'Prompt' })).toMatchObject({ label: 'Prompt', collapsed: false });
  expect(display({ ...user('a'), automated: true }, { userLabel: 'Prompt' })).toMatchObject({ label: 'Automatic update' });
  const turn: CursorTurn = { id: 'a', role: 'assistant', blocks: [{ type: 'tool', id: 'one', name: 'Read', input: '[]', state: 'running' }, { type: 'tool', id: 'two', name: 'Read', input: '{bad', state: 'unknown' }] };
  expect(display(turn, { active: true }).groups[0]).toEqual({ preview: '', countLabel: '2 calls', waitingSuffix: ' · Waiting for result', calls: [
    { stateLabel: 'In progress', files: [], noResultText: 'Waiting for the tool’s result…' },
    { stateLabel: 'Recorded', files: [], noResultText: 'The saved transcript does not include this tool’s result.' },
  ] });
  expect(display(turn).groups[0]?.waitingSuffix).toBe('');
  expect(display({ ...turn, blocks: [{ type: 'tool', id: 'one', name: 'Read', input: '{}', state: 'completed', output: '' }] }).groups[0]?.calls[0]?.noResultText).toBeNull();
});
