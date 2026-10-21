import { expect } from 'vitest';
import { projectFixture } from './project-fixture.js';

/** One canonical simulated plan, produced through the existing managed runtime bridge. */
export async function conversationPlanReviewFixture(control = false) {
  const f = await projectFixture({ control }), id = 'plan_review_fixture';
  f.fake.capabilities.readOnlyEnforced = true;
  const revision = await f.app.configuration(); revision.configuration['x-jevellan'].guards.pauseAfterPlan = true;
  f.app.hub.configuration.put(revision.configuration, revision.revision, { deviceId: f.app.device.deviceId, source: 'ui' });
  await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Plan approval fixture', message: 'Plan the simulated fixture.', clientMessageId: 'review_first' });
  await f.app.conversations.wait(id);
  await f.app.conversations.composerChoice(id, { schema: 'composer-choice-v1', clientRequestId: 'review_clear_model', generation: (await f.app.conversations.view(id)).conversation.generation, field: 'model', value: null, mode: 'pin' });
  f.fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: 'The simulated plan is recorded.' });
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` },
      body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'The simulated plan is recorded.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: 'implement', changedFiles: [], result: { type: 'plan', content: '# Recorded fixture plan\n\n1. Preserve the work.\n2. Check the result.' } } }) });
    expect(response.status).toBe(200); return { status: 'completed' };
  });
  await f.app.conversations.manual(id, { schema: 'manual-step-v1', generation: (await f.app.conversations.view(id)).conversation.generation, action: 'plan', modelId: 'fixture', effort: 'medium' });
  await f.app.conversations.wait(id); const view = await f.app.conversations.view(id); expect(view.stretches).toHaveLength(1); expect(view.stretches[0]?.status).toBe('completed');
  const pointer = view.conversation.work!.latestPlanRef!; expect(pointer).toBeTruthy();
  return { f, id, pointer, view };
}
