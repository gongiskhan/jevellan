import { expect, test } from 'vitest';
import { OverrideRecordSchema, ComposerOverrideRecordSchema, seedConfiguration, type OverrideRecord, type RoutingDraft, type RoutingGroup } from '../packages/core/dist/index.js';
import { applyRoutingField, judgeRoutingGroup, routingFieldText, routingGroups, validateRoutingDraft, type DecisionClient } from '../packages/decisions/dist/index.js';

const now = Date.parse('2026-09-25T12:00:00Z');
function correction(id: string, options: Partial<OverrideRecord> = {}): OverrideRecord {
  return OverrideRecordSchema.parse({ schema: 'override-v1', id, conversationId: 'conversation', workId: 'work', projectId: 'project', decisionId: `decision_${id}`,
    request: { schema: 'correct-step-v1', clientRequestId: `request_${id}`, generation: 0, stretch: 2, mode: 'noted', choices: { modelId: 'codex-gpt' } },
    at: new Date(now - 1000).toISOString(), action: 'implement', context: 'A well specified implementation.', changes: [{ field: 'model', from: 'claude-fable', to: 'codex-gpt' }], ...options });
}
function redo(id: string) { const value = correction(id); value.request.mode = 'redo'; return value; }
function group(): RoutingGroup { return routingGroups([correction('one'), correction('two'), correction('three')], now)[0]!; }
function draft(): RoutingDraft { return { schema: 'routing-draft-v1', title: 'Prefer GPT for specified implementations', reason: 'Three consistent corrections.', field: { kind: 'routing-profile' }, before: seedConfiguration()['x-jevellan'].routingProfile, after: 'Prefer GPT for long, well-specified implementation.', evidenceOverrideIds: ['one', 'two', 'three'] }; }

test('corrections group by action and exact field change with redo weight and no duplicate counting', () => {
  const one = redo('one'); const two = correction('two');
  const reviews = ['r1', 'r2', 'r3'].map(id => correction(id, { action: 'review' }));
  const tooFew = correction('effort', { changes: [{ field: 'effort', from: 'medium', to: 'high' }] });
  const records = [one, one, two, ...reviews, tooFew]; const groups = routingGroups(records, now);
  expect(groups).toHaveLength(2); expect(groups.map(value => value.weight)).toEqual([3, 3]);
  expect(groups.map(value => value.key)).toEqual(expect.arrayContaining([
    { field: 'model', action: 'implement', from: 'claude-fable', to: 'codex-gpt' }, { field: 'model', action: 'review', from: 'claude-fable', to: 'codex-gpt' },
  ]));
  expect(routingGroups([...records].reverse(), now)).toEqual(groups);
  expect(groups.find(value => 'action' in value.key && value.key.action === 'implement')?.overrides).toHaveLength(2);
  expect(() => routingGroups([one, { ...one, context: 'Different evidence under the same ID.' }], now)).toThrow('conflicting records');
});

test('the fourteen-day boundary is inclusive, future and older records are ignored, and action groups do not split by recorded action', () => {
  const change = { field: 'action' as const, from: 'plan' as const, to: 'implement' as const };
  const boundary = correction('boundary', { at: new Date(now - 14 * 86400_000).toISOString(), changes: [change] });
  const other = redo('other'); other.action = 'reply'; other.changes = [change];
  const old = correction('old', { at: new Date(now - 14 * 86400_000 - 1).toISOString() });
  const future = redo('future'); future.at = new Date(now + 1).toISOString();
  const groups = routingGroups([boundary, other, old, future], now);
  expect(groups).toHaveLength(1); expect(groups[0]?.key).toEqual(change); expect(groups[0]?.overrides.map(value => value.id)).toEqual(['boundary', 'other']);
});

test('only applied composer choices contribute; their compact evidence contains no message or request payload', () => {
  const applied = (id: string) => ComposerOverrideRecordSchema.parse({ schema: 'composer-override-v1', id,
    request: { schema: 'composer-choice-v1', clientRequestId: `request_${id}`, generation: 0, field: 'model', mode: 'once', value: 'codex-gpt' },
    conversationId: 'conversation', projectId: 'project', workId: 'work', decisionId: `decision_${id}`, stretch: 1,
    at: new Date(now - 1000).toISOString(), appliedAt: new Date(now - 500).toISOString(), status: 'applied', action: 'implement', context: `One line\n${'x'.repeat(500)}`,
    changes: [{ field: 'model', from: null, to: 'codex-gpt' }] });
  const pending = { ...applied('pending'), status: 'pending' as const, decisionId: null, stretch: null }; delete pending.appliedAt;
  expect(routingGroups([applied('one'), applied('two'), pending], now)).toEqual([]);
  const groups = routingGroups([applied('one'), applied('two'), applied('three'), pending], now);
  expect(groups[0]?.overrides).toHaveLength(3);
  expect(groups[0]?.overrides[0]?.context).toHaveLength(400);
  expect(JSON.stringify(groups)).not.toContain('clientRequestId'); expect(groups[0]?.overrides[0]?.context).not.toContain('\n');
});

test('a dismissed group needs three distinct new corrections, even when two redos already weigh four', () => {
  const original = group(); const old = ['one', 'two', 'three'].map(id => correction(id));
  const suppression = { schema: 'routing-suppression-v1' as const, groupId: original.id, overrideIds: old.map(value => value.id) };
  expect(routingGroups([...old, redo('four'), redo('five')], now, [suppression])).toEqual([]);
  expect(routingGroups([...old, redo('four'), redo('five'), correction('six')], now, [suppression])).toHaveLength(1);
});

test('Jev receives one preference question with compact group evidence and its exact probability is recorded', async () => {
  const controller = new AbortController(); const input = group();
  const client: DecisionClient = { async decide(request, signal) {
    expect(signal).toBe(controller.signal); expect(Object.keys(request.questions)).toEqual(['consistent_preference']);
    expect(JSON.parse(request.state)).toEqual(input);
    return { schema: 'jev-response-v1', model: 'jev-test', answers: { consistent_preference: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  } };
  expect(await judgeRoutingGroup(client, input, 'jev-requested', controller.signal)).toMatchObject({ groupId: input.id, probability: 0.7, requestedModel: 'jev-requested', returnedModel: 'jev-test' });
  controller.abort(); await expect(judgeRoutingGroup(client, input, 'jev-requested', controller.signal)).rejects.toThrow('cancelled');
});

test.each([
  { kind: 'routing-profile' as const }, { kind: 'menu-description' as const, modelId: 'claude-fable' }, { kind: 'effort-guide' as const, effort: 'high' as const },
])('apply and undo only one field while keeping unrelated edits: $kind', field => {
  const original = seedConfiguration(); const before = routingFieldText(original, field); const after = 'A precise revised guideline.';
  const changed = applyRoutingField(original, field, before, after);
  expect(routingFieldText(original, field)).toBe(before); expect(routingFieldText(changed, field)).toBe(after);
  changed['x-jevellan'].guards.pauseAfterPlan = true;
  const undone = applyRoutingField(changed, field, after, before);
  expect(undone).toEqual({ ...original, 'x-jevellan': { ...original['x-jevellan'], guards: { ...original['x-jevellan'].guards, pauseAfterPlan: true } } });
  expect(() => applyRoutingField(changed, field, before, 'Overwrite')).toThrow('Recompute');
  expect(() => applyRoutingField(changed, field, after, '')).toThrow();
});

test('draft validation refuses fabricated citations, no change, stale before text and removed menu entries', () => {
  const configuration = seedConfiguration(); expect(validateRoutingDraft(draft(), configuration, group())).toEqual(draft());
  expect(() => validateRoutingDraft({ ...draft(), evidenceOverrideIds: ['invented'] }, configuration, group())).toThrow('unknown correction');
  expect(() => validateRoutingDraft({ ...draft(), after: draft().before }, configuration, group())).toThrow('must change');
  expect(() => validateRoutingDraft({ ...draft(), before: 'Old text' }, configuration, group())).toThrow('Recompute');
  expect(() => validateRoutingDraft({ ...draft(), field: { kind: 'menu-description', modelId: 'removed' } }, configuration, group())).toThrow('no longer in the menu');
});
