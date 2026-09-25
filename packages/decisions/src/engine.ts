import { JevCallSchema, type Action, type DecisionRecord, type Effort, type JevCall } from '@jevellan/core';
import { JevError, type JevQuestions, type JevResponse } from './contract.js';
import type { JevClient } from './client.js';
import { prepareAction, prepareModel, resolveAction, resolveModel, type ModelCandidate, type Preferences } from './selection.js';

export type DecisionClient = Pick<JevClient, 'decide'>;
export type DecisionSelection = Pick<DecisionRecord, 'action' | 'model' | 'effort' | 'account' | 'notices'> & { remember: boolean; calls: JevCall[] };
export type DecisionResult = { kind: 'selected'; selection: DecisionSelection }
  | { kind: 'waiting'; message: string; reasons: { modelId: string; reason: string; accountIds: string[] }[]; calls: JevCall[] };

export function jevMetadata(calls: JevCall[]): DecisionRecord['jev'] {
  if (!calls.length) return undefined;
  return { requestedModel: calls[0]!.requestedModel, returnedModel: calls.at(-1)!.returnedModel, calls: calls.length, records: calls,
    usage: calls.reduce((sum, call) => ({ input_tokens: sum.input_tokens + call.usage.input_tokens, output_tokens: sum.output_tokens + call.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) };
}
export async function askJev(client: DecisionClient, input: { model: string; state: string; questions: JevQuestions; kind: JevCall['kind']; calls: JevCall[] }, signal: AbortSignal): Promise<JevResponse | undefined> {
  if (signal.aborted) throw new JevError('cancelled');
  if (!Object.keys(input.questions).length) return undefined;
  const start = Date.now();
  const response = await client.decide({ schema: 'jev-request-v1', model: input.model, state: input.state, questions: input.questions }, signal);
  if (signal.aborted) throw new JevError('cancelled');
  input.calls.push(JevCallSchema.parse({ schema: 'jev-call-v1', kind: input.kind, requestedModel: input.model, returnedModel: response.model, usage: response.usage, latencyMs: Date.now() - start }));
  return response;
}

export async function decideNext(client: DecisionClient, input: {
  model: string; state: string; allowed: Action[]; newMessage: boolean; actionOverride?: Action;
  candidates(action: Action): ModelCandidate[] | Promise<ModelCandidate[]>; effortGuide: Record<Effort, string>; currentId?: string;
  pins?: Preferences; once?: Preferences; keepCurrentThreshold: number; deviceLabel: string;
  questionAvailable: boolean; assertCurrent(): void;
  calls?: JevCall[]; forcedAction?: 'integrate';
}, signal: AbortSignal): Promise<DecisionResult> {
  const calls = input.calls ?? [];
  const a = input.forcedAction ? undefined : prepareAction({ allowed: input.allowed, newMessage: input.newMessage, ...(input.actionOverride ? { override: input.actionOverride } : {}) });
  const answerA = a ? await askJev(client, { model: input.model, state: input.state, questions: a.questions, kind: 'action', calls }, signal) : undefined; input.assertCurrent();
  const { action, remember } = a ? resolveAction(a, answerA) : { action: { chosen: 'integrate', source: 'guard', allowed: ['integrate'], guardReason: 'Resolve the publication conflict before verifying and publishing.' } as DecisionRecord['action'], remember: false };
  if (action.chosen === 'done' || action.chosen === 'ask-you' && input.questionAvailable) return { kind: 'selected', selection: { action, remember, calls, notices: [] } };
  const runtimeAction = action.chosen === 'ask-you' ? 'reply' : action.chosen;
  const candidates = await input.candidates(runtimeAction); input.assertCurrent();
  const b = prepareModel({ action: runtimeAction, candidates, effortGuide: input.effortGuide,
    ...(input.currentId ? { currentId: input.currentId } : {}), ...(input.pins ? { pins: input.pins } : {}), ...(input.once ? { once: input.once } : {}) });
  if (b.kind === 'waiting') return { ...b, calls };
  const answerB = await askJev(client, { model: input.model, state: input.state, questions: b.questions, kind: 'model', calls }, signal); input.assertCurrent();
  return { kind: 'selected', selection: { action, remember, calls, ...resolveModel(b, { ...(answerB ? { response: answerB } : {}), keepCurrentThreshold: input.keepCurrentThreshold, deviceLabel: input.deviceLabel }) } };
}
