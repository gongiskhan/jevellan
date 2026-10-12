import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ProjectWorkSettingsSchema } from './project-schemas.js';
export const EkoaCodeSetupRequestSchema = z.strictObject({ schema: z.literal('ekoa-code-setup-request-v1'), modelId: IdSchema, workflowPull: z.number().int().positive() });
export const EkoaCodeSetupReceiptSchema = z.strictObject({ schema: z.literal('ekoa-code-setup-receipt-v1'), projectId: IdSchema, modelId: IdSchema, workflowPull: z.number().int().positive(), completed: z.boolean(), presetVersion: z.number().int().min(1).max(2).default(1), settings: ProjectWorkSettingsSchema });
