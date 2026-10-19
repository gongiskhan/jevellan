import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { StoredProjectWorkSettingsSchema } from './project-schemas.js';
export const EkoaCodeSetupRequestSchema = z.strictObject({ schema: z.literal('ekoa-code-setup-request-v1'), modelId: IdSchema, workflowPull: z.number().int().positive() });
export const EkoaCodeSetupReceiptSchema = z.strictObject({ schema: z.literal('ekoa-code-setup-receipt-v1'), projectId: IdSchema, modelId: IdSchema, workflowPull: z.number().int().positive(), completed: z.boolean(), settingsPrepared: z.boolean().default(false), presetVersion: z.number().int().min(1).max(3).default(1), settings: StoredProjectWorkSettingsSchema });
