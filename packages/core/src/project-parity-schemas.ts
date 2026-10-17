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
export const ProjectPrAutoFixSettingsSchema = z.strictObject({ checks: z.boolean(), conflicts: z.boolean(), comments: z.boolean(), maxRounds: z.number().int().min(1).max(10) });
export const ProjectEnvironmentSchema = z.strictObject({
  variables: z.array(z.strictObject({ name: EnvNameSchema, value: z.string().max(4000) })).max(50),
  secrets: z.array(EnvNameSchema).max(50), copyFiles: z.array(ProjectRelativePathSchema).max(20),
}).refine(environment => new Set([...environment.variables.map(variable => variable.name), ...environment.secrets]).size === environment.variables.length + environment.secrets.length, 'Each name can appear once.');
export const ProjectEnvSecretSummarySchema = z.strictObject({ schema: z.literal('project-env-secret-summary-v1'), name: EnvNameSchema, saved: z.boolean(), updatedAt: TimestampSchema.optional() });
export type ProjectEnvSecretSummary = z.infer<typeof ProjectEnvSecretSummarySchema>;
