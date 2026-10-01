import { z } from 'zod';
import { ActionSchema, CorrectionRecordSchema, EffortSchema, HandoffStatusSchema, IdSchema, type Configuration, type CorrectionRecord, type Handoff, type ModelOption, type SecretRedactor } from '@jevellan/core';
import { JevError } from './contract.js';

const text = z.string();
export const DecisionFactsSchema = z.strictObject({
  stretchesThisWork: z.number().int().nonnegative(), reviewsThisWork: z.number().int().nonnegative(), codeChangedThisWork: z.boolean(),
  changedFiles: z.number().int().nonnegative(), changeSize: z.enum(['small', 'medium', 'large']), riskyAreasTouched: z.array(text),
  lastVerification: z.enum(['none', 'passed', 'failed']), publicationConflict: z.boolean(), projectHasTestCommand: z.boolean(),
  latestMessageNeedsResponse: z.boolean().optional(),
});
export const DecisionStateSchema = z.strictObject({
  schema: z.literal('decision-state-v1'),
  rules: z.strictObject({ routingProfile: text, effortGuide: z.record(EffortSchema, text), recentCorrections: z.array(text).max(8) }),
  conversation: z.strictObject({ request: text, latestUserMessage: text, questionBeforeLatestMessage: text.max(600).optional(), recentConversation: text.max(8000).optional(), offeredAnswers: z.array(text.max(120)).max(4).optional(), chosenAnswer: text.max(120).optional(), summary: z.strictObject({ state: text, nextWork: text }),
    recentHandoffs: z.array(z.strictObject({ action: ActionSchema, status: HandoffStatusSchema, summary: text.max(400), proposedNext: ActionSchema.nullable(), testsRun: z.strictObject({ passed: z.boolean() }).optional(), blockers: z.array(text) })).max(3) }),
  facts: DecisionFactsSchema,
  current: z.strictObject({ modelId: IdSchema, label: text, description: text, effort: EffortSchema }).optional(),
});
export type DecisionFacts = z.infer<typeof DecisionFactsSchema>;
export type DecisionState = z.infer<typeof DecisionStateSchema>;

export function recentCorrections(records: CorrectionRecord[], projectId: string, menu: ModelOption[]): { ids: string[]; sentences: string[] } {
  const sorted = records.map((record) => CorrectionRecordSchema.parse(record)).filter((record) => record.schema === 'override-v1' || record.status === 'applied').sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  const chosen = [...sorted.filter((record) => record.projectId === projectId).slice(0, 5), ...sorted.filter((record) => record.projectId !== projectId).slice(0, 3)];
  const label = (field: string, value: string | null) => value === null ? 'Auto' : field === 'model' ? menu.find((model) => model.id === value)?.label ?? value : value;
  return { ids: chosen.map((record) => record.id), sentences: chosen.map((record) => {
    const context = record.context!.replace(/[\r\n]+/g, ' ');
    const from = record.changes.map((change) => `${change.field} ${label(change.field, change.from)}`).join(', ');
    const to = record.changes.map((change) => `${change.field} ${label(change.field, change.to)}`).join(', ');
    if (record.schema === 'override-v1') return `When ${context}, Jevellan chose ${from}; the user changed it to ${to}.`;
    const choice = record.request.value === null ? `returned ${record.request.field} to Auto` : `${record.request.mode === 'pin' ? 'pinned' : 'set once'} ${to}`;
    return `Before ${context}, the user ${choice}; the previous composer setting was ${from}.`;
  }) };
}

export function buildDecisionState(input: {
  settings: Configuration['x-jevellan']; projectId: string; corrections: CorrectionRecord[];
  request: string; latestUserMessage: string; summary: { state: string; nextWork: string };
  /** Chronological context, not proof that a freeform follow-up resolves the question. */
  questionBeforeLatestMessage?: string | undefined;
  recentConversation?: string | undefined;
  /** Rebuild smaller excerpts from durable sources, keeping the latest answer. */
  conversationContext?: ((maxChars: number) => string) | undefined;
  /** The options offered with that question, and the one the user picked when they picked one. */
  offeredAnswers?: string[] | undefined; chosenAnswer?: string | undefined;
  handoffs: Pick<Handoff, 'stretch' | 'action' | 'status' | 'summary' | 'proposedNext' | 'testsRun' | 'blockers'>[];
  facts: DecisionFacts; current?: { model: ModelOption; effort: z.infer<typeof EffortSchema> };
  redactor: Pick<SecretRedactor, 'document'>; tokenCap?: number;
}): { state: string; correctionsShown: string[]; approximateTokens: number; omittedHandoffs: number[] } {
  const cap = input.tokenCap ?? 12_000;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 12_000) throw new JevError('invalid-request');
  const corrections = recentCorrections(input.corrections, input.projectId, input.settings.menu);
  const handoffs = input.handoffs.slice(-3); const question = input.questionBeforeLatestMessage?.trim();
  const packet = DecisionStateSchema.parse(input.redactor.document({
    schema: 'decision-state-v1', rules: { routingProfile: input.settings.routingProfile, effortGuide: input.settings.effortGuide, recentCorrections: corrections.sentences },
    // Jev decides whether freeform text answers, delegates or asks about the previous question.
    conversation: { request: input.request, latestUserMessage: input.latestUserMessage, ...(question ? { questionBeforeLatestMessage: question.slice(0, 600), ...(input.offeredAnswers?.length ? { offeredAnswers: input.offeredAnswers.map((label) => label.slice(0, 120)) } : {}), ...(input.chosenAnswer ? { chosenAnswer: input.chosenAnswer.slice(0, 120) } : {}) } : {}),
      ...(input.recentConversation ? { recentConversation: input.recentConversation.slice(0, 8000) } : {}),
      summary: { state: input.summary.state, nextWork: input.summary.nextWork },
      recentHandoffs: handoffs.map((handoff) => ({ action: handoff.action, status: handoff.status, summary: handoff.summary.slice(0, 400), proposedNext: handoff.proposedNext,
        blockers: handoff.blockers, ...(handoff.testsRun ? { testsRun: { passed: handoff.testsRun.passed } } : {}) })) },
    facts: input.facts,
    ...(input.current ? { current: { modelId: input.current.model.id, label: input.current.model.label, description: input.current.model.description, effort: input.current.effort } } : {}),
  }));
  const tokens = (state: string) => Math.ceil(Buffer.byteLength(state) / 3);
  const omittedHandoffs: number[] = []; let state = JSON.stringify(packet);
  while (tokens(state) > cap && packet.conversation.recentHandoffs.length) {
    packet.conversation.recentHandoffs.shift(); omittedHandoffs.push(handoffs[omittedHandoffs.length]!.stretch); state = JSON.stringify(packet);
  }
  while (tokens(state) > cap && (packet.conversation.recentConversation?.length ?? 0) > 1200) {
    const history = packet.conversation.recentConversation!;
    const budget = Math.max(1200, Math.floor(history.length * 0.7));
    packet.conversation.recentConversation = input.redactor.document(input.conversationContext
      ? input.conversationContext(budget)
      : `${history.slice(0, Math.floor(budget / 2) - 60)}\n[Context shortened; inspect source pointers.]\n${history.slice(-Math.floor(budget / 2))}`);
    state = JSON.stringify(packet);
  }
  // This packet has no findings or middle messages. Preserve its request and rules;
  // a still-oversized packet must use the manual fallback instead of losing intent.
  if (tokens(state) > cap) throw new JevError('state-too-large');
  return { state, correctionsShown: corrections.ids, approximateTokens: tokens(state), omittedHandoffs };
}
