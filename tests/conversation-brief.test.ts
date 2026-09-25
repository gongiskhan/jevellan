import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionSchema, GuardsSchema, Homes, HandoffSchema, StretchSchema, type Work } from '../packages/core/dist/index.js';
import { actionContract, actionPermissions, allowedActions, approximateTokens, buildBrief, checkGuards, ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';

let root: string; let ledger: ConversationLedger; let store: ConversationWork;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-brief-')); mkdirSync(join(root, 'user'));
  ledger = new ConversationLedger(new Homes(join(root, 'data'), join(root, 'user')), 'conversation'); store = new ConversationWork(ledger);
  store.create({ title: 'Fixture', projectId: 'project', ownerDeviceId: 'device' }); store.message('Original request: support negative numbers.', 'initial');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = { action: 'implement' as const, project: { name: 'Fixture', branchPolicy: 'main' as const }, cwd: '/fixture', memoryWrite: true };
function plan() {
  const view = store.load();
  store.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action: 'plan', modelId: 'model', runtime: 'codex', model: 'model', effortRequested: 'high', effortEffective: 'high', accountId: 'account', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
  const result = ledger.putBlob('# Whole plan\n1. Change the parser.\n2. Add negative-number tests.\n3. Run final verification.');
  ledger.acceptHandoff(HandoffSchema.parse({ schema: 'handoff-v2', stretch: 1, action: 'plan', status: 'partial', summary: 'Plan attached; tests remain.', result: { type: 'plan', ref: result.ref }, evidence: [{ kind: 'command', ref: 'ledger/4', note: 'Reproduction' }], findings: [{ claim: 'constraint: preserve public types', pointer: 'src/parser.ts:1' }], blockers: ['Need all existing examples'], failedApproaches: ['Changing the public type broke clients'], proposedNext: 'implement', changedFiles: [] }));
  store.finish(1, { status: 'completed', usage: { inputTokens: 10, outputTokens: 20, costSource: 'unknown' } }, false);
  return result.ref;
}
test('Garrison brief regression: exact objective, full plan, remaining work, evidence and failed approaches survive', () => {
  const ref = plan(); store.approvePlan(ref, store.load().conversation.generation); store.message('Keep 390 px usable.', 'followup');
  const result = buildBrief(store.load(), ledger, options);
  for (const expected of ['Original request: support negative numbers.', 'Keep 390 px usable.', '(approved)', '# Whole plan', '3. Run final verification.', 'constraint: preserve public types', 'Need all existing examples', 'Changing the public type broke clients', 'ledger/4', 'Project: Fixture at /fixture. Branch policy: main.']) expect(result.text).toContain(expected);
  expect(result.overBudget).toBe(false);
});
test('budget trimming preserves mandatory context and replaces middle messages with readable pointers', () => {
  plan(); store.message('First followup', 'first'); const middle = store.message('Disposable middle context '.repeat(2000), 'middle'); store.message('Latest followup', 'latest');
  const result = buildBrief(store.load(), ledger, { ...options, tokenCap: 900 });
  expect(result.text).toContain('# Whole plan'); expect(result.text).toContain('Original request'); expect(result.text).toContain('constraint: preserve public types');
  expect(result.text).toContain('First followup'); expect(result.text).toContain('Latest followup'); expect(result.text).toContain(`ledger/${middle.eventId}`);
  expect(result.omitted[0]).toBe('handoffs/1'); expect(result.omitted).toContain(`ledger/${middle.eventId}`); expect(result.text).not.toContain('Disposable middle context');
  expect(ledger.read(`ledger/${middle.eventId}`)).toMatchObject({ data: { text: 'Disposable middle context '.repeat(2000) } });
});
test('mandatory context above the approximate budget is reported, never silently truncated', () => {
  store.close('done'); const request = 'Exact long request '.repeat(4000); store.message(request, 'large');
  const result = buildBrief(store.load(), ledger, { ...options, tokenCap: 500 });
  expect(result.text).toContain(request); expect(result.overBudget).toBe(true);
});
test('memory excerpt budget, unresolved labels and read-only permission wording are preserved', () => {
  const result = buildBrief(store.load(), ledger, { ...options, memoryWrite: false, memory: [{ title: 'Conflict', permalink: 'notes/conflict', excerpt: 'é'.repeat(10000), unresolved: true }] });
  const memory = result.text.split('# Memory\n\n')[1]!.split('\n\nUse the memory tools')[0]!;
  expect(approximateTokens(memory)).toBeLessThanOrEqual(2000); expect(memory).toContain('(conflicting versions, unresolved)'); expect(memory).toContain('notes/conflict');
  expect(result.text).toContain('propose it with memory_propose'); expect(result.text).not.toContain('Record anything');
});
test('action contracts remain under 200 words and keep read-only work separate from writing', () => {
  for (const action of ActionSchema.options.filter((value) => !['done', 'ask-you'].includes(value))) {
    expect(actionContract(action).split(/\s+/).length).toBeLessThan(200);
    expect(actionContract(action)).toContain('Do not stop, restart, update or redeploy Jevellan.');
    expect(actionPermissions(action)).toBe(['implement', 'test', 'integrate'].includes(action) ? 'write' : 'read-only');
  }
  expect(actionContract('plan')).toContain('Do not create or edit a plan file'); expect(actionContract('test')).toContain('Do not edit application code');
  expect(() => actionContract('done')).toThrow();
});
test('allowed actions honor review budget, first decision and absent tests without treating a cap as success', () => {
  const guards = GuardsSchema.parse({}); const work = store.load().conversation.work!; work.counters.reviews = 2;
  const allowed = allowedActions(work, guards, false, 0);
  for (const forbidden of ['done', 'review', 'adversarial-review', 'test', 'integrate']) expect(allowed).not.toContain(forbidden);
  expect(allowed).toContain('implement'); expect(allowed).toContain('ask-you');
  expect(allowedActions(work, guards, true, 1)).toContain('done'); expect(work.closedAt).toBeUndefined();
});
test.each([
  [{ stretches: 24 }, 'steps'], [{ noProgress: 2 }, 'no-progress'], [{ testFailures: 3 }, 'test-failures'], [{ costUsd: 5, unknownCostStretches: 2 }, 'cost'],
] as const)('guard stops on observed counters %j', (counters, kind) => {
  const work = store.load().conversation.work!; Object.assign(work.counters, counters);
  const stop = checkGuards(work, GuardsSchema.parse({ workCostCapUsd: 5 })); expect(stop?.kind).toBe(kind);
  if (kind === 'cost') expect(stop?.notice).toContain('plus 2 steps with unknown cost');
});
test('unknown costs alone are not treated as exhaustion; an allowance extends only the step budget', () => {
  const work = store.load().conversation.work! as Work; work.counters.unknownCostStretches = 5;
  const guards = GuardsSchema.parse({ workCostCapUsd: 5 }); expect(checkGuards(work, guards)).toBeNull();
  work.counters.stretches = 24; work.allowance.stretches = 48; expect(checkGuards(work, guards)).toBeNull();
  work.counters.costUsd = 5; expect(checkGuards(work, guards)?.kind).toBe('cost');
});
