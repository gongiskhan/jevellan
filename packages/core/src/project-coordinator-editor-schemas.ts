import { z } from 'zod';
import { EffortSchema, IdSchema } from './schemas.js';
import { ProjectWorkSettingsRequestSchema } from './project-schemas.js';

export const ProjectCoordinatorEditorFieldsSchema = z.strictObject({ modelId: z.string().max(200), effort: EffortSchema, fresh: z.boolean() });
export const ProjectCoordinatorEditorPreviewSchema = z.strictObject({ schema: z.literal('project-coordinator-editor-preview-v1'), projectId: IdSchema,
  revision: z.number().int().nonnegative(), clientRequestId: IdSchema, fields: ProjectCoordinatorEditorFieldsSchema });
export const ProjectCoordinatorEditorSaveSchema = z.strictObject({ schema: z.literal('project-coordinator-editor-save-v1'), projectId: IdSchema,
  settingsRequest: ProjectWorkSettingsRequestSchema, fresh: z.boolean() });
export const ProjectCoordinatorEditorSchema = z.strictObject({ schema: z.literal('project-coordinator-editor-v1'), projectId: IdSchema,
  revision: z.number().int().nonnegative(), fields: ProjectCoordinatorEditorFieldsSchema,
  models: z.array(z.strictObject({ value: z.string().max(200), label: z.string().min(1).max(400), disabled: z.boolean() })),
  efforts: z.array(z.strictObject({ value: EffortSchema, label: z.string().min(1).max(80) })),
  effectiveEffort: z.strictObject({ requested: EffortSchema, actual: EffortSchema, line: z.string().max(500).nullable() }),
  freshEnabled: z.boolean(), help: z.string().max(1000), sessionHelp: z.string().max(1000), savedNotice: z.string().max(500),
  apply: z.strictObject({ enabled: z.boolean(), refusal: z.string().max(500).nullable() }),
  request: z.strictObject({ previewPath: z.string().min(1), savePath: z.string().min(1), base: ProjectCoordinatorEditorPreviewSchema.omit({ fields: true }) }),
  saveRequest: ProjectCoordinatorEditorSaveSchema.nullable(),
});
export type ProjectCoordinatorEditor = z.infer<typeof ProjectCoordinatorEditorSchema>;
export type ProjectCoordinatorEditorFields = z.infer<typeof ProjectCoordinatorEditorFieldsSchema>;
