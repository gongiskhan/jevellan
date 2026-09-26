import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountSchema, Homes, ImproverJobViewSchema, ImproverStateSchema, OverrideRecordSchema, RoutingRevisionRecordSchema, RoutingSuggestionRowSchema, groupAlive, parseConfiguration } from '../packages/core/dist/index.js';
import type { JevQuestions } from '../packages/decisions/dist/index.js';
import { FakeRuntime, type StretchInput } from '../packages/runtime-contract/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let runtime: FakeRuntime; let server: Server; let base: string; let cookie: string;
const questions: string[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-improver-api-')); mkdirSync(join(root, 'user')); runtime = new FakeRuntime(); runtime.capabilities.readOnlyEnforced = true; questions.length = 0;
  app = new Application({ homes: new Homes(join(root, 'home'), join(root, 'user')), timers: false, runtimes: () => new Map([['fake', runtime]]),
    decisionFetch: async (_url, init) => {
      const input = JSON.parse(String(init!.body)) as { questions: JevQuestions };
      return Response.json({ model: 'simulated-jev', usage: { input_tokens: 10, output_tokens: 2 }, answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
        questions.push(id);
        if (question.type === 'noul') return [id, { type: 'noul', noul: id === 'consistent_preference' ? 0.9 : 0 }];
        if (question.type !== 'choice') throw new Error('Unexpected fixture question.');
        const choice = Object.keys(question.criteria)[0]!;
        return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
      })) });
    } });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) });
  expect(login.status).toBe(200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const configuration = app.hub.configuration.current()!; configuration.configuration['x-jevellan'].runtimes.fake = { enabled: true };
  configuration.configuration['x-jevellan'].menu.push({ id: 'fixture', runtime: 'fake', model: 'scripted-model', label: 'Fixture', description: 'Simulated provider.', efforts: ['high'], enabled: true });
  app.hub.configuration.put(configuration.configuration, configuration.revision, { deviceId: app.device.deviceId, source: 'ui' });
  app.hub.vault.put('jev', `fixture-${randomUUID()}`);
  app.hub.put('accounts', 'fixture_account', AccountSchema, AccountSchema.parse({ schema: 'account-v1', id: 'fixture_account', runtime: 'fake', label: 'Fixture', kind: 'subscription', credential: 'per-device', enabled: true }), 0);
  await app.accounts.check('fixture_account');
});
afterEach(async () => { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); rmSync(root, { recursive: true, force: true }); });
async function request(input?: unknown) {
  const response = await fetch(`${base}/api/improver`, { method: input ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: base, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
}
function corrections() {
  for (const n of [1, 2, 3]) app.hub.put('overrides', `override_${n}`, OverrideRecordSchema, { schema: 'override-v1', id: `override_${n}`,
    request: { schema: 'correct-step-v1', clientRequestId: `correction_${n}`, generation: 0, stretch: 1, mode: 'noted', choices: { modelId: 'codex-gpt' } },
    conversationId: 'conversation', workId: 'work', projectId: 'project', decisionId: `decision_${n}`, at: new Date().toISOString(), action: 'implement', context: 'A specified backend change.', changes: [{ field: 'model', from: 'claude-fable', to: 'codex-gpt' }] }, 0);
}
async function draft(input: StretchInput, after: string) {
  expect(input.permissions).toBe('read-only'); expect(input.inputCopy).toBe(true); expect(input.launch.env.JEVELLAN_DAEMON_URL).toBe(base);
  expect(app.lifecycle.tryMaintenance()).toBeNull();
  const configuration = parseConfiguration(readFileSync(join(input.cwd, 'apm.yml'), 'utf8'));
  const response = await fetch(`${input.launch.env.JEVELLAN_DAEMON_URL}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.launch.env.JEVELLAN_STRETCH_TOKEN}` },
    body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_handoff', arguments: { schema: 'handoff-v2', stretch: 1, action: 'reply', status: 'done', summary: 'A simulated suggestion.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [],
      result: { type: 'suggestion', content: { schema: 'routing-draft-v1', title: 'Prefer GPT for backend changes', reason: 'Three explicit corrections.', field: { kind: 'routing-profile' }, before: configuration['x-jevellan'].routingProfile, after, evidenceOverrideIds: ['override_1', 'override_2', 'override_3'] } } } }) });
  expect(response.status).toBe(200); return { status: 'completed' as const };
}

test('normal application HTTP runs the judge, private draft and checks; Change it, Apply and Undo retain durable receipts', async () => {
  corrections(); runtime.enqueue(({ input }) => draft(input, 'Prefer GPT for specified backend changes.'));
  const run = { schema: 'improver-request-v1', operation: 'run', clientRequestId: 'run' }; const job = ImproverJobViewSchema.parse(await request(run));
  await app.routingImprover!.wait(job.id); expect(ImproverJobViewSchema.parse(await request(run)).id).toBe(job.id);
  const state = ImproverStateSchema.parse(await request()); const row = state.suggestions[0]!;
  expect(row.suggestion.comparison.cases).toHaveLength(24); expect(row.suggestion.comparison.evidence).toBe('simulated'); expect(questions.filter(id => id === 'consistent_preference')).toHaveLength(1);
  expect(runtime.starts).toHaveLength(1); expect(app.hub.configuration.current()?.revision).toBe(2); expect(state.jobs[0]).not.toHaveProperty('token');
  runtime.enqueue(({ input }) => { expect(readFileSync(join(input.cwd, 'instruction.txt'), 'utf8')).toBe('Only small backend fixes.'); return draft(input, 'Prefer GPT only for small backend fixes.'); });
  const revise = { schema: 'improver-request-v1', operation: 'revise', input: { schema: 'routing-revision-request-v1', kind: 'instruction', clientRequestId: 'revise', suggestionId: row.suggestion.id, revision: row.revision, instruction: 'Only small backend fixes.' } };
  const started = RoutingRevisionRecordSchema.parse(await request(revise)); await app.routingImprover!.revisions.wait(started.id);
  const preview = RoutingRevisionRecordSchema.parse(await request(revise)); expect(preview.status).toBe('complete'); expect(runtime.starts).toHaveLength(2); expect(app.hub.configuration.current()?.revision).toBe(2);
  const action = { schema: 'improver-request-v1', operation: 'act', suggestionId: row.suggestion.id, input: { schema: 'routing-suggestion-action-v1', kind: 'apply', clientRequestId: 'apply', revision: row.revision, previewId: preview.preview!.id } };
  const applied = RoutingSuggestionRowSchema.parse(await request(action)); expect(applied.suggestion.status).toBe('applied'); expect(app.hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe('Prefer GPT only for small backend fixes.');
  expect(await request(action)).toEqual(applied); expect(app.hub.configuration.current()?.revision).toBe(3);
  const undone = RoutingSuggestionRowSchema.parse(await request({ ...action, input: { schema: 'routing-suggestion-action-v1', kind: 'undo', clientRequestId: 'undo', revision: applied.revision } }));
  expect(undone.suggestion.status).toBe('undone'); expect(app.hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(row.suggestion.draft.before);
  expect(runtime.runs.every(run => !groupAlive(run.native.pgid))).toBe(true); const maintenance = app.lifecycle.tryMaintenance(); expect(maintenance).not.toBeNull(); maintenance!();
}, 60_000);

test('improver endpoints require a signed-in UI and reject malformed requests before starting work', async () => {
  expect((await fetch(`${base}/api/improver`)).status).toBe(401);
  const malformed = await fetch(`${base}/api/improver`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'improver-request-v1', operation: 'run' }) });
  expect(malformed.status).toBe(400); expect(app.routingImprover!.jobs.list()).toEqual([]); expect(runtime.starts).toEqual([]);
});
