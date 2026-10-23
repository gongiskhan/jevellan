import { expect, test } from 'vitest';
import { ProjectDecisionSchema, ThreadIndexSchema } from '../packages/core/dist/index.js';
import { projectFixture } from './helpers/project-fixture.js';
import { thread } from './helpers/owner-fixtures.js';

test('a coordinator cannot withdraw an unanswered question while its linked thread is still unresolved', async () => {
  const f = await projectFixture();
  try {
    const index = ThreadIndexSchema.parse(thread('blocked_thread', 'Blocked landing', { projectId: 'project', ownerDeviceId: f.app.device.deviceId,
      state: 'idle', stateReason: 'Landing checks failed three times.' }));
    await f.app.projectHub.publishThread(index, 1);
    const id = await f.app.projectWork.decisions.ask('project', { threadId: index.id, question: 'The prerequisite remains unavailable. What should happen?' }, 'coordinator');
    await expect(f.app.projectWork.decisions.withdraw('project', id, 'No longer needed.', 'coordinator'))
      .rejects.toThrow('The linked thread is still unresolved');
    expect((await f.app.projectHub.decision(id))?.document).toMatchObject({ id });
    expect((await f.app.projectHub.decision(id))?.document.withdrawnAt).toBeUndefined();
    expect((await f.app.projectHub.decisions('project')).some(row => row.id === id)).toBe(true);
  } finally { await f.close(); }
});

test('resolved waiting items retain their closure reason in normal status and reject later answers', async () => {
  const f = await projectFixture();
  try {
    const id = await f.app.projectWork.decisions.ask('project', { question: 'Should the optional check run?' }, 'coordinator');
    const reason = 'The optional check was removed from the requested scope.';
    expect(await f.app.projectWork.decisions.withdraw('project', id, reason, 'coordinator')).toBe(true);
    const saved = (await f.app.projectHub.decision(id))!.document;
    expect(saved).toMatchObject({ withdrawal: { schema: 'project-decision-withdrawal-v1', source: 'coordinator', reason } });
    expect((await f.app.projectHub.decisions('project', { includeClosed: true })).find(row => row.id === id)).toMatchObject({ withdrawal: { reason } });
    const response = await f.app.ownerTools.call('status', { schema: 'owner-tool-request-v1', caller: 'bridge:project', args: { section: 'waiting', detail: true } });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('Expected normal status.');
    expect(response.data).toMatchObject({ waiting: [], closedWaiting: [expect.objectContaining({ internalId: id, state: 'resolved', closureReason: reason })] });
    expect(response.text).toContain(reason);
    await expect(f.app.projectWork.decisions.answer('project', id, { clientRequestId: 'late_answer', text: 'Yes.' })).rejects.toThrow('withdrawn');
  } finally { await f.close(); }
});

test('an old open waiting item remains open independently of age and retries do not replace its recorded closure', async () => {
  const f = await projectFixture();
  try {
    const old = ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id: 'old_question', projectId: 'project', from: 'coordinator',
      question: 'An old unanswered choice.', options: [], createdAt: '2020-01-01T00:00:00.000Z' });
    await f.app.projectHub.createDecision(old);
    expect((await f.app.projectHub.decisions('project')).find(row => row.id === old.id)).toMatchObject({ createdAt: old.createdAt });
    await f.app.projectWork.decisions.withdraw('project', old.id, 'Explicitly resolved.', 'coordinator');
    await f.app.projectWork.decisions.withdraw('project', old.id, 'A retry must not replace this reason.', 'coordinator');
    expect((await f.app.projectHub.decision(old.id))?.document).toMatchObject({ withdrawal: { reason: 'Explicitly resolved.' } });
  } finally { await f.close(); }
});

test('LEGACY075 withdrawal history uses the recorded coordinator reason without rewriting the question', async () => {
  const f = await projectFixture();
  try {
    const created = await f.app.projectHub.createDecision(ProjectDecisionSchema.parse({ schema: 'project-decision-v1', revision: 0, id: 'legacy_withdrawn', projectId: 'project',
      from: 'coordinator', question: 'A historical unanswered question.', options: [], createdAt: new Date().toISOString() }));
    const at = new Date().toISOString(), reason = 'The coordinator treated the prerequisite as resolved.';
    f.app.hub.put('project-decisions', created.document.id, ProjectDecisionSchema, { ...created.document, revision: created.revision + 1, withdrawnAt: at }, created.revision);
    f.app.projectWork.coordinatorLedger('project').append({ type: 'coordinator-tool', data: { schema: 'coordinator-tool-v1', tool: 'jevellan_withdraw_question', ok: true,
      summary: 'Withdrew a question.', decisionId: created.document.id, reason } });
    const response = await f.app.ownerTools.call('status', { schema: 'owner-tool-request-v1', caller: 'bridge:project', args: { section: 'waiting', detail: true } });
    expect(response.ok).toBe(true); if (!response.ok) throw new Error('Expected status.');
    expect(response.data).toMatchObject({ closedWaiting: [expect.objectContaining({ state: 'withdrawn', closureReason: reason })] });
    expect(response.text).toContain(reason);
    const after = (await f.app.projectHub.decision(created.document.id))!.document;
    expect(after).toMatchObject({ withdrawnAt: at }); expect(after.answer).toBeUndefined(); expect(after.withdrawal).toBeUndefined();
  } finally { await f.close(); }
});
