import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
export const CleanupCategorySchema = z.enum(['logs', 'evidence', 'worktrees', 'workspaces']);
export type CleanupCategory = z.infer<typeof CleanupCategorySchema>;
const count = z.number().int().nonnegative();
export const CleanupReceiptSchema = z.strictObject({ schema: z.literal('cleanup-receipt-v1'), deviceId: IdSchema,
  trigger: z.enum(['hourly', 'manual']), startedAt: TimestampSchema, endedAt: TimestampSchema, state: z.enum(['completed', 'deferred']),
  freedBytes: count, removed: count, protected: count, changed: count, freeBytes: count, floorMet: z.boolean(), reason: z.string().max(500).optional(),
  categories: z.record(CleanupCategorySchema, z.strictObject({ freedBytes: count, removed: count })) });
export type CleanupReceipt = z.infer<typeof CleanupReceiptSchema>;
export const CleanupStateSchema = z.strictObject({ schema: z.literal('cleanup-state-v1'), deviceId: IdSchema, lastRun: CleanupReceiptSchema.nullable() });
export type CleanupState = z.infer<typeof CleanupStateSchema>;

export const ProjectJobLogSchema = z.strictObject({ schema: z.literal('project-job-log-v1'), runId: IdSchema, projectId: IdSchema, sections: z.array(z.strictObject({ at: TimestampSchema, text: z.string().max(131072) })).max(10) });
