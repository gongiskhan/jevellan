import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountSchema, AccountStatusSchema, Homes, LifecycleGate, OverrideRecordSchema, SecretRedactor, parseConfiguration, seedConfiguration } from '../packages/core/dist/index.js';
import { BackgroundDrafts, StretchBridges } from '../packages/conversations/dist/index.js';
import { FakeRuntime, groupAlive } from '../packages/runtime-contract/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { parseJevResponse, type DecisionClient } from '../packages/decisions/dist/index.js';
import { RoutingImprover } from '../apps/daemon/dist/routing-improver.js';

test('a routing job uses the private native draft, scoped handoff and saved-case evaluator before any settings Apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-routing-draft-integration-')); mkdirSync(join(root, 'user'));
  const homes = new Homes(join(root, 'home'), join(root, 'user')); const hub = new HubDatabase(homes, 'hub');
  const gate = new LifecycleGate(homes); const redactor = new SecretRedactor(); const bridges = new StretchBridges(redactor); const runtime = new FakeRuntime(); runtime.capabilities.readOnlyEnforced = true;
  const configuration = seedConfiguration(); configuration['x-jevellan'].runtimes.fake = { enabled: true };
  configuration['x-jevellan'].menu.push({ id: 'fixture_model', runtime: 'fake', model: 'fixture-model', label: 'Fixture', enabled: true, description: 'Simulated draft producer.', efforts: ['high'] });
  hub.configuration.put(configuration, 0, { deviceId: 'hub', source: 'install' });
  const account = AccountSchema.parse({ schema: 'account-v1', id: 'fixture_account', runtime: 'fake', kind: 'subscription', credential: 'per-device', label: 'Fixture account', enabled: true });
  const status = () => AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: account.id, deviceId: 'hub', auth: 'ready', observedAt: new Date().toISOString() });
  const enterOperation = (id: string, title: string) => gate.enter({ kind: 'settings', id, title });
  const drafts = new BackgroundDrafts({ homes, deviceId: 'hub', bridges, redactor, runtimes: new Map([['fake', runtime]]), settings: () => hub.configuration.current()!.configuration['x-jevellan'], riggingItems: () => [], accountRuns: new Set(), enterOperation,
    accounts: { async list() { return [{ schema: 'account-view-v1' as const, revision: 1, account, statuses: [status()] }]; }, async resolve() { return { account, home: homes.account('fake', account.id), env: {} }; }, async markUsed() {}, async recordUsage(_id, usage) { return AccountStatusSchema.parse({ ...status(), usage }); }, async recordError() { return status(); } } });
  drafts.daemonUrl = 'http://127.0.0.1:9999';
  const client: DecisionClient = { async decide(input) {
    const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'consistent_preference' ? 0.9 : 0 }];
      if (question.type !== 'choice') throw new Error('Unexpected fixture question.');
      const choice = Object.keys(question.criteria)[0]!;
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
    }));
    return parseJevResponse(JSON.stringify({ model: 'simulated-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } }), input.questions);
  } };
  const improver = new RoutingImprover({ hub, deviceId: 'hub', ready: drafts.ready, client: () => client, draft: (request, signal) => drafts.run(request, signal), enterOperation, evidence: 'simulated' });
  try {
    for (const n of [1, 2, 3]) {
      const id = `override_${n}`;
      hub.put('overrides', id, OverrideRecordSchema, { schema: 'override-v1', id, request: { schema: 'correct-step-v1', clientRequestId: `request_${n}`, generation: 0, stretch: 1, mode: 'noted', choices: { modelId: 'codex-gpt' } },
        conversationId: 'conversation', workId: 'work', projectId: 'project', decisionId: `decision_${n}`, at: new Date().toISOString(), action: 'implement', context: 'A specified backend implementation.', changes: [{ field: 'model', from: 'claude-fable', to: 'codex-gpt' }] }, 0);
    }
    runtime.enqueue(async ({ input }) => {
      expect(gate.tryMaintenance()).toBeNull(); expect(input.permissions).toBe('read-only'); expect(input.inputCopy).toBe(true);
      const copied = parseConfiguration(readFileSync(join(input.cwd, 'apm.yml'), 'utf8'));
      const corrections = JSON.parse(readFileSync(join(input.cwd, 'corrections.json'), 'utf8'));
      await bridges.request(input.launch.env.JEVELLAN_STRETCH_TOKEN, { schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: {
        schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'A simulated draft is ready.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [],
        result: { type: 'suggestion', content: { schema: 'routing-draft-v1', title: 'Prefer GPT for specified implementations', reason: 'Three explicit corrections.', field: { kind: 'routing-profile' },
          before: copied['x-jevellan'].routingProfile, after: 'Prefer GPT for well-specified backend implementations.', evidenceOverrideIds: corrections.overrides.map((value: { id: string }) => value.id) } },
      } });
      return { status: 'completed' };
    });
    const job = await improver.run({ kind: 'manual', id: 'run' }); await improver.wait(job.id);
    const row = improver.suggestions.visible()[0]!;
    expect(row.suggestion).toMatchObject({ status: 'pending', comparison: { evidence: 'simulated' } }); expect(row.suggestion.comparison.cases).toHaveLength(24);
    expect(hub.configuration.current()?.revision).toBe(1); expect(runtime.starts).toHaveLength(1); expect(runtime.runs.every(run => !groupAlive(run.native.pgid))).toBe(true);
    const maintenance = gate.tryMaintenance(); expect(maintenance).not.toBeNull(); maintenance!();
    const applied = improver.suggestions.act(row.suggestion.id, { schema: 'routing-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply', revision: row.revision, previewId: null }, 'hub');
    expect(applied.suggestion.status).toBe('applied'); expect(hub.configuration.current()).toMatchObject({ revision: 2, configuration: { 'x-jevellan': { routingProfile: 'Prefer GPT for well-specified backend implementations.' } } });
  } finally { await improver.close(); await drafts.close(); await runtime.close(); await bridges.close(); gate.close(); hub.close(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
