import { z } from 'zod';
import { EffortSchema, IdSchema, TimestampSchema } from './schemas.js';

const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR']);
const RESERVED_ENV_PREFIXES = ['CLAUDE_', 'CODEX_', 'ANTHROPIC_', 'OPENAI_', 'JEVELLAN_', 'GIT_'];
export const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/u, 'Use capital letters, digits and underscores.')
  .refine(name => !RESERVED_ENV.has(name) && !RESERVED_ENV_PREFIXES.some(prefix => name.startsWith(prefix)),
    { error: issue => `${String(issue.input)} is reserved for Jevellan and the runtimes.` });
export const ProjectRelativePathSchema = z.string().min(1).max(300)
  .refine(path => !path.startsWith('/') && !path.split('/').includes('..'), 'Use a path inside the project, without ..');
export const ProjectPlacementSettingsSchema = z.strictObject({ allowedModelIds: z.array(IdSchema).max(19).nullable(), minEffort: EffortSchema.nullable(), guidance: z.string().max(2000) });
export const PlacementConstraintsSchema = ProjectPlacementSettingsSchema.pick({ allowedModelIds: true, minEffort: true });
export const ProjectPrAutoFixSettingsSchema = z.strictObject({ checks: z.boolean(), conflicts: z.boolean(), comments: z.boolean(), maxRounds: z.number().int().min(1).max(10) });
export const ProjectEnvironmentSchema = z.strictObject({
  variables: z.array(z.strictObject({ name: EnvNameSchema, value: z.string().max(4000) })).max(50),
  secrets: z.array(EnvNameSchema).max(50), copyFiles: z.array(ProjectRelativePathSchema).max(20),
}).refine(environment => new Set([...environment.variables.map(variable => variable.name), ...environment.secrets]).size === environment.variables.length + environment.secrets.length, 'Each name can appear once.');
export const ProjectEnvSecretSummarySchema = z.strictObject({ schema: z.literal('project-env-secret-summary-v1'), name: EnvNameSchema, saved: z.boolean(), updatedAt: TimestampSchema.optional() });
export type ProjectEnvSecretSummary = z.infer<typeof ProjectEnvSecretSummarySchema>;

export const ProjectSettingsUpdateSchema = z.strictObject({
  maxRunningThreads: z.number().int().min(1).max(20).optional(), maxNewThreadsPerDay: z.number().int().min(1).max(500).optional(),
  startMode: z.enum(['start', 'propose']).optional(),
  prAutoFix: z.strictObject({ checks: z.boolean().optional(), conflicts: z.boolean().optional(), comments: z.boolean().optional() })
    .refine(value => Object.keys(value).length > 0, 'Choose an automatic fix setting.').optional(),
  instructionsAppend: z.string().min(1).max(500).optional(), guidanceAppend: z.string().min(1).max(500).optional(),
  ownerWords: z.string().min(1).max(300),
}).refine(value => Object.keys(value).some(key => key !== 'ownerWords'), 'Choose at least one setting to change.');
export const ProjectSettingFieldSchema = z.enum(['maxRunningThreads', 'maxNewThreadsPerDay', 'startMode', 'prAutoFix.checks', 'prAutoFix.conflicts', 'prAutoFix.comments', 'instructions', 'placement.guidance']);
export const ProjectSettingChangeSchema = z.strictObject({ field: ProjectSettingFieldSchema,
  before: z.union([z.string().max(16000), z.number(), z.boolean()]), after: z.union([z.string().max(16000), z.number(), z.boolean()]), append: z.string().max(500).optional() });
export const ProjectSettingsChangeSchema = z.strictObject({ schema: z.literal('project-settings-change-v1'), id: IdSchema, projectId: IdSchema,
  at: TimestampSchema, ownerWords: z.string().min(1).max(300), changes: z.array(ProjectSettingChangeSchema).max(8) });
export const ProjectSettingsChangeResultSchema = z.strictObject({ schema: z.literal('project-settings-change-result-v1'), change: ProjectSettingsChangeSchema, repeated: z.boolean() });
export const ProjectSettingsUndoRequestSchema = z.strictObject({ schema: z.literal('project-settings-undo-request-v1'), expectedRevision: z.number().int().nonnegative(), clientRequestId: IdSchema, change: ProjectSettingChangeSchema });
export const TasksStartInputSchema = z.strictObject({ taskIds: z.array(IdSchema).min(1).max(20) });
export const TasksStartResultSchema = z.strictObject({ schema: z.literal('tasks-start-result-v1'), tasks: z.array(z.strictObject({ taskId: IdSchema, title: z.string().max(120), state: z.string().max(30), message: z.string().max(200) })).max(20) });
export type ProjectSettingsUpdate = z.infer<typeof ProjectSettingsUpdateSchema>;
export type ProjectSettingChange = z.infer<typeof ProjectSettingChangeSchema>;
export type ProjectSettingsChange = z.infer<typeof ProjectSettingsChangeSchema>;
