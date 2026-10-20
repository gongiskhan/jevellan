import { ConversationDecisionWhyViewSchema, modelNotServed, type Configuration, type ComposerOverrideRecord, type DecisionRecord, type OverrideRecord, type Stretch } from '@jevellan/core';
import { recordedDecisionNotice } from './step-presentation.js';

export const conversationActionLabel = (action: string) => action === 'ask-you' ? 'Ask you' : action.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');
const sourceLabel = (source: string) => ({ jev: 'Jev', 'only-option': 'only option', guard: 'guard', override: 'your override', redo: 'redo', manual: 'picked manually', kept: 'kept', pin: 'kept for this conversation' })[source] ?? source;

export function conversationDecisionWhy(input: {
  projectId: string; decision: DecisionRecord; step?: Stretch; settings: Configuration['x-jevellan'];
  accounts: Array<{ id: string; label: string }>; corrections: Array<ComposerOverrideRecord | OverrideRecord>;
}) {
  const d = input.decision;
  const modelLabel = (id: string) => input.settings.menu.find(row => row.id === id)?.label ?? id;
  const accountLabel = (id: string) => input.accounts.find(row => row.id === id)?.label ?? id;
  const options = (entries: Array<[string, number | undefined]>, label: (id: string) => string, chosen: string, name: string) => entries
    .filter((entry): entry is [string, number] => entry[1] !== undefined).sort((a, b) => b[1] - a[1])
    .map(([id, p]) => ({ id, label: label(id), p, selected: id === chosen, progressLabel: `${label(id)} ${name}` }));
  const valueLabel = (field: string, value: string | null) => value === null ? 'Auto' : field === 'model' ? modelLabel(value) : value;
  return ConversationDecisionWhyViewSchema.parse({ schema: 'conversation-decision-why-view-v1', projectId: input.projectId, conversationId: d.conversationId, decisionId: d.id, at: d.at,
    eyebrow: input.step ? `step ${input.step.n} · ${input.step.action}` : null,
    action: { sourceLabel: sourceLabel(d.action.source), chosenLabel: conversationActionLabel(d.action.chosen), guardReason: d.action.guardReason ?? null,
      options: options(d.action.allowed.map(action => [action, d.action.probabilities?.[action]]), conversationActionLabel, d.action.chosen, 'probability') },
    model: d.model ? { sourceLabel: sourceLabel(d.model.source), chosenLabel: modelLabel(d.model.chosen), options: options(d.model.eligible.map(row => [row.modelId, row.p]), modelLabel, d.model.chosen, 'model probability'),
      keepCurrent: d.model.keepCurrentP === undefined ? null : { p: d.model.keepCurrentP, outcome: d.model.source === 'kept' ? ', so it was kept.' : ', so Jev picked again.' },
      preferredLine: d.model.preferredAny && d.model.preferredAny.modelId !== d.model.chosen ? `Preferred across enabled models: ${modelLabel(d.model.preferredAny.modelId)}.` : null,
      excluded: d.model.excluded.map(row => ({ id: row.modelId, text: `${modelLabel(row.modelId)}: ${row.reason === 'model-not-served' ? modelNotServed(modelLabel(row.modelId)) : row.reason.replaceAll('-', ' ')}` })) } : null,
    effort: d.effort ? { sourceLabel: sourceLabel(d.effort.source), chosenLabel: d.effort.effective,
      mapping: d.effort.requested !== d.effort.effective ? { requested: d.effort.requested, effective: d.effort.effective, reason: 'nearest effort this model supports' } : null,
      options: options(Object.entries(d.effort.probabilities ?? {}), id => id, d.effort.requested, 'effort probability') } : null,
    notices: d.notices.map(recordedDecisionNotice),
    memory: d.memory ? { sourceLabel: d.memory.source === 'search-rank' ? 'Selected by search rank.' : 'Selected by Jev.', chosen: d.memory.chosen,
      candidates: d.memory.candidates.map(id => ({ id, selected: d.memory!.chosen.includes(id), score: d.memory!.scores?.[id] ?? null })) } : null,
    corrections: d.correctionsShown.map(id => {
      const record = input.corrections.find(row => row.id === id);
      return record ? { id, heading: record.schema === 'composer-override-v1' && record.request.value === null ? 'Back to Auto'
        : { once: 'Next decision only', pin: 'Keep for this conversation', noted: 'Just override', redo: 'Override and undo' }[record.request.mode],
        line: record.changes.map(change => `${change.field}: ${valueLabel(change.field, change.from)} → ${valueLabel(change.field, change.to)}`).join(', '), context: record.context, unavailable: false }
        : { id, heading: '', line: 'This earlier correction is unavailable.', context: null, unavailable: true };
    }),
    accounts: d.account ? d.account.ranking.map(row => ({ id: row.accountId, label: accountLabel(row.accountId), reason: row.reason, selected: row.accountId === d.account!.chosen, excluded: row.accountId !== d.account!.chosen && !row.eligible })) : null,
    jev: { model: d.jev?.returnedModel ?? null, latencyMs: d.latencyMs,
      noCallLine: d.jev ? null : d.action.source === 'manual' || d.action.source === 'redo' ? 'This step was picked manually.' : 'No Jev call was needed for this choice.',
      calls: (d.jev?.records ?? []).map(call => ({ label: call.kind === 'action' ? 'Next step' : call.kind === 'model' ? 'Model and effort' : call.kind === 'memory' ? 'Memory' : 'Placement',
        model: call.returnedModel, tokens: call.usage.input_tokens + call.usage.output_tokens, latencyMs: call.latencyMs })) },
  });
}
