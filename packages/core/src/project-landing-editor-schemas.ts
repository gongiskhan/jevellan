import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { DeliverySchema } from './project-landing-schemas.js';
import { ProjectWorkSettingsSchema, ProjectWorkSettingsRequestSchema } from './project-schemas.js';

// Draft bounds permit invalid form values to receive field errors; canonical write bounds remain authoritative.
const check = z.strictObject({ name: z.string().max(40000), paths: z.string().max(40000), command: z.string().max(40000) });
export const ProjectLandingEditorFieldsSchema = z.strictObject({ delivery: DeliverySchema, autoLand: z.boolean(), checks: z.array(check).max(100),
  smokeCheck: z.string().max(40000), mergeCommitPaths: z.string().max(40000) });
export const ProjectLandingPatchSchema = z.strictObject({ delivery: DeliverySchema, autoLand: z.boolean(),
  landingChecks: ProjectWorkSettingsSchema.shape.landingChecks.removeDefault(), smokeCheck: ProjectWorkSettingsSchema.shape.smokeCheck.removeDefault(),
  mergeCommitPaths: ProjectWorkSettingsSchema.shape.mergeCommitPaths.removeDefault() });
export const ProjectLandingEditorRequestSchema = z.strictObject({ schema: z.literal('project-landing-editor-request-v1'), settings: ProjectWorkSettingsSchema,
  clientRequestId: IdSchema.optional(), fields: ProjectLandingEditorFieldsSchema.optional() });
export const ProjectLandingEditorSaveSchema = z.strictObject({ schema: z.literal('project-landing-editor-save-v1'), projectId: IdSchema, settingsRequest: ProjectWorkSettingsRequestSchema });
export const ProjectLandingEditorSchema = z.strictObject({ schema: z.literal('project-landing-editor-v1'), projectId: IdSchema, fields: ProjectLandingEditorFieldsSchema,
  limits: z.strictObject({ checks: z.number().int().positive(), paths: z.number().int().positive(), name: z.number().int().positive(), command: z.number().int().positive(),
    smokeCheck: z.number().int().positive(), mergePaths: z.number().int().positive() }),
  deliveryChoices: z.array(z.strictObject({ value: DeliverySchema, label: z.string().min(1).max(100) })),
  canAddCheck: z.boolean(), newCheck: check, routeHelp: z.string().max(1000), pathsHelp: z.string().max(1000), smokeHelp: z.string().max(1000), mergeHelp: z.string().max(1000),
  apply: z.strictObject({ enabled: z.boolean(), errors: z.array(z.strictObject({ label: z.string().max(300), message: z.string().max(1000) })).max(100) }),
  patch: ProjectLandingPatchSchema.nullable(), saveRequest: ProjectLandingEditorSaveSchema.nullable(),
  request: z.strictObject({ previewPath: z.string().min(1), savePath: z.string().min(1), base: ProjectLandingEditorRequestSchema.omit({ fields: true }) }),
});
export type ProjectLandingEditor = z.infer<typeof ProjectLandingEditorSchema>;
export type ProjectLandingEditorFields = z.infer<typeof ProjectLandingEditorFieldsSchema>;
export type ProjectLandingPatch = z.infer<typeof ProjectLandingPatchSchema>;
