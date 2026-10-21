import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectWorkSettingsSchema, ProjectWorkSettingsViewSchema, ProjectWorkViewSchema } from './project-schemas.js';
import { ProjectEnvNameSchema, ProjectEnvSecretSummarySchema } from './project-parity-schemas.js';
import { ProjectRoutineSettingsViewSchema } from './project-routine-settings-schemas.js';

export const ProjectSettingsSectionKeySchema = z.enum(['general', 'instructions', 'placement', 'limits', 'pull-requests', 'environment', 'routines', 'health', 'notifications', 'usage', 'automation']);
export const ProjectSettingsNumberKeySchema = z.enum(['maxRunningThreads', 'maxRunningPerDevice', 'threadTurnCap', 'maxNewThreadsPerDay', 'compactAtPercent', 'coordinatorHandoffAtPercent', 'checkpointMinTokens', 'perDeviceLimit', 'maxRounds']);
export const ProjectSettingsControlsSchema = z.strictObject({ schema: z.literal('project-settings-controls-v1'),
  numbers: z.record(ProjectSettingsNumberKeySchema, z.strictObject({ label: z.string().min(1).max(100), min: z.number().int(), max: z.number().int(), step: z.literal(1) })),
  startModes: z.array(z.strictObject({ value: ProjectWorkSettingsSchema.shape.startMode.removeDefault(), label: z.string().min(1).max(100) })).length(2),
  devices: z.array(z.strictObject({ id: IdSchema, label: z.string().min(1).max(220) })).max(10000),
  defaultLimitPrefix: z.string().min(1).max(100),
  automaticFixes: z.array(z.strictObject({ key: z.enum(['checks', 'conflicts', 'comments']), label: z.string().min(1).max(100) })).length(3),
  riskyAreasMaxLength: z.number().int().positive(),
});
const status = ProjectWorkSettingsSchema.shape.status.removeDefault();
export const ProjectSettingsEditorBaseSchema = z.strictObject({ schema: z.literal('project-settings-editor-base-v1'), settingsView: ProjectWorkSettingsViewSchema, work: ProjectWorkViewSchema,
  sections: z.array(z.strictObject({ key: ProjectSettingsSectionKeySchema, label: z.string().min(1).max(100) })).length(ProjectSettingsSectionKeySchema.options.length),
  statusOptions: z.array(z.strictObject({ value: status, label: z.string().min(1).max(100) })).length(3),
  savePath: z.string().min(1).max(1000), backPath: z.string().min(1).max(1000), savedNotice: z.string().min(1).max(500), controls: ProjectSettingsControlsSchema.optional() });
export const ProjectSettingsRiggingSchema = z.strictObject({ schema: z.literal('project-settings-rigging-v1'), names: z.array(z.string().min(1).max(128)).max(10000),
  message: z.string().min(1).max(2 * 1024 * 1024), editPath: z.string().min(1).max(1000) });
export const ProjectSettingsEditorSchema = ProjectSettingsEditorBaseSchema.extend({ schema: z.literal('project-settings-editor-v1'), routines: ProjectRoutineSettingsViewSchema,
  secretStates: z.array(ProjectEnvSecretSummarySchema).max(100), rigging: ProjectSettingsRiggingSchema.optional() });
const presence = z.record(z.string().max(64), z.boolean()).refine(value => Object.keys(value).length <= 2000, 'Too many pending secret inputs.');
export const ProjectSettingsEditorSaveRequestSchema = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('project-settings-editor-save-v1'), clientRequestId: IdSchema, base: ProjectWorkSettingsSchema, draft: ProjectWorkSettingsSchema, secretPresence: presence.default({}) }),
  z.strictObject({ schema: z.literal('project-settings-editor-status-v1'), clientRequestId: IdSchema, base: ProjectWorkSettingsSchema, status }),
]);
const secretStep = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('delete'), name: ProjectEnvNameSchema, path: z.string().min(1).max(1000), method: z.literal('DELETE'), body: z.strictObject({ schema: z.literal('empty-request-v1') }) }),
  z.strictObject({ kind: z.literal('write'), name: ProjectEnvNameSchema, path: z.string().min(1).max(1000), method: z.literal('PUT'), body: z.strictObject({ schema: z.literal('save-secret-v1') }) }),
]);
export const ProjectSettingsEditorSavedSchema = z.strictObject({ schema: z.literal('project-settings-editor-saved-v1'), settingsView: ProjectWorkSettingsViewSchema,
  secretSteps: z.array(secretStep).max(200), statusPatch: z.strictObject({ status, revision: z.number().int().nonnegative() }).nullable(),
  backPath: z.string().min(1).max(1000), savedNotice: z.string().min(1).max(500) });
export type ProjectSettingsEditor = z.infer<typeof ProjectSettingsEditorSchema>;
export type ProjectSettingsSectionKey = z.infer<typeof ProjectSettingsSectionKeySchema>;
export type ProjectSettingsEditorSaved = z.infer<typeof ProjectSettingsEditorSavedSchema>;
