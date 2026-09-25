import { expect, test, vi } from 'vitest';
import { AccountSchema, AccountStatusSchema, seedConfiguration, type Action, type ModelOption } from '../packages/core/dist/index.js';
import { allowedActions } from '../packages/conversations/dist/guards.js';
import { buildJevRequest, decideNext, JevClient, JevError, manualFallback, modelCandidates, parseJevResponse, prepareAction, prepareModel, resolveAction, resolveModel, type JevQuestions, type ModelCandidate, type ModelPlan } from '../packages/decisions/dist/index.js';

const settings = seedConfiguration()['x-jevellan'];
const models: ModelOption[] = [
  { id: 'swift', runtime: 'codex', model: 'swift-version', enabled: true, label: 'Swift', description: 'Fast coding model.', efforts: ['low', 'high'] },
  { id: 'deep', runtime: 'claude', model: 'deep-version', enabled: true, label: 'Deep', description: 'Strong for complex changes.', efforts: ['high', 'max'] },
];
const accounts = [AccountSchema.parse({ schema: 'account-v1', id: 'codex_test', runtime: 'codex', label: 'Codex test', enabled: true, kind: 'subscription', credential: 'per-device' }),
  AccountSchema.parse({ schema: 'account-v1', id: 'claude_test', runtime: 'claude', label: 'Claude test', enabled: true, kind: 'subscription', credential: 'per-device' })];
const statuses = accounts.map((account) => AccountStatusSchema.parse({ schema: 'account-status-v1', accountId: account.id, deviceId: 'here', auth: 'ready', observedAt: '2026-09-24T10:00:00Z' }));
const support = { mcp: true, readOnlyEnforced: true, edit: true, shell: true };
const base = { settings: { ...settings, menu: models }, runtimes: new Map([['codex', support], ['claude', support]]), accounts, statuses, deviceId: 'here', now: Date.parse('2026-09-24T10:00:00Z'), action: 'implement' as Action };
const candidates = () => modelCandidates(base);
function ready(plan: ModelPlan) { if (plan.kind !== 'ready') throw new Error(plan.message); return plan; }
function forModels(entries: ModelCandidate[], rest: Partial<Parameters<typeof prepareModel>[0]> = {}) { return prepareModel({ action: 'implement', candidates: entries, effortGuide: settings.effortGuide, ...rest }); }
function response(questions: JevQuestions, values: Record<string, string | number> = {}) {
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const value = values[id];
    if (question.type === 'noul') return [id, { type: 'noul', noul: value ?? 0 }];
    if (question.type !== 'choice') throw new Error('Unexpected fixture question.');
    return [id, { type: 'choice', choice: value, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === value ? 1 : 0])), confidence: 1 }];
  }));
  return parseJevResponse(JSON.stringify({ model: 'fixture-returned', answers, usage: { input_tokens: 20, output_tokens: 10 } }), questions);
}

test('Call A sends only guard-allowed actions and classifies a new remember request independently', () => {
  const allowed = allowedActions({ counters: { reviews: 2 } } as Parameters<typeof allowedActions>[0], { ...settings.guards, reviewCap: 2 }, false, 0);
  const plan = prepareAction({ allowed, newMessage: true });
  expect(plan.questions.next_action).toMatchObject({ type: 'choice', criteria: { reply: 'Answer the user; no changes needed.', implement: 'Make or fix the change.' } });
  const criteria = plan.questions.next_action!.type === 'choice' ? plan.questions.next_action!.criteria : {};
  expect(Object.keys(criteria)).not.toContain('integrate'); expect(Object.keys(criteria)).not.toContain('done');
  expect(Object.keys(criteria)).not.toContain('review'); expect(Object.keys(criteria)).not.toContain('adversarial-review'); expect(Object.keys(criteria)).not.toContain('test');
  const answer = resolveAction(plan, response(plan.questions, { next_action: 'reply', remember_request: 0.7 }));
  expect(answer).toMatchObject({ action: { chosen: 'reply', source: 'jev' }, remember: true });
});

test('eligibility arriving after the conversation changed cannot start the model-selection call', async () => {
  let started!: () => void; let release!: (value: ModelCandidate[]) => void; let stale = false;
  const arrived = new Promise<void>(resolve => { started = resolve; }); const eligibility = new Promise<ModelCandidate[]>(resolve => { release = resolve; });
  const decide = vi.fn<JevClient['decide']>(async input => response(input.questions, { pick_eligible: 'swift', effort: 'high' }));
  const pending = decideNext({ decide }, { model: 'jev-selected', state: '{}', allowed: ['implement'], newMessage: false,
    candidates: () => { started(); return eligibility; }, effortGuide: settings.effortGuide, keepCurrentThreshold: 0.6, deviceLabel: 'Here', questionAvailable: false,
    assertCurrent: () => { if (stale) throw new Error('Conversation changed.'); } }, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('Conversation changed'); await arrived; stale = true; release(candidates());
  await rejected; expect(decide).not.toHaveBeenCalled();
});

test.each([['reply', 0.69, false], ['reply', 0.7, true], ['implement', 1, false]] as const)('remember permission: %s at %s is %s', (action, p, remember) => {
  const plan = prepareAction({ allowed: ['reply', 'implement'], newMessage: true });
  expect(resolveAction(plan, response(plan.questions, { next_action: action, remember_request: p })).remember).toBe(remember);
});

test('only-option actions skip Choice and consumed messages are never classified again', () => {
  const plan = prepareAction({ allowed: ['reply'], newMessage: false });
  expect(plan.questions).toEqual({});
  expect(resolveAction(plan)).toEqual({ action: { chosen: 'reply', source: 'only-option', allowed: ['reply'] }, remember: false });
  const fresh = prepareAction({ allowed: ['reply'], newMessage: true });
  expect(Object.keys(fresh.questions)).toEqual(['remember_request']);
});

test('one-time action overrides replace classification without bypassing allowed actions', () => {
  const plan = prepareAction({ allowed: ['reply', 'plan'], override: 'plan', newMessage: false });
  expect(resolveAction(plan).action).toMatchObject({ chosen: 'plan', source: 'override' }); expect(plan.questions).toEqual({});
  expect(() => prepareAction({ allowed: ['reply'], override: 'implement', newMessage: false })).toThrow();
  expect(() => prepareAction({ allowed: ['integrate'], newMessage: false })).toThrow();
});

test('model candidates enforce account ownership, runtime capabilities and enabled configuration', () => {
  expect(candidates().map((entry) => entry.model.id)).toEqual(['swift', 'deep']);
  expect(modelCandidates({ ...base, action: 'review', runtimes: new Map([['codex', { ...support, readOnlyEnforced: false }], ['claude', support]]) }).map((entry) => entry.model.id)).toEqual(['deep']);
  expect(modelCandidates({ ...base, runtimes: new Map([['codex', { ...support, edit: false }], ['claude', { ...support, mcp: false }]]) })).toEqual([]);
  expect(modelCandidates({ ...base, settings: { ...base.settings, runtimes: { codex: { enabled: false }, claude: { enabled: true } } } }).map((entry) => entry.model.id)).toEqual(['deep']);
  expect(modelCandidates({ ...base, settings: { ...base.settings, menu: models.map((model) => ({ ...model, enabled: false })) } })).toEqual([]);
  expect(modelCandidates({ ...base, deviceId: 'other' }).every((entry) => entry.reason === 'needs-login')).toBe(true);
});

test('one eligible model is chosen in code; effort still has all five meanings and maps up', () => {
  const plan = ready(forModels(candidates().slice(0, 1)));
  expect(Object.keys(plan.questions)).toEqual(['effort']);
  expect(plan.questions.effort).toMatchObject({ type: 'choice', criteria: settings.effortGuide });
  const result = resolveModel(plan, { response: response(plan.questions, { effort: 'medium' }), keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(result.model).toMatchObject({ chosen: 'swift', source: 'only-option' });
  expect(result.effort).toMatchObject({ requested: 'medium', effective: 'high', source: 'jev' });
  expect(result.notices).toEqual([{ kind: 'effort-adjusted', text: 'Requested medium; using high, the nearest effort this model supports.' }]);
  expect(result.account.chosen).toBe('codex_test');
});

test.each([[0.6, 'swift', 'kept'], [0.59, 'deep', 'jev']] as const)('current model threshold %s resolves to %s', (p, model, source) => {
  const plan = ready(forModels(candidates(), { currentId: 'swift' }));
  expect(Object.keys(plan.questions)).toEqual(['keep_current', 'pick_eligible', 'effort']);
  const result = resolveModel(plan, { response: response(plan.questions, { keep_current: p, pick_eligible: 'deep', effort: 'high' }), keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(result.model).toMatchObject({ chosen: model, source, keepCurrentP: p });
});

test('once overrides beat pins separately for model and effort, without unused questions', () => {
  const fixed = ready(forModels(candidates(), { currentId: 'swift', once: { modelId: 'deep' }, pins: { modelId: 'swift', effort: 'max' } }));
  expect(fixed.questions).toEqual({});
  const result = resolveModel(fixed, { keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(result.model).toMatchObject({ chosen: 'deep', source: 'override' }); expect(result.effort).toMatchObject({ requested: 'max', source: 'pin' });
  const effortOnly = ready(forModels(candidates(), { once: { effort: 'low' }, pins: { modelId: 'deep', effort: 'max' } }));
  const second = resolveModel(effortOnly, { keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(second.model.source).toBe('pin'); expect(second.effort).toMatchObject({ requested: 'low', effective: 'high', source: 'override' });
  const modelOnly = ready(forModels(candidates(), { once: { modelId: 'deep' } })); expect(Object.keys(modelOnly.questions)).toEqual(['effort']);
  const pinnedEffort = ready(forModels(candidates(), { pins: { effort: 'max' } })); expect(Object.keys(pinnedEffort.questions)).toEqual(['pick_eligible']);
});

test('preferred models needing login produce the exact notice while an eligible account runs', () => {
  const entries = modelCandidates({ ...base, statuses: statuses.map((status) => status.accountId === 'claude_test' ? { ...status, auth: 'expired' } : status) });
  const plan = ready(forModels(entries, { currentId: 'deep' }));
  expect(Object.keys(plan.questions)).toEqual(['pick_any', 'effort']);
  const result = resolveModel(plan, { response: response(plan.questions, { pick_any: 'deep', effort: 'low' }), keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(result.model).toMatchObject({ chosen: 'swift', source: 'only-option', preferredAny: { modelId: 'deep', p: 1 }, excluded: [{ modelId: 'deep', reason: 'expired' }] });
  expect(result.notices).toEqual([{ kind: 'preferred-needs-login', text: 'Deep looked like the best fit, but Claude test needs login on This Mac. Used Swift instead.', accountId: 'claude_test' }]);
});

test('a usage-limited preferred model does not ask the user to log in', () => {
  const entries = modelCandidates({ ...base, statuses: statuses.map((status) => status.accountId === 'claude_test' ? { ...status, coolingUntil: '2026-09-25T10:00:00Z' } : status) });
  const plan = ready(forModels(entries));
  const result = resolveModel(plan, { response: response(plan.questions, { pick_any: 'deep', effort: 'low' }), keepCurrentThreshold: 0.6, deviceLabel: 'This Mac' });
  expect(result.model.excluded).toEqual([{ modelId: 'deep', reason: 'cooling' }]); expect(result.notices).toEqual([]);
});

test('no eligible model waits with account reasons, and an unavailable pin is never silently replaced', () => {
  const entries = modelCandidates({ ...base, statuses: [] });
  expect(forModels(entries)).toMatchObject({ kind: 'waiting', message: 'No model can run this step right now: Swift: needs-login, Deep: needs-login.', reasons: [{ modelId: 'swift', reason: 'needs-login', accountIds: ['codex_test'] }, { modelId: 'deep', reason: 'needs-login', accountIds: ['claude_test'] }] });
  expect(forModels(candidates().slice(0, 1), { pins: { modelId: 'deep' } })).toMatchObject({ kind: 'waiting', reasons: [{ modelId: 'deep', reason: 'unsupported' }] });
});

test('questions carry candidate descriptions but no account usage figures or unrelated catalogue', () => {
  const plan = ready(forModels(candidates()));
  const wire = buildJevRequest({ schema: 'jev-request-v1', model: 'jev-selected', state: '{}', questions: plan.questions });
  expect(wire.questions.pick_eligible).toMatchObject({ criteria: { swift: 'Swift: Fast coding model.', deep: 'Deep: Strong for complex changes.' } });
  const body = JSON.stringify(wire); expect(body).not.toContain('codex_test'); expect(body).not.toContain('ceilingPct');
});

test('unavailable Jev produces the specified manual notice, with no selected action', () => {
  expect(manualFallback(new JevError('no-key'))).toEqual({ kind: 'jev-unavailable', text: 'Jev is unavailable (no key configured). Pick the next step:' });
});

test.skipIf(!process.env.JEVELLAN_TEST_JEV_KEY)('live dedicated Jev smoke parses real Call A and Call B including effort', async () => {
  const client = new JevClient({ key: () => process.env.JEVELLAN_TEST_JEV_KEY, timeoutMs: settings.decisions.timeoutMs });
  const state = JSON.stringify({ rules: { routingProfile: settings.routingProfile, effortGuide: settings.effortGuide, recentCorrections: [] }, conversation: { request: 'Add an optional excited boolean to the greeting function and test both values.' }, facts: { projectHasTestCommand: true } });
  const action = prepareAction({ allowed: ['reply', 'plan', 'implement', 'test', 'ask-you'], newMessage: true });
  const a = await client.decide({ schema: 'jev-request-v1', model: settings.decisions.model, state, questions: action.questions });
  expect(resolveAction(action, a).action.source).toBe('jev');
  const model = ready(forModels(candidates(), { action: 'implement' }));
  const b = await client.decide({ schema: 'jev-request-v1', model: settings.decisions.model, state, questions: model.questions });
  const result = resolveModel(model, { response: b, keepCurrentThreshold: settings.decisions.keepCurrentThreshold, deviceLabel: 'Test device' });
  expect(result.effort.source).toBe('jev'); expect(b.model.length).toBeGreaterThan(0);
}, 20_000);
