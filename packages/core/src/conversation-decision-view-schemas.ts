import { z } from 'zod';
import { ActionSchema, EffortSchema, IdSchema, TimestampSchema } from './schemas.js';
import { CorrectStepSchema } from './conversation-schemas.js';
import { RecordedNoticeSchema } from './conversation-step-presentation-schemas.js';

export const ConversationDecisionWhyRequestSchema = z.strictObject({ schema: z.literal('conversation-decision-why-request-v1'), decisionId: IdSchema });
const ProbabilityOptionSchema = z.strictObject({ id: z.string(), label: z.string(), p: z.number().min(0).max(1), selected: z.boolean(), progressLabel: z.string() });
const choice = { sourceLabel: z.string(), chosenLabel: z.string(), options: z.array(ProbabilityOptionSchema) };
export const ConversationDecisionWhyViewSchema = z.strictObject({
  schema: z.literal('conversation-decision-why-view-v1'), projectId: IdSchema, conversationId: IdSchema, decisionId: IdSchema, at: TimestampSchema, eyebrow: z.string().nullable(),
  action: z.strictObject({ ...choice, guardReason: z.string().nullable() }),
  model: z.strictObject({ ...choice, keepCurrent: z.strictObject({ p: z.number().min(0).max(1), outcome: z.string() }).nullable(), preferredLine: z.string().nullable(),
    excluded: z.array(z.strictObject({ id: IdSchema, text: z.string() })) }).nullable(),
  effort: z.strictObject({ ...choice, mapping: z.strictObject({ requested: EffortSchema, effective: EffortSchema, reason: z.string() }).nullable() }).nullable(),
  notices: z.array(RecordedNoticeSchema),
  memory: z.strictObject({ sourceLabel: z.string(), chosen: z.array(z.string()), candidates: z.array(z.strictObject({ id: z.string(), selected: z.boolean(), score: z.number().nullable() })) }).nullable(),
  corrections: z.array(z.strictObject({ id: IdSchema, heading: z.string(), line: z.string(), context: z.string().nullable(), unavailable: z.boolean() })),
  accounts: z.array(z.strictObject({ id: IdSchema, label: z.string(), reason: z.string(), selected: z.boolean(), excluded: z.boolean() })).nullable(),
  jev: z.strictObject({ model: z.string().nullable(), latencyMs: z.number().nonnegative(), noCallLine: z.string().nullable(),
    calls: z.array(z.strictObject({ label: z.string(), model: z.string(), tokens: z.number().nonnegative(), latencyMs: z.number().nonnegative() })) }),
});
export type ConversationDecisionWhyView = z.infer<typeof ConversationDecisionWhyViewSchema>;

export const StepCorrectionFieldsSchema = z.strictObject({ action: ActionSchema, modelId: IdSchema, effort: EffortSchema });
export const StepCorrectionPreviewSchema = z.strictObject({ schema: z.literal('step-correction-preview-v1'), stretch: z.number().int().positive(), generation: z.number().int().nonnegative(), clientRequestId: IdSchema, fields: StepCorrectionFieldsSchema });
const option = z.strictObject({ value: z.string(), label: z.string(), disabled: z.boolean() });
export const StepCorrectionEditorSchema = z.strictObject({
  schema: z.literal('step-correction-editor-v1'), projectId: IdSchema, conversationId: IdSchema, stretch: z.number().int().positive(), fields: StepCorrectionFieldsSchema,
  actionChoices: z.array(option), modelChoices: z.array(option), effortChoices: z.array(option),
  canNoted: z.boolean(), canRedo: z.boolean(), refusal: z.string().nullable(),
  preview: z.strictObject({ path: z.string(), request: StepCorrectionPreviewSchema }),
  requests: z.strictObject({ noted: CorrectStepSchema.nullable(), redo: CorrectStepSchema.nullable() }),
  consequences: z.strictObject({ externalNotice: z.string().nullable(), redoText: z.string(), newerWorkText: z.string().nullable(), guardNote: z.string() }),
});
export type StepCorrectionEditor = z.infer<typeof StepCorrectionEditorSchema>;
