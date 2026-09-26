import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundDraftResultSchema, Homes, ImproverStateSchema, OverrideRecordSchema, RoutingRevisionRecordSchema, RoutingSuggestionRowSchema, parseConfiguration, seedConfiguration, type BackgroundDraftRequest, type BackgroundDraftResult } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { JevClient, buildJevRequest, parseJevResponse, type DecisionClient } from '../packages/decisions/dist/index.js';
import { RoutingImprover } from '../apps/daemon/dist/routing-improver.js';

let root: string; let hub: HubDatabase; let improver: RoutingImprover; let probability: number; let questions: string[]; let drafts: BackgroundDraftRequest[]; let active: number;
let generate: (request: BackgroundDraftRequest, signal: AbortSignal) => Promise<BackgroundDraftResult>;
let client: DecisionClient;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-routing-improver-')); mkdirSync(join(root, 'user')); hub = new HubDatabase(new Homes(join(root, 'home'), join(root, 'user')), 'hub');
  hub.configuration.put(seedConfiguration(), 0, { deviceId: 'hub', source: 'install' }); probability = 0.8; questions = []; drafts = []; active = 0;
  client = { async decide(input) {
    const wire = buildJevRequest(input);
    const answers = Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      questions.push(id);
      if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'consistent_preference' ? probability : 0 }];
      if (question.type !== 'choice') throw new Error('Unexpected fixture question.');
      const choice = Object.keys(question.criteria)[0]!;
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])), confidence: 1 }];
    }));
    return parseJevResponse(JSON.stringify({ model: 'simulated-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } }), wire.questions);
  } };
  generate = async request => {
    const configuration = parseConfiguration(request.files['apm.yml']!); const group = JSON.parse(request.files['corrections.json']!);
    return BackgroundDraftResultSchema.parse({ schema: 'background-draft-result-v1', runId: request.id, modelId: 'fixture_model', accountId: 'fixture_account', effort: 'high', usage: { inputTokens: 10, outputTokens: 5, costSource: 'unknown' },
      handoff: { schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'A simulated routing draft.', result: { type: 'suggestion', ref: `blobs/${'a'.repeat(64)}` }, evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [] },
      content: { schema: 'routing-draft-v1', title: `Preference for ${group.key.action}`, reason: 'Consistent explicit corrections.', field: { kind: 'routing-profile' }, before: configuration['x-jevellan'].routingProfile,
        after: `${configuration['x-jevellan'].routingProfile}\nPrefer GPT for ${group.key.action}.`, evidenceOverrideIds: group.overrides.map((value: { id: string }) => value.id) },
    });
  };
  improver = new RoutingImprover({ hub, deviceId: 'hub', ready: Promise.resolve(), evidence: 'simulated', client: () => client,
    draft: async (request, signal) => { drafts.push(request); return generate(request, signal); }, enterOperation: () => { active++; return () => { active--; }; } });
});
afterEach(async () => { await improver.close(); hub.close(); rmSync(root, { recursive: true, force: true }); });
function seed(action: 'implement' | 'review' = 'implement') {
  for (const n of [1, 2, 3]) {
    const id = `${action}_${n}`;
    const record = OverrideRecordSchema.parse({ schema: 'override-v1', id, request: { schema: 'correct-step-v1', clientRequestId: `request_${id}`, generation: 0, stretch: 1, mode: 'noted', choices: { modelId: 'codex-gpt' } },
      conversationId: 'conversation', projectId: 'project', workId: 'work', decisionId: `decision_${id}`, at: new Date().toISOString(), action, context: 'A specified backend change.', changes: [{ field: 'model', from: 'claude-fable', to: 'codex-gpt' }] });
    hub.put('overrides', id, OverrideRecordSchema, record, 0);
  }
}

test('two correction groups produce two pending suggestions, each checked against all 24 cases, without applying configuration', async () => {
  seed(); seed('review'); const job = await improver.run({ kind: 'manual', id: 'run_one' }); await improver.wait(job.id);
  const suggestions = improver.suggestions.visible(); expect(suggestions).toHaveLength(2); expect(drafts).toHaveLength(2);
  expect(suggestions.every(row => row.suggestion.status === 'pending' && row.suggestion.comparison.cases.length === 24 && row.suggestion.comparison.evidence === 'simulated')).toBe(true);
  expect(questions.filter(value => value === 'consistent_preference')).toHaveLength(2); expect(hub.configuration.history()).toHaveLength(1);
  expect(improver.jobs.list()).toEqual([expect.objectContaining({ status: 'complete', note: '2 routing suggestions ready.' })]);
  expect(improver.log(job.id)?.entries.filter(value => value.stage === 'checked')).toHaveLength(2); expect(active).toBe(0);
  const next = await improver.run({ kind: 'manual', id: 'run_two' }); await improver.wait(next.id);
  expect(drafts).toHaveLength(2); expect(improver.jobs.list().find(value => value.id === next.id)?.note).toBe('No new routing suggestions.');
});

test('probabilities below 0.7 never launch a draft or evaluate cases; exactly 0.7 qualifies', async () => {
  seed(); probability = 0.69; const first = await improver.run({ kind: 'manual', id: 'first' }); await improver.wait(first.id);
  expect(questions).toEqual(['consistent_preference']); expect(drafts).toEqual([]); expect(improver.suggestions.list()).toEqual([]);
  probability = 0.7; const second = await improver.run({ kind: 'manual', id: 'second' }); await improver.wait(second.id);
  expect(drafts).toHaveLength(1); expect(improver.suggestions.list()).toHaveLength(1);
});

test('missing Jev credentials fail the job without a draft, fabricated result or configuration change', async () => {
  seed(); client = new JevClient({ key: () => undefined, timeoutMs: 1000 }); const job = await improver.run({ kind: 'manual', id: 'missing_key' });
  await improver.wait(job.id).catch(() => undefined);
  expect(improver.jobs.list()[0]).toMatchObject({ status: 'failed', note: 'no key configured' });
  expect(improver.log(job.id)?.entries.at(-1)).toMatchObject({ stage: 'failed', note: 'no key configured' });
  expect(drafts).toEqual([]); expect(improver.suggestions.list()).toEqual([]); expect(hub.configuration.history()).toHaveLength(1); expect(active).toBe(0);
});

test('a target changed during generation becomes a recomputation request and keeps the newer text', async () => {
  seed(); const original = generate;
  generate = async (request, signal) => {
    const result = await original(request, signal); const current = hub.configuration.current()!; current.configuration['x-jevellan'].routingProfile = 'A newer user preference.';
    hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' }); return result;
  };
  const job = await improver.run({ kind: 'manual', id: 'concurrent_edit' }); await improver.wait(job.id);
  expect(improver.suggestions.list()[0]?.suggestion.status).toBe('recompute');
  expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe('A newer user preference.'); expect(hub.configuration.history()).toHaveLength(2);
});

test('closing the routing job cancels its draft and records failure without publishing a suggestion', async () => {
  seed(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  generate = async (_request, signal) => { entered(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Draft cancelled.')), { once: true }); }); };
  const job = await improver.run({ kind: 'manual', id: 'cancel' }); await started; await improver.close();
  expect(improver.jobs.list().find(value => value.id === job.id)?.status).toBe('failed'); expect(improver.suggestions.list()).toEqual([]); expect(active).toBe(0);
});

test('disabled nightly scheduling does not block a manual request, while the routing job toggle does', async () => {
  let current = hub.configuration.current()!; current.configuration['x-jevellan'].improver.schedule.enabled = false;
  hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' });
  expect(await improver.nightly(new Date(2026, 8, 25, 23))).toBeNull(); expect(improver.jobs.list()).toEqual([]);
  const job = await improver.run({ kind: 'manual', id: 'manual' }); await improver.wait(job.id); expect(improver.jobs.list()).toHaveLength(1);
  current = hub.configuration.current()!; current.configuration['x-jevellan'].improver.routing.enabled = false;
  hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' });
  await expect(improver.run({ kind: 'manual', id: 'disabled' })).rejects.toThrow('disabled'); expect(improver.jobs.list()).toHaveLength(1);
});

async function suggestion() {
  seed(); const job = await improver.run({ kind: 'manual', id: 'initial' }); await improver.wait(job.id); return improver.suggestions.visible()[0]!;
}
test('a direct preview is checked without generation, survives a lost reply and only applies on an explicit decision', async () => {
  const row = await suggestion(); const after = 'Prefer GPT for backend fixes in the selected project.';
  const request = { schema: 'routing-revision-request-v1' as const, clientRequestId: 'edit', suggestionId: row.suggestion.id, revision: row.revision, kind: 'text' as const, after };
  const started = await improver.revisions.request(request, 'hub'); await improver.revisions.wait(started.id);
  const ready = await improver.revisions.request(request, 'hub');
  expect(ready).toMatchObject({ status: 'complete', preview: { draft: { after }, comparison: { evidence: 'simulated' } } }); expect(ready.preview!.comparison.cases).toHaveLength(24);
  expect(drafts).toHaveLength(1); expect(hub.configuration.current()?.revision).toBe(1);
  await expect(improver.revisions.request({ ...request, after: 'Something else.' }, 'hub')).rejects.toThrow('another change');
  const applied = RoutingSuggestionRowSchema.parse(await improver.request({ schema: 'improver-request-v1', operation: 'act', suggestionId: row.suggestion.id,
    input: { schema: 'routing-suggestion-action-v1', kind: 'apply', revision: row.revision, previewId: ready.preview!.id, clientRequestId: 'apply_preview' } }, 'hub'));
  expect(applied.suggestion.outcomes.at(-1)?.kind).toBe('applied-after-change'); expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(after);
  const options = improver.options; await improver.close(); improver = new RoutingImprover(options);
  expect(await improver.revisions.request(request, 'hub')).toEqual(ready); expect(drafts).toHaveLength(1);
});

test('plain-language Change it launches exactly one further read-only draft and never applies the preview', async () => {
  const row = await suggestion(); const request = { schema: 'routing-revision-request-v1' as const, clientRequestId: 'instruction', suggestionId: row.suggestion.id,
    revision: row.revision, kind: 'instruction' as const, instruction: 'Only for UI work in ekoa-code.' };
  const started = await improver.revisions.request(request, 'member');
  expect((await improver.revisions.request(request, 'member')).id).toBe(started.id);
  await improver.revisions.wait(started.id); const ready = improver.revisions.get(started.id);
  expect(ready.status).toBe('complete'); expect(ready.preview?.instruction).toBe(request.instruction);
  expect(drafts).toHaveLength(2); expect(drafts[1]!.files['instruction.txt']).toBe(request.instruction); expect(drafts[1]!.files['previous-draft.json']).toBe(JSON.stringify(row.suggestion.draft));
  expect(hub.configuration.current()?.revision).toBe(1); expect(active).toBe(0);
});

test('Apply against a changed field automatically drafts and checks a replacement, still requiring a new Apply', async () => {
  const row = await suggestion(); const current = hub.configuration.current()!; current.configuration['x-jevellan'].routingProfile = 'The user changed this field.';
  current.configuration['x-jevellan'].guards.pauseAfterPlan = true; hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' });
  const input = { schema: 'improver-request-v1', operation: 'act', suggestionId: row.suggestion.id,
    input: { schema: 'routing-suggestion-action-v1', kind: 'apply', revision: row.revision, previewId: null, clientRequestId: 'stale_apply' } };
  expect(RoutingSuggestionRowSchema.parse(await improver.request(input, 'hub')).suggestion.status).toBe('recompute');
  const request = improver.revisions.recent()[0]!; await improver.revisions.wait(request.id);
  expect(improver.revisions.get(request.id).status).toBe('complete'); const recomputed = improver.suggestions.get(row.suggestion.id)!;
  expect(recomputed.suggestion).toMatchObject({ status: 'pending', draft: { before: 'The user changed this field.' } }); expect(recomputed.revision).toBe(row.revision + 2);
  expect(hub.configuration.current()?.revision).toBe(2); expect(hub.configuration.current()?.configuration['x-jevellan'].guards.pauseAfterPlan).toBe(true);
  expect(RoutingSuggestionRowSchema.parse(await improver.request(input, 'hub')).suggestion.status).toBe('recompute'); expect(drafts).toHaveLength(2);
});

test('a dismissed suggestion cannot be revived by a late revised draft', async () => {
  const row = await suggestion(); const original = generate; let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  generate = async (request, signal) => { await paused; return original(request, signal); };
  const started = await improver.revisions.request({ schema: 'routing-revision-request-v1', kind: 'instruction', instruction: 'Make it narrower.', clientRequestId: 'late', suggestionId: row.suggestion.id, revision: row.revision }, 'hub');
  improver.suggestions.act(row.suggestion.id, { schema: 'routing-suggestion-action-v1', kind: 'dismiss', reason: 'No longer useful.', clientRequestId: 'dismiss', revision: row.revision }, 'hub');
  resume(); await improver.revisions.wait(started.id).catch(() => undefined);
  expect(improver.revisions.get(started.id)).toMatchObject({ status: 'failed', preview: null }); expect(improver.suggestions.get(row.suggestion.id)?.suggestion.status).toBe('dismissed');
  expect(hub.configuration.current()?.revision).toBe(1); expect(active).toBe(0);
});

test('restart records an interrupted revision without relaunching it, while an explicit new request can retry', async () => {
  const row = await suggestion(); const input = { schema: 'routing-revision-request-v1' as const, kind: 'text' as const, after: 'A revised preference.', clientRequestId: 'restart', suggestionId: row.suggestion.id, revision: row.revision };
  const started = await improver.revisions.request(input, 'hub'); await improver.revisions.wait(started.id);
  const options = improver.options; await improver.close(); const saved = hub.get('routing-revision-requests', started.id, RoutingRevisionRecordSchema)!;
  hub.put('routing-revision-requests', started.id, RoutingRevisionRecordSchema, { ...saved.document, status: 'running', preview: null, finishedAt: null }, saved.revision);
  improver = new RoutingImprover(options); const recovered = await improver.revisions.request(input, 'hub');
  expect(recovered).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') }); expect(drafts).toHaveLength(1);
  const retry = await improver.revisions.request({ ...input, clientRequestId: 'explicit_retry' }, 'hub'); await improver.revisions.wait(retry.id); expect(improver.revisions.get(retry.id).status).toBe('complete');
});

test('the preview and completion receipt roll back together when saving the receipt fails', async () => {
  const row = await suggestion(); const original = hub.put.bind(hub);
  const put = vi.spyOn(hub, 'put').mockImplementation((namespace, id, schema, value, revision) => {
    if (namespace === 'routing-revision-requests' && (value as { status?: string }).status === 'complete') throw new Error('Fixture receipt failure.');
    return original(namespace, id, schema, value, revision);
  });
  const started = await improver.revisions.request({ schema: 'routing-revision-request-v1', kind: 'text', after: 'A checked alternative.', clientRequestId: 'atomic', suggestionId: row.suggestion.id, revision: row.revision }, 'hub');
  await improver.revisions.wait(started.id).catch(() => undefined); put.mockRestore();
  expect(improver.revisions.get(started.id)).toMatchObject({ status: 'failed', preview: null, error: 'Fixture receipt failure.' });
  expect(hub.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE namespace='routing-previews'").get()?.count).toBe(0); expect(hub.configuration.current()?.revision).toBe(1);
});

test('the public improver state omits job claim tokens', async () => {
  await suggestion(); const state = ImproverStateSchema.parse(await improver.request({ schema: 'improver-request-v1', operation: 'state' }, 'member'));
  expect(state.suggestions).toHaveLength(1); expect(state.jobs[0]?.status).toBe('complete'); expect(state.jobs[0]).not.toHaveProperty('token');
  expect(JSON.stringify(state)).not.toContain(improver.jobs.list()[0]!.token);
});

test('nightly polling starts once, records an empty-run log and never repeats the same night', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 8, 25, 3, 1)); improver.start(); improver.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(improver.jobs.list()).toHaveLength(1); const job = improver.jobs.list()[0]!; expect(job.status).toBe('complete');
    expect(improver.log(job.id)?.entries.map(entry => entry.stage)).toEqual(['started', 'complete']);
    const current = hub.configuration.current()!; current.configuration['x-jevellan'].improver.schedule.enabled = false;
    hub.configuration.put(current.configuration, current.revision, { deviceId: 'hub', source: 'ui' });
    vi.setSystemTime(new Date(2026, 8, 26, 3, 1)); await vi.advanceTimersByTimeAsync(60_000); expect(improver.jobs.list()).toHaveLength(1);
    await improver.close(); await vi.advanceTimersByTimeAsync(60_000); expect(active).toBe(0);
  } finally { vi.useRealTimers(); }
});
