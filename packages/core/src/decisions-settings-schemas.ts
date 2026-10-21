import { z } from 'zod';
import { JevConnectionSchema } from './client-schemas.js';
import { EffortSchema, IdSchema } from './schemas.js';

export const DecisionGuardFieldSchema = z.enum(['maxStretchesPerWork', 'stretchTimeoutMin', 'reviewCap', 'noProgressLimit', 'testFailureLimit', 'externalActivityWindowMin', 'workCostCapUsd']);
export const DecisionsSettingsFieldsSchema = z.strictObject({
  model: z.string().max(1000),
  menu: z.array(z.strictObject({ id: IdSchema, label: z.string().max(4000), description: z.string().max(20000), enabled: z.boolean(), offerKey: z.string().max(2000).optional() })).max(200),
  effortGuide: z.record(EffortSchema, z.string().max(20000)), routingProfile: z.string().max(100000),
  guards: z.strictObject({ maxStretchesPerWork: z.string(), stretchTimeoutMin: z.string(), reviewCap: z.string(), noProgressLimit: z.string(), testFailureLimit: z.string(),
    externalActivityWindowMin: z.string(), workCostCapUsd: z.string(), pauseAfterPlan: z.boolean() }),
});
export const DecisionsSettingsPreviewSchema = z.strictObject({ schema: z.literal('decisions-settings-preview-v1'), revision: z.number().int().positive(), clientRequestId: IdSchema,
  fields: DecisionsSettingsFieldsSchema, command: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('add-model'), offerKey: z.string().min(1).max(2000) }), z.strictObject({ kind: z.literal('reset-effort-guide') })]).optional() });
export const DecisionsSettingsSaveSchema = z.strictObject({ schema: z.literal('decisions-settings-save-v1'), revision: z.number().int().positive(), clientRequestId: IdSchema, draftRequestId: IdSchema, fields: DecisionsSettingsFieldsSchema });
export const DecisionsSettingsEditorSchema = z.strictObject({
  schema: z.literal('decisions-settings-editor-v1'), revision: z.number().int().positive(), currentRevision: z.number().int().positive(), fields: DecisionsSettingsFieldsSchema,
  rows: z.array(z.strictObject({ id: IdSchema, runtime: z.string(), model: z.string(), canEnable: z.boolean(), canToggle: z.boolean(), reasonLine: z.string() })),
  candidates: z.array(z.strictObject({ key: z.string(), label: z.string(), runtime: z.string() })), canAdd: z.boolean(), addRefusal: z.string().nullable(),
  guide: z.strictObject({ differsFromSuggested: z.boolean(), notice: z.string(), efforts: z.array(EffortSchema) }),
  guardFields: z.array(z.strictObject({ key: DecisionGuardFieldSchema, label: z.string(), min: z.number(), step: z.string(), required: z.boolean(), placeholder: z.string().optional() })),
  validation: z.array(z.strictObject({ path: z.string(), message: z.string() })), canSave: z.boolean(), staleNotice: z.string().nullable(),
  preview: z.strictObject({ path: z.literal('/api/config/decisions/preview'), request: DecisionsSettingsPreviewSchema }), saveRequest: DecisionsSettingsSaveSchema.nullable(),
});
export type DecisionsSettingsFields = z.infer<typeof DecisionsSettingsFieldsSchema>;
export type DecisionsSettingsEditor = z.infer<typeof DecisionsSettingsEditorSchema>;
export type DecisionsSettingsPreview = z.infer<typeof DecisionsSettingsPreviewSchema>;
export const JevKeyGenerationSchema = z.strictObject({ schema: z.literal('jev-key-generation-v1'), generation: z.number().int().nonnegative() });
export const JevCheckRecordSchema = z.strictObject({ schema: z.literal('jev-check-record-v1'), generation: z.number().int().nonnegative(), result: JevConnectionSchema });
export const JevConnectionViewSchema = z.strictObject({
  schema: z.literal('jev-connection-view-v1'), saved: z.boolean(), lastFour: z.string().max(4).nullable(), savedText: z.string().nullable(), consequence: z.string().nullable(), canTest: z.boolean(),
  result: z.strictObject({ heading: z.string(), tone: z.enum(['success', 'notice']), lines: z.array(z.string()), latencyLine: z.string(), savedModelListed: z.boolean() }).nullable(),
});
export type JevConnectionView = z.infer<typeof JevConnectionViewSchema>;
