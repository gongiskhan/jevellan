import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectCheckEnvironmentSchema, ProjectEnvironmentPurposeSchema, ProjectEnvironmentSchema, ProjectEnvSecretPresentationSchema } from './project-parity-schemas.js';
import { ProjectWorkSettingsRequestSchema, ProjectWorkSettingsSchema } from './project-schemas.js';

export const ProjectEnvironmentEditorFieldsSchema = z.strictObject({ enabled: z.boolean().optional(), setupCommand: z.string().max(1000), copyFiles: z.string().max(32000),
  variables: z.array(z.strictObject({ name: z.string().max(200), value: z.string().max(8000) })).max(201), secrets: z.array(z.string().max(200)).max(101) });
export const ProjectEnvironmentEditorPreviewSchema = z.strictObject({ schema: z.literal('project-environment-editor-preview-v1'), projectId: IdSchema,
  revision: z.number().int().nonnegative(), clientRequestId: IdSchema, purpose: ProjectEnvironmentPurposeSchema.optional(), fields: ProjectEnvironmentEditorFieldsSchema });
export const ProjectEnvironmentEditorSaveSchema = z.strictObject({ schema: z.literal('project-environment-editor-save-v1'), projectId: IdSchema, settingsRequest: ProjectWorkSettingsRequestSchema });
export const ProjectEnvironmentPatchSchema = z.union([z.strictObject({ setupCommand: ProjectWorkSettingsSchema.shape.setupCommand, environment: ProjectEnvironmentSchema }),
  z.strictObject({ checkEnvironment: ProjectCheckEnvironmentSchema.nullable() })]);
const label = z.string().min(1).max(150);
export const ProjectEnvironmentEditorLabelsSchema = z.strictObject({ title: label, enable: label.nullable(), setup: label.nullable(), setupPlaceholder: label,
  copy: label, variables: label, secrets: label, name: label, value: label, addVariable: label, addSecret: label, remove: label,
  variableName: label, variableValue: label, secretName: label, secretValue: label, removeVariable: label, removeSecret: label });
export const ProjectEnvironmentEditorSchema = z.strictObject({ schema: z.literal('project-environment-editor-v1'), projectId: IdSchema, fields: ProjectEnvironmentEditorFieldsSchema,
  purpose: ProjectEnvironmentPurposeSchema.optional(), labels: ProjectEnvironmentEditorLabelsSchema.optional(),
  limits: z.strictObject({ variables: z.number().int().positive(), secrets: z.number().int().positive(), copyFiles: z.number().int().positive(), name: z.number().int().positive(),
    value: z.number().int().positive(), setupCommand: z.number().int().positive(), copyPath: z.number().int().positive() }),
  canAddVariable: z.boolean(), canAddSecret: z.boolean(), newVariable: z.strictObject({ name: z.literal(''), value: z.literal('') }), newSecret: z.literal(''),
  copyHelp: z.string().max(1000), secretHelp: z.string().max(1000), notSetStatus: ProjectEnvSecretPresentationSchema, unavailableStatus: ProjectEnvSecretPresentationSchema,
  apply: z.strictObject({ enabled: z.boolean(), errors: z.array(z.strictObject({ field: z.string().max(100), message: z.string().max(1000) })).max(100) }),
  patch: ProjectEnvironmentPatchSchema.nullable(), saveRequest: ProjectEnvironmentEditorSaveSchema.nullable(),
  request: z.strictObject({ previewPath: z.string().min(1).max(1000), savePath: z.string().min(1).max(1000), base: ProjectEnvironmentEditorPreviewSchema.omit({ fields: true }) }),
});
export type ProjectEnvironmentEditor = z.infer<typeof ProjectEnvironmentEditorSchema>;
export type ProjectEnvironmentEditorFields = z.infer<typeof ProjectEnvironmentEditorFieldsSchema>;
