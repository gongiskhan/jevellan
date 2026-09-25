import { ComposerChoiceSchema, ComposerOverrideRecordSchema, DecisionRecordSchema, newId, stableJson, type ComposerChoice, type ComposerOverrideRecord, type Conversation, type DecisionRecord } from '@jevellan/core';
import type { ConversationWork } from './work.js';
import { correctionContext } from './corrections.js';

export function composerOverrides(work: ConversationWork): ComposerOverrideRecord[] {
  const records = new Map<string, ComposerOverrideRecord>();
  for (const event of work.ledger.events()) {
    if (event.type === 'override') {
      const parsed = ComposerOverrideRecordSchema.safeParse(work.ledger.data(event));
      if (parsed.success) records.set(parsed.data.id, parsed.data);
    } else if (event.type === 'decision') {
      for (const record of composerDecisionRecords(records, DecisionRecordSchema.parse(work.ledger.data(event)))) records.set(record.id, record);
    }
  }
  return [...records.values()];
}
const keyFor = (field: ComposerChoice['field']) => field === 'model' ? 'modelId' : field;

/** Replay a saved intent separately from its later decision binding. */
export function replayComposerChoice(conversation: Conversation, records: Map<string, ComposerOverrideRecord>, value: ComposerOverrideRecord): void {
  const previous = records.get(value.id); const request = value.request; const key = keyFor(request.field);
  if (value.conversationId !== conversation.id || value.projectId !== conversation.projectId) throw new Error('This composer choice belongs to another conversation.');
  if (previous && stableJson(previous) === stableJson(value)) return;
  if (!previous) {
    if (value.status !== 'pending' || request.generation !== conversation.generation) throw new Error('This composer choice is stale.');
    if (request.value === null) {
      delete conversation.once[key];
      if (key !== 'action') delete conversation.pins[key];
    } else if (request.field === 'action') conversation.once.action = request.value;
    else if (request.mode === 'pin') {
      delete conversation.once[key];
      if (request.field === 'model') conversation.pins.modelId = request.value; else conversation.pins.effort = request.value;
    } else if (request.field === 'model') conversation.once.modelId = request.value;
    else conversation.once.effort = request.value;
    conversation.generation++;
  } else {
    if (previous.status !== 'pending' || value.status === 'pending' || stableJson(previous.request) !== stableJson(request) || previous.at !== value.at || stableJson(previous.changes) !== stableJson(value.changes)) throw new Error('A settled composer choice cannot be replaced.');
    const latest = [...records.values()].filter((entry) => entry.status === 'pending' && entry.request.field === request.field && entry.request.mode === 'once').at(-1);
    if (request.mode === 'once' && latest?.id === value.id) delete conversation.once[key];
  }
  records.set(value.id, value);
}

export function saveComposerChoice(work: ConversationWork, raw: unknown): ComposerOverrideRecord {
  const request = ComposerChoiceSchema.parse(raw); const records = composerOverrides(work);
  const repeated = records.find((entry) => entry.request.clientRequestId === request.clientRequestId);
  if (repeated) {
    if (stableJson(repeated.request) !== stableJson(request)) throw new Error('This composer request id was already used for another choice.');
    return repeated;
  }
  const current = work.load().conversation;
  if (request.generation !== current.generation) throw new Error('This composer choice is stale.');
  const key = keyFor(request.field);
  const from = current.once[key] ?? (key === 'action' ? undefined : current.pins[key]) ?? null;
  // A pin replaces the one-time choice for that field; Auto clears both.
  for (const old of records.filter((entry) => entry.status === 'pending' && entry.request.field === request.field && (request.mode === 'pin' || request.value === null || entry.request.mode === 'once'))) work.composer({ ...old, status: 'superseded' });
  const value = ComposerOverrideRecordSchema.parse({ schema: 'composer-override-v1', id: newId('choice'), request, conversationId: current.id, projectId: current.projectId,
    workId: current.work?.id ?? null, decisionId: null, stretch: null, at: new Date().toISOString(), status: 'pending', action: null, context: null,
    changes: [{ field: request.field, from, to: request.value }] });
  work.composer(value); return value;
}

function bindingStatus(record: ComposerOverrideRecord, decision: DecisionRecord): 'applied' | 'superseded' | undefined {
  const { field, value, mode } = record.request;
  if (decision.action.chosen === 'integrate' && field === 'action' || decision.trigger === 'redo') return;
  const selected = field === 'action' ? decision.action.chosen : field === 'model' ? decision.model?.chosen : decision.effort?.requested;
  const source = field === 'model' ? decision.model?.source : decision.effort?.source;
  if (mode === 'pin' && value !== null && (source !== 'pin' || selected !== value)) return;
  return value !== null && selected !== value ? 'superseded' : 'applied';
}

/** The decision and its choice identities share one durable event. */
export function planComposerBindings(work: ConversationWork, decision: DecisionRecord): NonNullable<DecisionRecord['composer']> {
  return { schema: 'composer-bindings-v1', stretch: decision.model ? work.load().conversation.stretchCount + 1 : null,
    choices: composerOverrides(work).filter((record) => record.status === 'pending').flatMap((record) => {
      const status = bindingStatus(record, decision); return status ? [{ id: record.id, status }] : [];
    }) };
}

/** Replay also consumes choices if the subsequent override receipt was interrupted. */
export function composerDecisionRecords(records: Map<string, ComposerOverrideRecord>, decision: DecisionRecord): ComposerOverrideRecord[] {
  return (decision.composer?.choices ?? []).map((binding) => {
    const record = records.get(binding.id);
    if (!record || record.conversationId !== decision.conversationId || record.request.generation > decision.generation || bindingStatus(record, decision) !== binding.status) throw new Error('The decision has an invalid composer binding.');
    const settled = ComposerOverrideRecordSchema.parse(binding.status === 'superseded' ? { ...record, status: 'superseded' } : { ...record, status: 'applied', appliedAt: decision.at,
      decisionId: decision.id, workId: decision.workId, stretch: decision.composer!.stretch, action: decision.action.chosen, context: correctionContext(decision) });
    if (record.status !== 'pending' && stableJson(record) !== stableJson(settled)) throw new Error('A decision cannot change a settled composer choice.');
    return settled;
  });
}

/** Receipt/index repair never repeats the decision or launches a runtime. */
export function bindComposerChoices(work: ConversationWork, decision: DecisionRecord): void {
  const records = new Map(composerOverrides(work).map((record) => [record.id, record]));
  for (const binding of decision.composer?.choices ?? []) work.composer(records.get(binding.id)!);
}
