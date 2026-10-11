import { MergeRouteNameSchema, MergeRouteStateSchema, type JevCall, type SecretRedactor } from '@jevellan/core';
import type { z } from 'zod';
import { askJev, type DecisionClient } from './engine.js';
export const MERGE_CRITERIA = {
  merge: "Small or low-risk change outside the project's risky areas, covered by the checks that passed.",
  'test-then-merge': 'A behaviour change the checks do not exercise, or a medium-sized change, outside the risky areas.',
  'ask-owner': 'Touches a risky area, changes stored data or production behaviour, or is large or hard to undo.',
};
export async function decideMergeRoute(client: DecisionClient | undefined, input: z.infer<typeof MergeRouteStateSchema>, model: string, redactor: Pick<SecretRedactor, 'document' | 'text'>, signal: AbortSignal) {
  const packet = MergeRouteStateSchema.parse(redactor.document(input)), calls: JevCall[] = [];
  try {
    if (!client) throw new Error('Jev is unavailable.');
    if (JSON.stringify(packet).length > 100_000) throw new Error('This pull request is too large for a complete merge-routing packet.');
    const answer = (await askJev(client, { model, state: JSON.stringify(packet), questions: { merge_route: { type: 'choice', instructions: 'Choose how this checked pull request reaches main.', criteria: MERGE_CRITERIA } }, kind: 'merge', calls }, signal))?.answers.merge_route;
    if (answer?.type !== 'choice') throw new Error('Jev did not return a merge route.');
    const choices = Object.keys(MERGE_CRITERIA), score = (key: string) => answer.probabilities[key] ?? 0, max = Math.max(...choices.map(score));
    const route = MergeRouteNameSchema.parse(score(answer.choice) === max ? answer.choice : choices.find(key => score(key) === max));
    return { route, source: 'jev' as const, packet, calls, probabilities: answer.probabilities };
  } catch (error) {
    return { route: 'ask-owner' as const, source: 'unavailable' as const, packet, calls, reason: redactor.text(error instanceof Error ? error.message : 'Jev is unavailable.').slice(0, 1200) };
  }
}
