import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import type { LedgerEvent } from '../packages/core/dist/index.js';
import { ownerConversationOperation } from '../apps/daemon/dist/owner-proxy.js';
import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
import type { ProjectFixture } from './helpers/project-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const event = (id: number, type: LedgerEvent['type'], data: unknown): LedgerEvent => ({ schema: 'ledger-event-v1', id, type, data, stretch: 1, t: '2026-10-21T12:00:00.000Z' });

test('shared transcript snapshots preserve final replies and tool order without repeating tool output', () => {
  expect(core.conversationStepTranscriptView).toBeTypeOf('function');
  const events = [event(1, 'text', { delta: 'I will inspect.' }), event(2, 'tool-start', { id: 'read', name: 'Read', input: { path: 'fixture.ts' } }), event(3, 'tool-end', { id: 'read', ok: true, output: '[{"type":"text","text":"Readable output"}]' }), event(4, 'text', { delta: 'Final reply.' }), event(5, 'tool-start', { id: 'handoff', name: 'mcp__jevellan__jevellan_handoff', input: {} }), event(6, 'tool-end', { id: 'handoff', ok: true }), event(7, 'notice', { schema: 'conversation-notice-v1', kind: 'closing', text: 'Final reply.' })];
  const input = { projectId: 'project', conversationId: 'fixture', step: 1, head: 7, running: false, events, notices: [events[6]!], summary: 'Saved summary.', summaries: ['Saved summary.'] };
  const view = core.conversationStepTranscriptView(input);
  expect(view).toMatchObject({ schema: 'conversation-transcript-view-v1', projectId: 'project', conversationId: 'fixture', step: 1, tail: 7, head: 7, running: false, answerIds: ['ledger:4'], fallbackAnswer: null, hiddenNoticeIds: [7] });
  expect(view.activity.map(row => row.kind)).toEqual(['response', 'tools', 'response', 'tools']); expect(view.turns[1]?.blocks[0]).toMatchObject({ type: 'tool', state: 'completed', output: 'Readable output' });
  expect([...JSON.stringify(view).matchAll(/Readable output/g)]).toHaveLength(1);
  const selected = core.selectConversationTranscriptView(view, input); expect(selected).toBe(view);
  const fresh = core.selectConversationTranscriptView(view, { ...input, head: 8, events: [...events, event(8, 'text', { delta: 'New explanation.' })] });
  expect(fresh.tail).toBe(8); expect(fresh.turns.at(-1)?.blocks[0]).toEqual({ type: 'text', text: 'New explanation.' });
  expect(core.selectConversationTranscriptView(view, { ...input, running: true }).running).toBe(true);
  expect(core.selectConversationTranscriptView(view, { ...input, conversationId: 'another_fixture' }).conversationId).toBe('another_fixture');
});

test('canonical transcript purpose reads share exact step metadata and do not expand the root with transcript bodies', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; const starts = f.fake.starts.length, count = f.app.conversations.ledger(made.id).events().length;
  const tail = f.app.conversations.ledger(made.id).events().filter(row => row.stretch === 1).at(-1)!.id;
  const root = await (await f.request(`/api/conversations/${made.id}`)).json(); expect(root.transcriptSources).toEqual([{ step: 1, tail, running: false }]); expect(root).not.toHaveProperty('transcriptView');
  const request = { schema: 'conversation-transcript-request-v1', step: 1 };
  const response = await f.request(`/api/conversations/${made.id}/transcript-view`, 'POST', request); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ schema: 'conversation-transcript-view-v1', projectId: 'project', conversationId: made.id, step: 1, tail, running: false, fallbackAnswer: null }); expect(view.turns.some((row: { blocks: { type: string; text?: string }[] }) => row.blocks.some(block => block.type === 'text' && block.text === 'The simulated plan is recorded.'))).toBe(true);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'conversation_transcript', args: { project: 'project', conversation: made.id, request } })).toMatchObject({ ok: true, data: view });
  expect((await f.request(`/api/conversations/${made.id}/transcript-view`, 'POST', { ...request, step: 2 })).status).toBe(404);
  await expect(ownerConversationOperation(f.app, 'another_project', made.id, 'transcript-view', request)).rejects.toMatchObject({ status: 409 });
  vi.spyOn(f.app.conversations, 'transcriptView').mockResolvedValueOnce({ ...view, step: 2 }); await expect(ownerConversationOperation(f.app, 'project', made.id, 'transcript-view', request)).rejects.toMatchObject({ status: 502 });
  expect(f.fake.starts).toHaveLength(starts); expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});
