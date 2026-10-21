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
export const DEFAULT_PROJECT_USAGE_RANGE = 'today' as const;
export const PROJECT_USAGE_REFRESH_MS = 15_000;
export const ProjectUsageRequestRangeSchema = ProjectUsageRangeSchema.default(DEFAULT_PROJECT_USAGE_RANGE);
export const ProjectUsagePresentationSchema = z.strictObject({ schema: z.literal('project-usage-presentation-v1'),
  defaultRange: ProjectUsageRangeSchema, refreshMs: z.literal(PROJECT_USAGE_REFRESH_MS), empty: z.boolean(), emptyMessage: z.string().min(1).max(200), unknownCostNotice: z.string().max(200).nullable(),
  ranges: z.array(z.strictObject({ value: ProjectUsageRangeSchema, label: z.string().min(1).max(50) })).length(3),
  totals: z.array(z.strictObject({ key: z.enum(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']), label: z.string().min(1).max(100), value: z.number().nonnegative(), format: z.enum(['count', 'usd']) })).length(5),
  tables: z.array(z.strictObject({ key: z.enum(['byThread', 'byModel', 'byAccount', 'byKind']), label: z.string().min(1).max(100),
    columns: z.array(z.strictObject({ key: z.enum(['label', 'models', 'turns', 'tokens', 'costUsd']), label: z.string().min(1).max(100), format: z.enum(['text', 'plain', 'count', 'usd']) })).min(4).max(5),
    rows: z.array(z.strictObject({ id: z.string(), label: z.string(), models: z.string(), turns: count, tokens: count, costUsd: z.number().nonnegative() })) })).length(4),
});
const group = ThreadUsageTotalSchema.extend({ id: z.string(), label: z.string(), models: z.array(z.string()) });
export const ProjectUsageViewSchema = z.strictObject({ schema: z.literal('project-usage-view-v1'), projectId: IdSchema, range: ProjectUsageRangeSchema,
  totals: ThreadUsageTotalSchema, byThread: z.array(group), byModel: z.array(group), byAccount: z.array(group), byKind: z.array(group), presentation: ProjectUsagePresentationSchema.optional() });
export type ProjectUsageView = z.infer<typeof ProjectUsageViewSchema>;
