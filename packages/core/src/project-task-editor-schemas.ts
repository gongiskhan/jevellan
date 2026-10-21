import { z } from 'zod';
import { EffortSchema, IdSchema } from './schemas.js';
import { TaskCreateRequestSchema } from './project-loop-schemas.js';
import { ProjectCoordinatorUiSchema } from './project-page-schemas.js';
export const ProjectTaskEditorFieldsSchema = z.strictObject({ title: z.string().max(20000), task: z.string().max(200000), isolation: z.string().max(40), modelId: z.string().max(128), effort: z.string().max(40), deviceId: z.string().max(128), type: z.string().max(64), goalId: z.string().max(128), now: z.boolean(), after: z.array(IdSchema).max(10), needs: z.string().max(4000), fromBranch: z.string().max(2000) });
export const ProjectTaskEditorCommandSchema = z.strictObject({ type: z.literal('model'), value: z.string().max(128) });
export const ProjectTaskEditorPreviewSchema = z.strictObject({ schema: z.literal('project-task-editor-preview-v1'), fields: ProjectTaskEditorFieldsSchema, command: ProjectTaskEditorCommandSchema.optional() });
export const ProjectTaskEditorSaveSchema = z.strictObject({ schema: z.literal('project-task-editor-save-v1'), fields: ProjectTaskEditorFieldsSchema, clientRequestId: IdSchema });
export const ProjectTaskEditorSchema = z.strictObject({ schema: z.literal('project-task-editor-v1'), projectId: IdSchema, currentDeviceId: IdSchema, fields: ProjectTaskEditorFieldsSchema,
  models: z.array(z.strictObject({ id: IdSchema, label: z.string(), efforts: z.array(EffortSchema) })), efforts: z.array(EffortSchema), devices: z.array(z.strictObject({ id: IdSchema, label: z.string(), disabled: z.boolean() })),
  goals: z.array(z.strictObject({ id: IdSchema, label: z.string() })), afterTasks: z.array(z.strictObject({ id: IdSchema, label: z.string() })), types: z.array(z.string()),
  limits: z.strictObject({ title: z.number().int().positive(), task: z.number().int().positive(), fromBranch: z.number().int().positive() }), mainIsolationRefusal: z.string(), deviceNote: z.string().nullable(), coordinator: ProjectCoordinatorUiSchema,
  canSave: z.boolean(), validation: z.array(z.string()), savedNotice: z.string(),
  plan: z.strictObject({ path: z.string(), method: z.literal('POST'), body: TaskCreateRequestSchema.omit({ clientRequestId: true }) }).nullable(),
});
export type ProjectTaskEditorFields = z.infer<typeof ProjectTaskEditorFieldsSchema>;
export type ProjectTaskEditor = z.infer<typeof ProjectTaskEditorSchema>;
