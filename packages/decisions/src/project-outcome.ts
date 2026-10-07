import { ProjectRequestOutcomeSchema, type ProjectRequestOutcome, type JevCall } from '@jevellan/core';
import { askJev, type DecisionClient } from './engine.js';
import { JevError } from './contract.js';

export const PROJECT_OUTCOMES = {
  answer: 'An explanation or answer is the requested result.',
  change: 'The owner wants something built or changed.',
  'run-app': 'The owner wants to use a running app. Start it, keep it available and return a working link accessible from their browser. Tests or opening a file on the server do not satisfy this outcome.',
  verify: 'The owner asks for tests or verification, without asking to use a running app.',
  other: 'Another outcome is requested. Preserve the full request and carry it through.',
} as const;

/** Semantic interpretation belongs to Jev; no keyword routing or inferred command in code. */
export async function decideProjectOutcome(client: DecisionClient | (() => Promise<DecisionClient>) | undefined, input: { projectId: string; eventId: string; request: string; history: string; model: string }, signal: AbortSignal): Promise<ProjectRequestOutcome> {
  const calls: JevCall[] = [];
  const base = { schema: 'project-request-outcome-v1', projectId: input.projectId, eventId: input.eventId, calls, at: new Date().toISOString() };
  try {
    const ready = typeof client === 'function' ? await client() : client;
    if (!ready) throw new JevError('no-key');
    const response = await askJev(ready, { model: input.model, kind: 'action', calls,
      state: JSON.stringify({ rules: { instruction: 'Identify the result the owner expects, using the conversation to resolve references. Preserve their intent. A usable app and passed tests are different outcomes.' },
        conversation: { latestUserMessage: input.request, recent: input.history.slice(-8000) } }),
      questions: { outcome: { type: 'choice', instructions: 'What result does the owner expect from this request?', criteria: PROJECT_OUTCOMES } } }, signal);
    const answer = response?.answers.outcome;
    if (answer?.type !== 'choice') throw new JevError('invalid-response');
    const options = Object.keys(PROJECT_OUTCOMES) as Array<keyof typeof PROJECT_OUTCOMES>;
    if (!options.includes(answer.choice as keyof typeof PROJECT_OUTCOMES) || options.some(key => !Number.isFinite(answer.probabilities[key]))) throw new JevError('invalid-response');
    const maximum = Math.max(...options.map(key => answer.probabilities[key]!));
    const goal = answer.probabilities[answer.choice] === maximum ? answer.choice : options.find(key => answer.probabilities[key] === maximum)!;
    return ProjectRequestOutcomeSchema.parse({ ...base, source: 'jev', goal, probabilities: answer.probabilities });
  } catch (error) {
    if (signal.aborted || error instanceof JevError && error.kind === 'cancelled') throw error;
    return ProjectRequestOutcomeSchema.parse({ ...base, source: 'unavailable', goal: null });
  }
}

export function projectOutcomeInstruction(outcome: ProjectRequestOutcome): string {
  return outcome.goal ? PROJECT_OUTCOMES[outcome.goal] : 'Jev could not interpret this request. Preserve the owner’s full request and decide its intended result yourself; do not reduce requested work to a test report.';
}
