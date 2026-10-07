import { expect, test } from 'vitest';
import { decideProjectOutcome, PROJECT_OUTCOMES } from '../packages/decisions/dist/index.js';
import type { JevRequest } from '../packages/decisions/dist/index.js';
const input = { projectId: 'project_fixture', eventId: 'event_fixture', request: 'run it for me', history: 'Owner: What is this app?\nYou: A static todo app.', model: 'jev-test' };
const signal = () => new AbortController().signal;
test('Jev receives the original request with reference context and its outcome is recorded', async () => {
  let packet: JevRequest | undefined;
  const receipt = await decideProjectOutcome({ decide: async request => {
    packet = request;
    return { schema: 'jev-response-v1', model: 'jev-test', usage: { input_tokens: 12, output_tokens: 3 }, answers: { outcome: { type: 'choice', choice: 'run-app', confidence: 1,
      probabilities: { answer: 0, change: 0, 'run-app': 1, verify: 0, other: 0 } } } };
  } }, input, signal());
  expect(JSON.parse(packet!.state).conversation).toEqual({ latestUserMessage: input.request, recent: input.history });
  expect(packet!.questions.outcome).toMatchObject({ type: 'choice', criteria: PROJECT_OUTCOMES });
  expect(receipt).toMatchObject({ source: 'jev', goal: 'run-app', eventId: input.eventId, calls: [{ returnedModel: 'jev-test', usage: { input_tokens: 12, output_tokens: 3 } }] });
});
test('missing service leaves meaning to the coordinator, without guessing from request words', async () => {
  expect(await decideProjectOutcome(undefined, input, signal())).toMatchObject({ source: 'unavailable', goal: null, calls: [] });
  expect(await decideProjectOutcome(async () => { throw new Error('Unavailable'); }, input, signal())).toMatchObject({ source: 'unavailable', goal: null });
});
test('cancellation prevents saving a semantic answer', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(decideProjectOutcome({ decide: async () => { throw new Error('Must not run'); } }, input, controller.signal)).rejects.toThrow();
});
