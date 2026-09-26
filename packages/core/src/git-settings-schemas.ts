import { z } from 'zod';
import { IdSchema } from './schemas.js';

export const GitSettingsSchema = z.strictObject({
  schema: z.literal('git-settings-v1'), revision: z.number().int().nonnegative(),
  githubTransport: z.enum(['machine', 'ssh']),
});
export const GitCheckRequestSchema = z.strictObject({ schema: z.literal('git-check-request-v1'), projectId: IdSchema });
export const GitCheckSchema = z.strictObject({
  schema: z.literal('git-check-v1'), projectId: IdSchema, checkedAt: z.iso.datetime(),
  status: z.enum(['ready', 'failed', 'local']), remote: z.string().nullable(),
  transport: z.enum(['ssh', 'https', 'other', 'none']), message: z.string(),
});
