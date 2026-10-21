import { z } from 'zod';
import { EffortSchema, IdSchema } from './schemas.js';
import { ProjectPlacementSettingsSchema } from './project-parity-schemas.js';
import { ProjectWorkSettingsRequestSchema } from './project-schemas.js';

export const ProjectPlacementEditorFieldsSchema = z.strictObject({ allModels: z.boolean(), modelIds: z.array(z.string().max(200)).max(1000), minEffort: z.string().max(40), guidance: z.string().max(32000) });
export const ProjectPlacementEditorPreviewSchema = z.strictObject({ schema: z.literal('project-placement-editor-preview-v1'), projectId: IdSchema,
  revision: z.number().int().nonnegative(), clientRequestId: IdSchema, fields: ProjectPlacementEditorFieldsSchema });
export const ProjectPlacementEditorSaveSchema = z.strictObject({ schema: z.literal('project-placement-editor-save-v1'), projectId: IdSchema, settingsRequest: ProjectWorkSettingsRequestSchema });
export const ProjectPlacementEditorSchema = z.strictObject({ schema: z.literal('project-placement-editor-v1'), projectId: IdSchema, fields: ProjectPlacementEditorFieldsSchema,
  models: z.array(z.strictObject({ id: IdSchema, label: z.string().min(1).max(200) })).max(1000), restrictedModelIds: z.array(IdSchema).max(1000),
  modelsLabel: z.string().min(1).max(100), allModelsLabel: z.string().min(1).max(100), effortLabel: z.string().min(1).max(100),
  efforts: z.array(z.strictObject({ value: z.union([z.literal(''), EffortSchema]), label: z.string().min(1).max(80) })).length(6),
  guidance: z.strictObject({ label: z.string().min(1).max(100), maxLength: z.number().int().positive(), help: z.string().max(1000) }),
  apply: z.strictObject({ enabled: z.boolean(), errors: z.array(z.strictObject({ field: z.string().max(100), message: z.string().max(1000) })).max(100) }),
  patch: ProjectPlacementSettingsSchema.nullable(), saveRequest: ProjectPlacementEditorSaveSchema.nullable(),
  request: z.strictObject({ previewPath: z.string().min(1).max(1000), savePath: z.string().min(1).max(1000), base: ProjectPlacementEditorPreviewSchema.omit({ fields: true }) }),
});
export type ProjectPlacementEditor = z.infer<typeof ProjectPlacementEditorSchema>;
export type ProjectPlacementEditorFields = z.infer<typeof ProjectPlacementEditorFieldsSchema>;
