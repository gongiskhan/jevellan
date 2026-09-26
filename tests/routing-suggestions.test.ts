import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionComparisonSchema, Homes, RoutingGroupSchema, applyRoutingField, configurationDigest, seedConfiguration,
  type RoutingDraft, type RoutingGroup, type RoutingSuggestionRow,
} from '../packages/core/dist/index.js';
import { HubDatabase, RoutingSuggestions } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase; let store: RoutingSuggestions; let now: number;
const cases = { digest: 'a'.repeat(64), ids: ['first_case', 'second_case'] };
const author = { deviceId: 'hub', source: 'ui' as const };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-routing-suggestions-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'home'), join(root, 'user')); hub = new HubDatabase(homes, 'hub'); now = Date.parse('2026-09-25T12:00:00Z');
  store = new RoutingSuggestions(hub, cases, () => now); hub.configuration.put(seedConfiguration(), 0, author);
});
afterEach(() => { hub.close(); rmSync(root, { recursive: true, force: true }); });

function group(id = 'group_one', ids = ['one', 'two', 'three']): RoutingGroup {
  return RoutingGroupSchema.parse({ schema: 'routing-group-v1', id, key: { field: 'model', action: 'implement', from: 'claude-fable', to: 'codex-gpt' }, weight: ids.length,
    overrides: ids.map(id => ({ id, at: new Date(now).toISOString(), conversationId: 'conversation', projectId: 'project', workId: 'work', decisionId: `decision_${id}`, stretch: 1, context: 'A specified implementation.', mode: 'noted' })) });
}
function checked(after = 'Prefer GPT for long specified implementations.', field: RoutingDraft['field'] = { kind: 'routing-profile' }) {
  const snapshot = hub.configuration.current()!;
  const settings = snapshot.configuration['x-jevellan'];
  const before = field.kind === 'routing-profile' ? settings.routingProfile : field.kind === 'effort-guide' ? settings.effortGuide[field.effort] : settings.menu.find(value => value.id === field.modelId)!.description;
  const draft: RoutingDraft = { schema: 'routing-draft-v1', title: 'Prefer GPT for specified work', reason: 'Three corrections express this preference.', field, before, after, evidenceOverrideIds: ['one', 'two', 'three'] };
  const comparison = DecisionComparisonSchema.parse({ schema: 'decision-comparison-v1', evidence: 'simulated', at: new Date(now).toISOString(),
    beforeConfiguration: configurationDigest(snapshot.configuration), afterConfiguration: configurationDigest(applyRoutingField(snapshot.configuration, field, before, after)), caseSet: cases.digest,
    unchanged: 2, better: 0, worse: 0, cases: cases.ids.map(caseId => {
      const result = { schema: 'decision-evaluation-v1', caseId, title: 'Fixture case', choice: { action: 'implement', modelId: 'codex-gpt', effort: 'high' }, acceptable: true, failedFields: [], calls: [] };
      return { before: result, after: result, change: 'unchanged' };
    }) });
  return { draft, comparison, configurationRevision: snapshot.revision };
}
function enqueue(id = 'suggestion', overrides = group()) {
  return store.enqueue({ id, jobId: 'job', group: overrides, preference: { schema: 'routing-preference-v1', groupId: overrides.id, probability: 0.7, requestedModel: 'jev', returnedModel: 'simulated-jev' }, ...checked() });
}
function apply(row: RoutingSuggestionRow, clientRequestId = 'apply', previewId: string | null = null) {
  return store.act(row.suggestion.id, { schema: 'routing-suggestion-action-v1', kind: 'apply', clientRequestId, revision: row.revision, previewId }, 'hub');
}
function edit(update: (settings: ReturnType<typeof seedConfiguration>['x-jevellan']) => void) {
  const current = hub.configuration.current()!; update(current.configuration['x-jevellan']); return hub.configuration.put(current.configuration, current.revision, author);
}

test('Apply and timed Undo each change one field and retain unrelated configuration edits', () => {
  const row = enqueue(); const original = row.suggestion.draft.before;
  edit(settings => { settings.guards.pauseAfterPlan = true; }); const applied = apply(row);
  expect(hub.configuration.current()).toMatchObject({ revision: 3, changedBy: { source: 'improver' }, configuration: { 'x-jevellan': { routingProfile: row.suggestion.draft.after, guards: { pauseAfterPlan: true } } } });
  edit(settings => { settings.effortGuide.low = 'Preserve this later unrelated edit.'; }); now += 29_999;
  const undone = store.act('suggestion', { schema: 'routing-suggestion-action-v1', kind: 'undo', clientRequestId: 'undo', revision: applied.revision }, 'hub');
  expect(undone.suggestion.status).toBe('undone'); expect(undone.suggestion.outcomes.map(value => value.kind)).toEqual(['applied', 'undone']);
  expect(hub.configuration.current()).toMatchObject({ revision: 5, configuration: { 'x-jevellan': { routingProfile: original, guards: { pauseAfterPlan: true }, effortGuide: { low: 'Preserve this later unrelated edit.' } } } });
});

test('lost Apply replies survive restart and later Undo without replaying a configuration write', () => {
  const row = enqueue(); const applied = apply(row); const request = { schema: 'routing-suggestion-action-v1' as const, kind: 'undo' as const, clientRequestId: 'undo', revision: applied.revision };
  const undone = store.act('suggestion', request, 'hub'); const revision = hub.configuration.current()!.revision;
  hub.close(); hub = new HubDatabase(homes, 'hub'); store = new RoutingSuggestions(hub, cases, () => now);
  expect(apply(row)).toEqual(applied); expect(store.act('suggestion', request, 'hub')).toEqual(undone);
  expect(hub.configuration.current()?.revision).toBe(revision); expect(store.get('suggestion')?.suggestion.status).toBe('undone');
  expect(() => store.act('suggestion', { ...request, kind: 'dismiss', reason: 'Reusing a request' }, 'hub')).toThrow('another decision');
});

test('competing Apply requests cannot produce two configuration revisions', () => {
  const row = enqueue(); apply(row, 'first'); expect(() => apply(row, 'second')).toThrow('suggestion changed');
  expect(hub.configuration.history()).toHaveLength(2); expect(store.get('suggestion')?.suggestion.outcomes).toHaveLength(1);
});

test('a failure saving the action receipt rolls back the configuration revision and outcome together', () => {
  const row = enqueue();
  hub.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON documents WHEN NEW.namespace='routing-receipts' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  expect(() => apply(row)).toThrow('fixture receipt failure'); expect(hub.configuration.history()).toHaveLength(1);
  expect(store.get('suggestion')).toEqual(row);
  hub.db.exec('DROP TRIGGER reject_receipt'); expect(apply(row).suggestion.status).toBe('applied'); expect(hub.configuration.history()).toHaveLength(2);
});

test('stale Apply records a recomputation request without overwriting the newer field', () => {
  const row = enqueue(); edit(settings => { settings.routingProfile = 'A newer user preference.'; });
  const stale = apply(row); expect(stale.suggestion.status).toBe('recompute'); expect(stale.suggestion.outcomes).toEqual([]);
  expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe('A newer user preference.');
  const revised = checked('A revised suggestion based on the newer preference.');
  const current = store.recompute('suggestion', stale.revision, revised); expect(current.suggestion.status).toBe('pending');
  expect(() => apply(row, 'old_click')).toThrow('suggestion changed');
  expect(apply(current, 'recomputed_click').suggestion.status).toBe('applied');
  expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(revised.draft.after);
});

test('Undo expires at thirty seconds and refuses a subsequently edited target field', () => {
  const row = enqueue(); const applied = apply(row); now += 30_000;
  const request = { schema: 'routing-suggestion-action-v1' as const, kind: 'undo' as const, clientRequestId: 'undo', revision: applied.revision };
  expect(() => store.act('suggestion', request, 'hub')).toThrow('window has ended');
  now -= 1; edit(settings => { settings.routingProfile = 'Keep this later target-field edit.'; });
  expect(() => store.act('suggestion', request, 'hub')).toThrow('field changed');
  expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe('Keep this later target-field edit.'); expect(store.get('suggestion')?.suggestion.status).toBe('applied');
});

test.each(['text', 'instruction'] as const)('Change it keeps the configuration untouched until Apply this: %s', source => {
  const row = enqueue(); const revised = checked('Only favor GPT for specified backend work.');
  const input = { id: 'preview', source, instruction: source === 'instruction' ? 'Only for backend work.' : null, ...revised };
  const preview = store.preview('suggestion', row.revision, input);
  expect(store.preview('suggestion', row.revision, input)).toEqual(preview);
  expect(hub.configuration.history()).toHaveLength(1); expect(store.get('suggestion')).toEqual(row);
  const applied = apply(row, 'apply_changed', preview.id);
  expect(applied.suggestion.outcomes[0]?.kind).toBe('applied-after-change');
  expect(hub.configuration.current()?.configuration['x-jevellan'].routingProfile).toBe(revised.draft.after);
  expect(() => store.preview('suggestion', row.revision, { ...input, id: 'late' })).toThrow('suggestion changed');
});

test('dismissal records its reason and requires three new correction IDs before a new suggestion', () => {
  const row = enqueue(); const dismissed = store.act('suggestion', { schema: 'routing-suggestion-action-v1', kind: 'dismiss', clientRequestId: 'dismiss', revision: row.revision, reason: 'These were exceptional cases.' }, 'hub');
  expect(dismissed.suggestion.outcomes[0]).toMatchObject({ kind: 'dismissed', reason: 'These were exceptional cases.' });
  const two = group('group_one', ['one', 'two', 'three', 'four', 'five']);
  two.overrides[3]!.mode = 'redo'; two.overrides[4]!.mode = 'redo'; two.weight += 2;
  expect(() => enqueue('too_soon', two)).toThrow('three new corrections');
  const three = group('group_one', ['one', 'two', 'three', 'four', 'five', 'six']); const later = enqueue('z_later', three); expect(later.suggestion.status).toBe('pending');
  store.act('z_later', { schema: 'routing-suggestion-action-v1', kind: 'dismiss', clientRequestId: 'dismiss_again', revision: later.revision, reason: null }, 'hub');
  expect(() => enqueue('same_again', three)).toThrow('three new corrections');
  expect(new Set(store.suppressions()[0]?.overrideIds)).toEqual(new Set(three.overrides.map(value => value.id)));
  expect(hub.configuration.history()).toHaveLength(1);
});

test('pending suggestions deduplicate by group and decided history is visible for seven days', () => {
  const row = enqueue(); expect(enqueue('same_group')).toEqual(row);
  const other = enqueue('other', group('other_group'));
  store.act('suggestion', { schema: 'routing-suggestion-action-v1', kind: 'dismiss', clientRequestId: 'dismiss', revision: row.revision, reason: null }, 'hub');
  now += 7 * 86400_000; expect(store.visible()).toHaveLength(2);
  now += 1; expect(store.visible().map(value => value.suggestion.id)).toEqual([other.suggestion.id]); expect(store.list()).toHaveLength(2);
});

test('unbound comparisons, missing cases, low-confidence groups and cross-field previews cannot become actionable', () => {
  const overrides = group(); const input = { id: 'suggestion', jobId: 'job', group: overrides, preference: { schema: 'routing-preference-v1' as const, groupId: overrides.id, probability: 0.7, requestedModel: 'jev', returnedModel: 'simulated-jev' }, ...checked() };
  expect(() => store.enqueue({ ...input, preference: { ...input.preference, probability: 0.69 } })).toThrow('consistent preference');
  expect(() => store.enqueue({ ...input, draft: { ...input.draft, after: 'An unevaluated change.' } })).toThrow('case comparison');
  expect(() => store.enqueue({ ...input, comparison: { ...input.comparison, caseSet: 'b'.repeat(64) } })).toThrow('complete saved-case set');
  expect(() => store.enqueue({ ...input, comparison: { ...input.comparison, unchanged: 1, cases: input.comparison.cases.slice(0, 1) } })).toThrow('complete saved-case set');
  const row = store.enqueue(input);
  expect(() => store.preview('suggestion', row.revision, { id: 'cross_field', source: 'text', instruction: null, ...checked('A changed effort guide.', { kind: 'effort-guide', effort: 'low' }) })).toThrow('same field');
  expect(store.list()).toHaveLength(1); expect(hub.configuration.history()).toHaveLength(1);
});
