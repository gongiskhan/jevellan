import { MergeRouteNameSchema, MergeRouteStateSchema, type JevCall, type SecretRedactor } from '@jevellan/core';
import type { z } from 'zod';
import { askJev, type DecisionClient } from './engine.js';
import { runDecision, type DecisionSource } from './deadline.js';
export const MERGE_CRITERIA = {
  merge: "Small or low-risk change outside the project's risky areas, covered by the checks that passed.",
  'test-then-merge': 'A behaviour change the checks do not exercise, or a medium-sized change, outside the risky areas.',
  'ask-owner': 'Touches a risky area, changes stored data or production behaviour, or is large or hard to undo.',
};
/** One decision under one overall deadline (fix-051): obtaining the client, the model read, the key and every attempt; any failure asks the owner. */
export async function decideMergeRoute(client: DecisionSource | DecisionClient | undefined, input: z.infer<typeof MergeRouteStateSchema>, model: string | (() => Promise<string>), redactor: Pick<SecretRedactor, 'document' | 'text'>, signal: AbortSignal) {
  const calls: JevCall[] = []; let packet: z.infer<typeof MergeRouteStateSchema>;
  try {
    packet = MergeRouteStateSchema.parse(redactor.document(input));
    if (!client) throw new Error('Jev is unavailable.');
    if (JSON.stringify(packet).length > 100_000) throw new Error('This pull request is too large for a complete merge-routing packet.');
    const state = JSON.stringify(packet);
    const answer = (await runDecision(client, signal, async (ready, inner) => askJev(ready, { model: typeof model === 'string' ? model : await model(), state,
      questions: { merge_route: { type: 'choice', instructions: 'Choose how this checked pull request reaches main.', criteria: MERGE_CRITERIA } }, kind: 'merge', calls }, inner)))?.answers.merge_route;
    if (answer?.type !== 'choice') throw new Error('Jev did not return a merge route.');
    const choices = Object.keys(MERGE_CRITERIA), score = (key: string) => answer.probabilities[key] ?? 0, max = Math.max(...choices.map(score));
    const route = MergeRouteNameSchema.parse(score(answer.choice) === max ? answer.choice : choices.find(key => score(key) === max));
    return { route, source: 'jev' as const, reason: MERGE_CRITERIA[route], packet, calls, probabilities: answer.probabilities };
  } catch (error) {
    const fallback = MergeRouteStateSchema.safeParse(redactor.document(input));
    packet = fallback.success ? fallback.data : { schema: 'merge-route-state-v1', title: String(input.title).slice(0, 120), task: { type: 'feature', needs: [], goal: null }, summary: '', riskyAreas: '', files: [], totalSize: 0, corrections: [] };
    return { route: 'ask-owner' as const, source: 'unavailable' as const, packet, calls, reason: redactor.text(error instanceof Error ? error.message : 'Jev is unavailable.').slice(0, 1200) };
  }
}
