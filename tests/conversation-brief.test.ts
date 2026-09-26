import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionSchema, GuardsSchema, Homes, HandoffSchema, StretchSchema, type Work } from '../packages/core/dist/index.js';
import { actionContract, actionPermissions, allowedActions, approximateTokens, buildBrief, changeUnderReview, checkGuards, ConversationLedger, ConversationWork } from '../packages/conversations/dist/index.js';

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
test('handoff numbering follows the conversation across closed works and survives trimming', () => {
  expect(buildBrief(store.load(), ledger, options).text).toContain('Stretch: 1.');
  plan(); store.close('cancelled'); store.message('Review the existing files.', 'new-work');
  const result = buildBrief(store.load(), ledger, { ...options, action: 'review', tokenCap: 1 });
  expect(result.text).toContain('Stretch: 2. Use this exact stretch number in jevellan_handoff.');
  expect(result.text).not.toContain('Stretch: 1.');
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

const fileDiff = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`).join('\n')}\n`;
test('review briefs carry the change under review with its files, stat and diff', () => {
  const change = { description: "Diff from the work's base commit 0123456789ab to HEAD ba9876543210.", diff: fileDiff('src/sum.ts', 2) + fileDiff('src/sum.test.ts', 1), files: ['src/sum.ts', 'src/sum.test.ts'] };
  const text = buildBrief(store.load(), ledger, { ...options, action: 'review', memoryWrite: false, change }).text;
  const section = text.split('# Change under review\n\n')[1]!.split('\n\n# Memory')[0]!;
  expect(section).toContain("Diff from the work's base commit 0123456789ab to HEAD ba9876543210.");
  expect(section).toContain('2 files changed, 3 insertions(+), 0 deletions(-).');
  expect(section).toContain('- src/sum.ts\n- src/sum.test.ts'); expect(section).toContain('+line 1 of src/sum.ts'); expect(section).not.toContain('Left out');
  expect(buildBrief(store.load(), ledger, { ...options, action: 'review', memoryWrite: false }).text).not.toContain('# Change under review');
});
test('a large change keeps whole files within its share of the budget and names what it left out', () => {
  const ref = plan(); store.approvePlan(ref, store.load().conversation.generation);
  const change = { description: 'Diff fixture.', diff: fileDiff('small.ts', 5) + fileDiff('huge.ts', 3000) + fileDiff('tail.ts', 5), files: [] };
  const result = buildBrief(store.load(), ledger, { ...options, action: 'review', memoryWrite: false, change, tokenCap: 3000 });
  expect(result.text).toContain('+line 4 of small.ts'); expect(result.text).toContain('+line 4 of tail.ts'); expect(result.text).not.toContain('+line 2999 of huge.ts');
  expect(result.text).toContain('Left out of this brief to keep it within its size: huge.ts.'); expect(result.text).toContain('Read the left-out parts with your read tools');
  expect(result.text).toContain('- huge.ts'); expect(result.text).toContain('3 files changed, 3010 insertions(+)');
  expect(result.text).toContain('Original request: support negative numbers.'); expect(result.text).toContain('3. Run final verification.'); expect(result.text).toContain('constraint: preserve public types');
  expect(result.overBudget).toBe(false);
  const only = buildBrief(store.load(), ledger, { ...options, action: 'review', memoryWrite: false, change: { ...change, diff: fileDiff('huge.ts', 3000) }, tokenCap: 3000 });
  expect(only.text).toContain('The diff of huge.ts was cut to fit this brief.'); expect(only.text).toContain('+line 0 of huge.ts'); expect(only.overBudget).toBe(false);
});
test('the change is computed from the base commit, or from the uncommitted change when there is none (external projects)', async () => {
  const repo = join(root, 'repo'); mkdirSync(repo); const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n'); git('commit', '-qam', 'change');
  const workspace = {
    head: async () => git('rev-parse', 'HEAD'), clean: async () => git('status', '--porcelain') === '',
    diff: async (from: string, to?: string) => execFileSync('git', ['diff', from, ...(to ? [to] : []), '--'], { cwd: repo, encoding: 'utf8' }),
    uncommittedDiff: async () => execFileSync('git', ['diff', 'HEAD', '--'], { cwd: repo, encoding: 'utf8' }) + (git('ls-files', '--others', '--exclude-standard') ? 'diff --git a/new.ts b/new.ts\n+untracked\n' : ''),
    changedFiles: async (from?: string, to?: string) => [...git('diff', '--name-only', from ?? 'HEAD', ...(to ? [to] : [])).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean),
  };
  const committed = await changeUnderReview(workspace, base);
  expect(committed.description).toContain(`base commit ${base.slice(0, 12)}`); expect(committed.files).toEqual(['a.ts']); expect(committed.diff).toContain('+export const a = 2;');
  writeFileSync(join(repo, 'new.ts'), 'untracked\n');
  const external = await changeUnderReview(workspace, undefined);
  expect(external.description).toContain('no base commit'); expect(external.files).toEqual(['new.ts']); expect(external.diff).toContain('new.ts');
  expect(git('status', '--porcelain')).toBe('?? new.ts');
});
