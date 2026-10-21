import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
import type { ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });

test('plan review read models share canonical pending state and step-bound tool facts without starting work', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; const starts = f.fake.starts.length, count = f.app.conversations.ledger(made.id).events().length;
  const response = await f.request(`/api/conversations/${made.id}`); expect(response.status).toBe(200); const view = await response.json();
  expect(view.plans).toMatchObject({ schema: 'conversation-plans-view-v1', projectId: 'project', conversationId: made.id, blocked: true, current: { pointer: made.pointer, step: 1, domId: 'plan-step-1' }, reviews: [{ schema: 'conversation-plan-review-v1', pointer: made.pointer, step: 1, generation: view.conversation.generation, approved: false, offered: true, status: 'awaiting-approval', badge: 'Awaiting approval' }] });
  const request = { schema: 'conversation-plan-read-request-v1', pointer: made.pointer, step: 1 };
  const read = await f.request(`/api/conversations/${made.id}/plan-read`, 'POST', request); expect(read.status).toBe(200); const result = await read.json(); expect(result.review).toEqual(view.plans.reviews[0]);
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_read', args: { project: 'project', conversation: made.id, request } })).toMatchObject({ ok: true, data: result });
  expect((await f.request(`/api/conversations/${made.id}/plan-read`, 'POST', { ...request, step: 2 })).status).toBe(409);
  expect(f.fake.starts).toHaveLength(starts); expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});

test('shared plan review preserves last valid step, closed-work approval and exact feedback validity', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; const source = made.view;
  expect(core.conversationPlansView).toBeTypeOf('function'); expect(core.planFeedbackReady).toBeTypeOf('function');
  expect(core.planFeedbackReady('   \n')).toBe(false); expect(core.planFeedbackReady(' Keep the raw feedback. ')).toBe(true);
  const paused = core.conversationPlansView(source, true); expect(paused.current?.step).toBe(1); expect(paused.reviews[0]?.offered).toBe(true);
  const disabled = core.conversationPlansView(source, false); expect(disabled.blocked).toBe(false); expect(disabled.reviews[0]?.badge).toBe('Recorded plan');
  const approved = core.conversationPlansView({ ...source, conversation: { ...source.conversation, work: { ...source.conversation.work!, approvedPlanRef: made.pointer } } }, true); expect(approved.blocked).toBe(false); expect(approved.reviews[0]).toMatchObject({ approved: true, offered: false, status: 'approved', badge: 'Approved' });
  const undone = core.conversationPlansView({ ...source, stretches: source.stretches.map(row => ({ ...row, status: 'undone' as const })) }, true); expect(undone.current?.step).toBeNull(); expect(undone.reviews[0]?.offered).toBe(false);
  const closed = core.conversationPlansView({ ...source, conversation: { ...source.conversation, work: null }, closedWorks: [{ ...source.conversation.work!, approvedPlanRef: made.pointer, closedAs: 'done' as const }] }, true); expect(closed.blocked).toBe(false); expect(closed.reviews[0]).toMatchObject({ approved: true, offered: false, badge: 'Approved' });
});

test('plan approval and feedback tools retain the canonical generation guard and duplicate-message behavior', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; const generation = made.view.conversation.generation;
  const stale = await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_approve', args: { project: 'project', conversation: made.id, request: { schema: 'plan-approval-v1', generation: generation + 1, ref: made.pointer } } });
  expect(stale).toMatchObject({ ok: false, error: { code: 'failed', text: 'The request could not complete: Plan approval is stale.' } });
  const request = { schema: 'conversation-message-v1', clientMessageId: 'review_changes_once', text: ' Keep every recorded requirement. ', planChange: { ref: made.pointer, generation } };
  const first = await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_changes', args: { project: 'project', conversation: made.id, request } }); expect(first.ok).toBe(true); await f.app.conversations.wait(made.id);
  expect((await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'plan_changes', args: { project: 'project', conversation: made.id, request } })).ok).toBe(true);
  const events = f.app.conversations.ledger(made.id).events().filter(row => row.type === 'user-message').map(row => f!.app.conversations.ledger(made.id).data(row)); expect(events.filter((row: unknown) => (row as { clientMessageId?: string }).clientMessageId === request.clientMessageId)).toHaveLength(1);
});
