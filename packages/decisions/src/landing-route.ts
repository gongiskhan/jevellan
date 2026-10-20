import { LandingRouteNameSchema, LandingRouteStateSchema, type JevCall, type SecretRedactor } from '@jevellan/core';
import type { z } from 'zod';
import { askJev, type DecisionClient } from './engine.js';
import { runDecision, type DecisionSource } from './deadline.js';
export const LANDING_CRITERIA = {
  land: "Small or low-risk change outside the project's risky areas, covered by the checks that passed.",
  'verify-then-land': 'A behaviour change the checks do not exercise, or a medium-sized change, outside the risky areas.',
  'ask-owner': 'Touches a risky area, changes stored data or production behaviour, or is large or hard to undo.',
};
/** One decision under one overall deadline (fix-051): obtaining the client, the model read, the key and every attempt; any failure asks the owner. */
/** The question set l-v1 as the owner edits it (bridge): instructions and one criterion per route. */
export type LandingPrompt = { instructions: string; criteria: Record<'land' | 'verify-then-land' | 'ask-owner', string> };
export const LANDING_INSTRUCTIONS = 'Choose how this checked thread reaches main.';
export async function decideLandingRoute(client: DecisionSource | DecisionClient | undefined, input: z.infer<typeof LandingRouteStateSchema>, model: string | (() => Promise<string>), redactor: Pick<SecretRedactor, 'document' | 'text'>, signal: AbortSignal, prompt?: LandingPrompt) {
  const criteria = prompt?.criteria ?? LANDING_CRITERIA;
  const calls: JevCall[] = []; let packet: z.infer<typeof LandingRouteStateSchema>;
  try {
    packet = LandingRouteStateSchema.parse(redactor.document(input));
    if (!client) throw new Error('Jev is unavailable.');
    if (JSON.stringify(packet).length > 100_000) throw new Error('This thread is too large for a complete landing packet.');
    const state = JSON.stringify(packet);
    const answer = (await runDecision(client, signal, async (ready, inner) => askJev(ready, { model: typeof model === 'string' ? model : await model(), state,
      questions: { landing_route: { type: 'choice', instructions: prompt?.instructions ?? LANDING_INSTRUCTIONS, criteria } }, kind: 'landing', calls }, inner)))?.answers.landing_route;
    if (answer?.type !== 'choice') throw new Error('Jev did not return a landing route.');
    const choices = Object.keys(criteria), score = (key: string) => answer.probabilities[key] ?? 0, max = Math.max(...choices.map(score));
    const route = LandingRouteNameSchema.parse(score(answer.choice) === max ? answer.choice : choices.find(key => score(key) === max));
    return { route, source: 'jev' as const, reason: criteria[route], packet, calls, probabilities: answer.probabilities };
  } catch (error) {
    const fallback = LandingRouteStateSchema.safeParse(redactor.document(input));
    packet = fallback.success ? fallback.data : { schema: 'landing-route-state-v1', title: String(input.title).slice(0, 120), task: { type: 'feature', needs: [], goal: null }, summary: '', riskyAreas: '', files: [], checks: [], corrections: [] };
    return { route: 'ask-owner' as const, source: 'unavailable' as const, packet, calls, reason: redactor.text(error instanceof Error ? error.message : 'Jev is unavailable.').slice(0, 1200) };
  }
}
