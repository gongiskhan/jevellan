import { expect } from 'vitest';
import { DecisionRecordSchema } from '../../packages/core/dist/index.js';
import type { ProjectFixture } from './project-fixture.js';

/** Managed fixture operations with explicitly simulated recorded Jev facts; no live-provider claim. */
export async function seedConversationDecision(f: Pick<ProjectFixture, 'app' | 'fake' | 'request'>, id = 'decision_view_fixture') {
  f.fake.capabilities.readOnlyEnforced = true;
  await f.app.conversations.create({ schema: 'start-conversation-v1', id, projectId: 'project', title: 'Decision view fixture', message: 'Explain the fixture.', clientMessageId: 'decision_view_first' });
  await f.app.conversations.wait(id);
  await f.app.conversations.composerChoice(id, { schema: 'composer-choice-v1', clientRequestId: 'clear_model_fixture', generation: (await f.app.conversations.view(id)).conversation.generation, field: 'model', value: null, mode: 'pin' });
  f.fake.enqueue(async ({ input, emit }) => {
    emit({ type: 'text', delta: 'Explained the simulated fixture.' });
    const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` },
      body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
        schema: 'handoff-v2', stretch: input.stretch, action: input.action, status: 'done', summary: 'Explained the simulated fixture.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [],
      } }),
    });
    expect(response.status).toBe(200); return { status: 'completed' };
  });
  await f.app.conversations.manual(id, { schema: 'manual-step-v1', generation: (await f.app.conversations.view(id)).conversation.generation, action: 'reply', modelId: 'fixture', effort: 'medium' });
  await f.app.conversations.wait(id);
  let view = await f.app.conversations.view(id); expect(view.stretches).toHaveLength(1); expect(view.stretches[0]?.status).toBe('completed');
  await f.app.conversations.correct(id, { schema: 'correct-step-v1', clientRequestId: 'recorded_note_fixture', generation: view.conversation.generation, stretch: 1, mode: 'noted', choices: { effort: 'low' } });
  view = await f.app.conversations.view(id);
  const revision = await f.app.configuration();
  revision.configuration['x-jevellan'].menu.push({ ...revision.configuration['x-jevellan'].menu[0]!, id: 'other_model', label: 'Other fixture', enabled: false });
  const configured = await f.request('/hub/config', 'PUT', { schema: 'config-write-v1', revision: revision.revision, configuration: revision.configuration });
  expect(configured.status).toBe(200);
  const original = view.decisions.find(row => row.id === view.stretches[0]!.decisionId)!;
  const decision = DecisionRecordSchema.parse({ ...original,
    action: { ...original.action, source: 'jev', allowed: ['reply', 'plan', 'implement'], probabilities: { reply: 0.1, plan: 0.3, implement: 0.6 } },
    model: { ...original.model!, source: 'jev', keepCurrentP: 0.2, eligible: [{ modelId: 'fixture', p: 0.3 }, { modelId: 'other_model', p: 0.7 }, { modelId: 'unknown_probability' }], preferredAny: { modelId: 'other_model', p: 0.9 }, excluded: [{ modelId: 'missing_model', reason: 'model-not-served' }] },
    effort: { requested: 'medium', effective: 'high', source: 'jev', probabilities: { medium: 0.8, high: 0.2 } },
    account: { chosen: view.stretches[0]!.accountId, ranking: [{ accountId: view.stretches[0]!.accountId, eligible: true, reason: 'Eligible fixture.' }, { accountId: 'acc_other', eligible: false, reason: 'Cooling fixture.' }] },
    memory: { source: 'search-rank', candidates: ['notes/one', 'notes/two'], chosen: ['notes/one'], scores: { 'notes/one': 0.9, 'notes/two': 0.2 } },
    notices: [{ kind: 'preferred-needs-login', accountId: view.stretches[0]!.accountId, text: 'Simulated account notice.' }],
    correctionsShown: [view.composerOverrides[0]!.id, view.overrides[0]!.id, 'missing_correction'],
    latencyMs: 15, jev: { requestedModel: 'Fixture Jev', returnedModel: 'Fixture Jev', usage: { input_tokens: 3, output_tokens: 6 }, calls: 3,
      records: (['action', 'model', 'memory'] as const).map(kind => ({ schema: 'jev-call-v1', kind, requestedModel: 'Fixture Jev', returnedModel: 'Fixture Jev', usage: { input_tokens: 1, output_tokens: 2 }, latencyMs: 5 })) },
  });
  f.app.conversations.ledger(id).append({ type: 'decision', data: decision });
  return { id, path: `/api/conversations/${id}`, decision };
}
