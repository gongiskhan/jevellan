import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DecisionComparisonSchema, seedConfiguration } from '../packages/core/dist/index.js';
import { buildJevRequest, compareDecisionCases, evaluateDecisionCase, parseJevResponse, savedDecisionCases, type DecisionClient, type SavedDecisionCase } from '../packages/decisions/dist/index.js';

function simulated(cases: SavedDecisionCase[], choose?: (example: SavedDecisionCase, proposed: boolean) => { action?: string; model?: string; effort?: string }): DecisionClient {
  return { async decide(input) {
    const wire = buildJevRequest(input); const state = JSON.parse(wire.state);
    const example = cases.find(value => value.state.conversation.request === state.conversation.request)!;
    expect(example).toBeDefined(); expect(state.acceptable).toBeUndefined();
    const selection = choose?.(example, state.rules.routingProfile === 'Proposed routing') ?? {};
    const values: Record<string, string | number> = { next_action: selection.action ?? example.acceptable.actions[0]!,
      pick_eligible: selection.model ?? example.acceptable.models[0]!, effort: selection.effort ?? example.acceptable.efforts[0]!, keep_current: 0, remember_request: 0 };
    const answers = Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: values[id] }];
      if (question.type !== 'choice') throw new Error('Unexpected question.');
      const value = values[id];
      return [id, { type: 'choice', choice: value, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === value ? 1 : 0])) }];
    }));
    return parseJevResponse(JSON.stringify({ model: 'simulated-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } }), wire.questions);
  } };
}

test('all 24 engineering fixtures exercise the ordinary decision engine with simulated Jev responses', async () => {
  const cases = savedDecisionCases(); expect(cases).toHaveLength(24); const configuration = seedConfiguration();
  const client = simulated(cases); const signal = new AbortController().signal;
  for (const example of cases) {
    const result = await evaluateDecisionCase(client, example, configuration, signal);
    expect(result.acceptable, example.id).toBe(true); expect(result.failedFields).toEqual([]);
    expect(result.calls.length).toBeGreaterThan(0); expect(result.calls.every(call => call.returnedModel === 'simulated-jev')).toBe(true);
    if (['done', 'ask-you'].includes(result.choice.action)) expect(result.choice.modelId).toBeNull();
  }
});

test('comparison records changed cases and exact better/worse/unchanged counts without treating alternative acceptable choices as regressions', async () => {
  const cases = savedDecisionCases().slice(0, 3); const before = seedConfiguration(); const after = seedConfiguration(); after['x-jevellan'].routingProfile = 'Proposed routing';
  const client = simulated(cases, (example, proposed) => {
    if (example.id === 'explain_sum') return { effort: proposed ? 'low' : 'max' };
    if (example.id === 'explain_test_failure') return { effort: proposed ? 'max' : 'low' };
    return { model: proposed ? 'claude-opus' : 'codex-gpt', effort: proposed ? 'medium' : 'low' };
  });
  const result = await compareDecisionCases(client, cases, before, after, 'simulated', new AbortController().signal);
  expect(result).toMatchObject({ schema: 'decision-comparison-v1', evidence: 'simulated', unchanged: 1, better: 1, worse: 1 });
  expect(result.cases.map(value => value.change)).toEqual(['better', 'worse', 'unchanged']);
  expect(result.cases[2]?.before.choice).not.toEqual(result.cases[2]?.after.choice);
  expect(result.cases[0]?.before.failedFields).toEqual(['effort']);
  expect(DecisionComparisonSchema.safeParse({ ...result, worse: 0 }).success).toBe(false);
});

test('proposal menu descriptions and effort guide reach Jev through normal model questions and state', async () => {
  const example = savedDecisionCases().find(value => value.id === 'off_by_one')!; const config = seedConfiguration();
  config['x-jevellan'].menu.find(value => value.id === 'claude-opus')!.description = 'Changed menu description.';
  config['x-jevellan'].effortGuide.low = 'Changed low-effort guidance.';
  const base = simulated([example]); let modelCall = false;
  const client: DecisionClient = { async decide(input, signal) {
    const state = JSON.parse(input.state);
    expect(state.rules.effortGuide.low).toBe('Changed low-effort guidance.'); expect(state.current.description).toBe('Changed menu description.');
    if (input.questions.pick_eligible?.type === 'choice') { modelCall = true; expect(input.questions.pick_eligible.criteria['claude-opus']).toContain('Changed menu description.'); }
    return base.decide(input, signal);
  } };
  expect((await evaluateDecisionCase(client, example, config, new AbortController().signal)).acceptable).toBe(true); expect(modelCall).toBe(true);
});

test('missing fixture models and cancellation cannot silently produce a passing comparison', async () => {
  const cases = savedDecisionCases(); const config = seedConfiguration(); const client = simulated(cases);
  config['x-jevellan'].menu = config['x-jevellan'].menu.filter(value => value.id !== 'claude-fable');
  await expect(evaluateDecisionCase(client, cases[0]!, config, new AbortController().signal)).rejects.toThrow('missing from the menu');
  const controller = new AbortController(); controller.abort();
  await expect(compareDecisionCases(client, cases, seedConfiguration(), seedConfiguration(), 'simulated', controller.signal)).rejects.toThrow('cancelled');
});

test('the manual live command reports a missing dedicated key as blocked without running cases', () => {
  const environment = { ...process.env }; delete environment.JEVELLAN_TEST_JEV_KEY;
  const result = spawnSync(process.execPath, ['scripts/eval-decisions.mjs'], { env: environment, encoding: 'utf8' });
  expect(result.status).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain('BLOCKED: JEVELLAN_TEST_JEV_KEY is missing');
});
