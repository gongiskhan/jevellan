import { createHash } from 'node:crypto';
import { ActionSchema, CorrectStepSchema, EffortSchema, StepCorrectionEditorSchema, StepCorrectionPreviewSchema, newId, stableJson,
  type Configuration, type DecisionRecord } from '@jevellan/core';
import type { ConversationView } from './work.js';
import { conversationActionLabel } from './decision-view.js';

export function stepCorrectionTarget(view: ConversationView, decisions: DecisionRecord[], stretch: number) {
  const step = view.stretches.find(row => row.n === stretch);
  if (!step || step.status === 'undone' || ![view.conversation.work?.id, view.closedWorks.at(-1)?.id].includes(step.workId))
    return { step, decision: undefined, refusal: 'Choose an active step of the open work or last closed work.' };
  const decision = decisions.find(row => row.id === step.decisionId);
  return { step, decision, refusal: decision ? null : 'The original decision record is unavailable.' };
}

export function stepCorrectionEditor(input: {
  view: ConversationView; decisions: DecisionRecord[]; settings: Configuration['x-jevellan']; stretch: number; external: boolean;
  preview?: ReturnType<typeof StepCorrectionPreviewSchema.parse>; refusal?: string;
}) {
  const { view } = input, target = stepCorrectionTarget(view, input.decisions, input.stretch), step = target.step;
  if (!step) throw Object.assign(new Error(target.refusal!), { status: 409 });
  const request = input.preview ?? StepCorrectionPreviewSchema.parse({ schema: 'step-correction-preview-v1', stretch: step.n,
    generation: view.conversation.generation, clientRequestId: newId('correction_preview'), fields: { action: step.action, modelId: step.modelId, effort: step.effortRequested } });
  if (request.stretch !== step.n || request.generation !== view.conversation.generation) throw Object.assign(new Error('This correction is stale. Reload the conversation.'), { status: 409 });
  const fields = request.fields;
  const choices = { ...(fields.action !== step.action ? { action: fields.action } : {}), ...(fields.modelId !== step.modelId ? { modelId: fields.modelId } : {}), ...(fields.effort !== step.effortRequested ? { effort: fields.effort } : {}) };
  const changed = Object.keys(choices).length > 0, refusal = target.refusal ?? input.refusal ?? null;
  const body = (mode: 'noted' | 'redo') => {
    const value = { schema: 'correct-step-v1', generation: request.generation, stretch: step.n, mode, choices };
    const key = stableJson({ projectId: view.conversation.projectId, conversationId: view.conversation.id, nonce: request.clientRequestId, body: value });
    return CorrectStepSchema.parse({ ...value, clientRequestId: `correction_${createHash('sha256').update(key).digest('hex')}` });
  };
  // Validate a changed intent even when its current boundary refuses execution; never normalize it to a different action.
  const noted = changed ? body('noted') : null;
  const canNoted = changed && !refusal, canRedo = canNoted && fields.action !== 'integrate';
  const models = input.settings.menu.map(row => ({ value: row.id, label: row.label, disabled: false }));
  if (!models.some(row => row.value === fields.modelId)) models.unshift({ value: fields.modelId, label: `${fields.modelId} · unavailable`, disabled: true });
  const choice = `${conversationActionLabel(fields.action)}, ${input.settings.menu.find(row => row.id === fields.modelId)?.label ?? fields.modelId}, ${fields.effort}`;
  return StepCorrectionEditorSchema.parse({ schema: 'step-correction-editor-v1', projectId: view.conversation.projectId, conversationId: view.conversation.id, stretch: step.n, fields,
    actionChoices: [...ActionSchema.options.filter(action => action !== 'integrate').map(action => ({ value: action, label: conversationActionLabel(action), disabled: false })),
      ...(step.action === 'integrate' ? [{ value: 'integrate', label: conversationActionLabel('integrate'), disabled: true }] : [])],
    modelChoices: models, effortChoices: EffortSchema.options.map(value => ({ value, label: value, disabled: false })), canNoted, canRedo, refusal,
    preview: { path: `/api/conversations/${view.conversation.id}/step-preview`, request }, requests: { noted: canNoted ? noted : null, redo: canRedo ? body('redo') : null },
    consequences: {
      externalNotice: input.external ? 'This project follows its own git rules. Undo changes the conversation history; repository files are kept.' : null,
      redoText: input.external ? `This marks the steps from ${step.n} onwards undone in the conversation and redoes the step with ${choice}. Repository files are kept.`
        : `This undoes the code and memory changes from step ${step.n} onwards and redoes it with ${choice}. Anything outside the repository (databases, deployments, messages sent) is not undone.`,
      newerWorkText: view.conversation.work && view.conversation.work.id !== step.workId ? 'This also undoes the newer open work. Its request and notes stay with the reopened work.' : null,
      guardNote: fields.action === 'integrate' ? 'Integration steps can run only during publication. Choose another action.' : 'Redo rechecks current runtime and guard limits before it starts.',
    },
  });
}
