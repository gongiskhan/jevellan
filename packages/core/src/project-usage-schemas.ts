import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
const count = z.number().int().nonnegative();
export const ThreadUsageTotalSchema = z.strictObject({ turns: count, inputTokens: count, outputTokens: count,
  cacheReadTokens: count, cacheWriteTokens: count, costUsd: z.number().nonnegative(), costUnknownTurns: count });
export type ThreadUsageTotal = z.infer<typeof ThreadUsageTotalSchema>;
export const ProjectUsageKindSchema = z.enum(['coordinator', 'thread', 'verification', 'review', 'memory']);
export const ProjectUsageRowSchema = ThreadUsageTotalSchema.extend({ kind: ProjectUsageKindSchema, ownerId: z.string().min(1).max(200), title: z.string().max(120), runtime: IdSchema,
  modelLabel: z.string().min(1), accountLabel: z.string().min(1) });
export type ProjectUsageRow = z.infer<typeof ProjectUsageRowSchema>;
export const ProjectUsageDaySchema = z.strictObject({ schema: z.literal('project-usage-day-v1'), revision: count, id: z.string().min(1).max(200), projectId: IdSchema, deviceId: IdSchema,
  lastEventId: count.optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), rows: z.array(ProjectUsageRowSchema).max(2000), updatedAt: TimestampSchema });
export type ProjectUsageDay = z.infer<typeof ProjectUsageDaySchema>;
export const ProjectUsageRangeSchema = z.enum(['today', '7d', '30d']);
const group = ThreadUsageTotalSchema.extend({ id: z.string(), label: z.string(), models: z.array(z.string()) });
export const ProjectUsageViewSchema = z.strictObject({ schema: z.literal('project-usage-view-v1'), projectId: IdSchema, range: ProjectUsageRangeSchema,
  totals: ThreadUsageTotalSchema, byThread: z.array(group), byModel: z.array(group), byAccount: z.array(group), byKind: z.array(group) });
export type ProjectUsageView = z.infer<typeof ProjectUsageViewSchema>;
