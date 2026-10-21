import { afterEach, expect, test, vi } from 'vitest';
import * as core from '../packages/core/dist/index.js';
import { UiAuth } from '../packages/mesh/dist/index.js';
import { ownerConversationOperation } from '../apps/daemon/dist/owner-proxy.js';
import { projectFixture, projectMember, type ProjectFixture } from './helpers/project-fixture.js';
import { conversationPlanReviewFixture } from './helpers/conversation-plan-review-fixture.js';
let f: ProjectFixture | undefined;
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); f = undefined; });
const change = { schema: 'git-branch-change-v1' as const, from: 'draft', to: 'main' as const, status: 'completed' as const, created: true, createdRemote: true, before: 'a'.repeat(40), after: 'b'.repeat(40) };

test('shared message delivery retains running, idle and Cursor capability titles', () => {
  expect(core.messageDeliveryView).toBeTypeOf('function');
  expect(core.messageDeliveryView({ running: false })).toMatchObject({ schema: 'message-delivery-view-v1', primaryLabel: 'Send', primaryTitle: 'Send message', primaryEnabled: true, queueEnabled: false, queueTitle: 'Queue is available while work is running' });
  expect(core.messageDeliveryView({ running: true })).toMatchObject({ primaryLabel: 'Steer', primaryTitle: 'Steer current work', primaryEnabled: true, queueEnabled: true, queueTitle: 'Queue for when current work finishes' });
  const cursor = core.messageDeliveryView({ running: true, canSend: true, canSteer: false, cursor: true });
  expect(cursor).toMatchObject({ primaryEnabled: false, queueEnabled: true, primaryTitle: 'Connection hooks and an active Cursor turn are needed. Use the session’s settings in the list.' });
  expect(core.messageDeliveryView({ running: true, canSend: false, canSteer: true, cursor: true })).toMatchObject({ primaryTitle: 'Steer after the next tool call', primaryEnabled: true, queueEnabled: false });
  expect(core.messageDeliveryView({ running: false, canSend: false, canSteer: true })).toMatchObject({ primaryEnabled: false, primaryTitle: 'Message delivery is unavailable.', queueEnabled: false });
});

test('shared branch copy preserves both notice and short-message tense and publication history', () => {
  expect(core.branchChangeView).toBeTypeOf('function');
  expect(core.branchChangeView(change)).toMatchObject({ schema: 'branch-change-view-v1', title: 'Switched to main', text: 'Switched from draft to main. Main was created from published branch history, locally and on origin. The original branch is preserved.', body: 'Main was created from the published branch history, locally and on origin. The original branch is preserved. Work continues on main.' });
  expect(core.branchChangeView({ ...change, status: 'planned', createdRemote: false })).toMatchObject({ title: 'Switching to main', text: 'Switching from draft to main. The original branch is preserved.', body: 'The original branch is preserved. Jevellan will work on main after switching.' });
});

test('shared diff rows retain line numbers, file boundaries, deleted paths and no-newline metadata', () => {
  expect(core.changesDiffView).toBeTypeOf('function');
  const text = 'diff --git a/value.ts b/value.ts\n--- a/value.ts\n+++ b/value.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n\\ No newline at end of file\ndiff --git a/gone.md b/gone.md\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const view = core.changesDiffView(text); expect(view).toMatchObject({ schema: 'changes-diff-view-v1', empty: false, sections: [{ path: 'value.ts', added: 1, removed: 1 }, { path: 'gone.md', added: 0, removed: 1 }] });
  expect(view.sections[0]?.rows.filter(row => ['removal', 'addition', 'context'].includes(row.kind))).toEqual([{ line: '-old', kind: 'removal', before: 1 }, { line: '+new', kind: 'addition', after: 1 }, { line: ' same', kind: 'context', before: 2, after: 2 }]);
  expect(view.sections[0]?.rows.find(row => row.line.includes('No newline'))).toEqual({ line: '\\ No newline at end of file', kind: 'meta' }); expect(core.changesDiffView('').empty).toBe(true);
});

test('canonical conversation and changes readers share delivery, branch notices and parsed diffs without starting work', async () => {
  const made = await conversationPlanReviewFixture(); f = made.f; const event = f.app.conversations.ledger(made.id).append({ type: 'git', data: change });
  const starts = f.fake.starts.length, count = f.app.conversations.ledger(made.id).events().length;
  const response = await f.request(`/api/conversations/${made.id}`); expect(response.status).toBe(200); const view = await response.json();
  expect(view).toMatchObject({ delivery: { schema: 'message-delivery-view-v1', primaryLabel: 'Send', queueEnabled: false }, branchChanges: [{ eventId: event.id, view: { title: 'Switched to main', body: 'Main was created from the published branch history, locally and on origin. The original branch is preserved. Work continues on main.' } }] });
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'conversation_view', args: { project: 'project', conversation: made.id } })).toMatchObject({ ok: true, data: view });
  const read = await f.request(`/api/conversations/${made.id}/changes/1`); expect(read.status).toBe(200); const changes = await read.json();
  expect(changes).toMatchObject({ schema: 'conversation-changes-v1', projectId: 'project', conversationId: made.id, stretch: 1, diffView: { schema: 'changes-diff-view-v1' }, uncommittedView: { schema: 'changes-diff-view-v1' } });
  expect(changes.diffView).toEqual(core.changesDiffView(changes.diff)); expect(changes.uncommittedView).toEqual(core.changesDiffView(changes.uncommitted));
  expect(await f.app.ownerTools.call('jev', { schema: 'owner-tool-request-v1', caller: 'cli', action: 'conversation_changes', args: { project: 'project', conversation: made.id, stretch: 1 } })).toMatchObject({ ok: true, data: changes });
  expect(f.fake.starts).toHaveLength(starts); expect(f.app.conversations.ledger(made.id).events()).toHaveLength(count);
});

test('member conversation reads bind resource identity and revoke temporary authority on mismatch', async () => {
  f = await projectFixture(); const member = await projectMember(f), id = 'member_reading_view';
  await member.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Member reading view', message: 'Read the simulated conversation.', clientMessageId: 'reading_first' });
  await member.app.conversations.wait(id); await member.app.conversations.list();
  const auth = f.app.auth; if (!(auth instanceof UiAuth)) throw Error('Expected state-point authority.');
  const local = vi.spyOn(f.app.conversations, 'view'), remote = vi.spyOn(member.app.conversations, 'view'), issue = vi.spyOn(auth, 'issue'), revoke = vi.spyOn(auth, 'logout');
  const value = core.ConversationPublicSchema.parse(await ownerConversationOperation(f.app, 'project', id, 'conversation-view')); expect(value.conversation.id).toBe(id); expect(value.delivery?.primaryLabel).toBe('Send'); expect(local).not.toHaveBeenCalled();
  remote.mockResolvedValueOnce({ ...value, conversation: { ...value.conversation, id: 'another_conversation' } });
  await expect(ownerConversationOperation(f.app, 'project', id, 'conversation-view')).rejects.toMatchObject({ status: 502 });
  expect(revoke.mock.calls.length).toBe(issue.mock.calls.length); expect(f.app.conversations.hasLocalConversation(id)).toBe(false); expect(member.fake.starts).toHaveLength(0);
});


test('busy preparation retains Steer and Queue before the runtime step starts', async () => {
  f = await projectFixture(); const id = 'busy_reading_fixture';
  await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Busy preparation fixture', message: 'Exercise the simulated preparation state.', clientMessageId: 'busy_first', choices: { schema: 'composer-initial-v1', pins: { modelId: 'fixture', effort: 'low' }, once: {} } }); await f.app.conversations.wait(id);
  let entered = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const acquire = f.app.conversations.ownership.acquire.bind(f.app.conversations.ownership);
  vi.spyOn(f.app.conversations.ownership, 'acquire').mockImplementation(async (...args) => { entered = true; await gate; return acquire(...args); });
  f.fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: 'The simulated preparation finishes.' });
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'The simulated preparation finishes.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'done', changedFiles: [] } }) });
    expect(response.status).toBe(200); return { status: 'completed' };
  });
  const admission = f.app.conversations.manual(id, { schema: 'manual-step-v1', generation: (await f.app.conversations.view(id)).conversation.generation, action: 'implement', modelId: 'fixture', effort: 'low' });
  try {
    await f.waitFor(() => entered, value => value);
    const response = await f.request(`/api/conversations/${id}`); expect(response.status).toBe(200); const during = await response.json();
    expect(during.busy).toBe(true); expect(during.conversation.state).not.toBe('running'); expect(f.fake.starts).toHaveLength(0);
    expect(during.delivery).toMatchObject({ primaryLabel: 'Steer', primaryEnabled: true, queueEnabled: true });
  } finally { release(); await admission; await f.app.conversations.wait(id); }
  expect((await f.app.conversations.view(id)).delivery).toMatchObject({ primaryLabel: 'Send', queueEnabled: false });
});
