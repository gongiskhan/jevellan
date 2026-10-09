import { z } from 'zod';
import { ActionSchema, EffortSchema, IdSchema, NextChoicesSchema, ResourceChoicesSchema } from './schemas.js';

const request = { schema: z.literal('composer-choice-v1'), clientRequestId: IdSchema, generation: z.number().int().nonnegative() };
export const ComposerChoiceSchema = z.discriminatedUnion('field', [
  z.strictObject({ ...request, field: z.literal('action'), mode: z.literal('once'), value: ActionSchema.exclude(['integrate']).nullable() }),
  z.strictObject({ ...request, field: z.literal('model'), mode: z.enum(['once', 'pin']), value: IdSchema.nullable() }),
  z.strictObject({ ...request, field: z.literal('runtime'), mode: z.enum(['once', 'pin']), value: IdSchema.nullable() }),
  z.strictObject({ ...request, field: z.literal('account'), mode: z.enum(['once', 'pin']), value: IdSchema.nullable() }),
  z.strictObject({ ...request, field: z.literal('effort'), mode: z.enum(['once', 'pin']), value: EffortSchema.nullable() }),
]);
export type ComposerChoice = z.infer<typeof ComposerChoiceSchema>;
export const ComposerInitialSchema = z.strictObject({ schema: z.literal('composer-initial-v1'), once: NextChoicesSchema, pins: ResourceChoicesSchema });
export const StartComposerChoicesSchema = z.strictObject({ schema: z.literal('start-composer-choices-v1'), choices: ComposerInitialSchema });
export const ComposerChangeSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('action'), from: ActionSchema.nullable(), to: ActionSchema.exclude(['integrate']).nullable() }),
  z.strictObject({ field: z.literal('model'), from: IdSchema.nullable(), to: IdSchema.nullable() }),
  z.strictObject({ field: z.literal('runtime'), from: IdSchema.nullable(), to: IdSchema.nullable() }),
  z.strictObject({ field: z.literal('account'), from: IdSchema.nullable(), to: IdSchema.nullable() }),
  z.strictObject({ field: z.literal('effort'), from: EffortSchema.nullable(), to: EffortSchema.nullable() }),
]);
export const ComposerOverrideRecordSchema = z.strictObject({
  schema: z.literal('composer-override-v1'), id: IdSchema, request: ComposerChoiceSchema, conversationId: IdSchema, projectId: IdSchema,
  workId: IdSchema.nullable(), decisionId: IdSchema.nullable(), stretch: z.number().int().positive().nullable(),
  at: z.iso.datetime(), appliedAt: z.iso.datetime().optional(), status: z.enum(['pending', 'applied', 'superseded']),
  action: ActionSchema.nullable(), context: z.string().min(1).nullable(), changes: z.array(ComposerChangeSchema).length(1),
}).superRefine((value, context) => {
  if (value.changes[0]?.field !== value.request.field || value.changes[0]?.to !== value.request.value) context.addIssue({ code: 'custom', message: 'The recorded change must match its composer request.' });
  if (value.status === 'applied' && (!value.decisionId || !value.workId || !value.action || !value.context || !value.appliedAt)) context.addIssue({ code: 'custom', message: 'An applied choice must identify its decision and context.' });
  if (value.status !== 'applied' && (value.decisionId || value.stretch || value.appliedAt)) context.addIssue({ code: 'custom', message: 'An unapplied choice cannot claim a decision or stretch.' });
});
export type ComposerOverrideRecord = z.infer<typeof ComposerOverrideRecordSchema>;
