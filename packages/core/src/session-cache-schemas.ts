import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

const count = z.number().int().nonnegative();
export const SessionOwnerSchema = z.strictObject({ kind: z.enum(['coordinator', 'thread', 'review', 'verification', 'memory']), id: IdSchema });
export const SessionTurnCacheSchema = z.strictObject({
  schema: z.literal('session-turn-cache-v1'), owner: SessionOwnerSchema,
  sessionId: z.string().regex(/^[a-f0-9]{64}$/u), runtime: IdSchema, model: z.string().min(1), accountId: IdSchema,
  turn: z.number().int().positive(), at: TimestampSchema, idleSeconds: z.number().nonnegative().nullable(), startedCold: z.boolean(),
  cacheWindowMinutes: z.number().int().min(1).max(1440), contextTokensBefore: count.nullable(),
  cacheReadTokens: count, cacheWriteTokens: count, uncachedInputTokens: count, outputTokens: count,
  // Native transports expose activity observations, rather than a provider-side request clock.
  activityAt: TimestampSchema, activitySource: z.enum(['context', 'usage', 'launch']), contextTokensAfter: count.nullable(),
  usageKnown: z.boolean(), cacheWritesKnown: z.boolean(),
  timezone: z.string().min(1).max(120).default('UTC'),
});
export type SessionTurnCache = z.infer<typeof SessionTurnCacheSchema>;
export const SessionCacheSummarySchema = z.strictObject({
  schema: z.literal('session-cache-summary-v1'), key: z.string().regex(/^[a-f0-9]{64}$/u), owner: SessionOwnerSchema,
  runtime: IdSchema, model: z.string().min(1), accountId: IdSchema, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timezone: z.string().min(1).max(120), turns: count, cacheReadTokens: count, cacheWriteTokens: count, uncachedInputTokens: count, outputTokens: count,
  coldStarts: count, coldWriteTokens: count.nullable(), contextTokens: count.nullable(), usageKnown: z.boolean(),
});
export type SessionCacheSummary = z.infer<typeof SessionCacheSummarySchema>;
export const ProjectSessionCacheSchema = z.strictObject({ schema: z.literal('project-session-cache-v1'), projectId: IdSchema, deviceId: IdSchema,
  revision: z.number().int().nonnegative(), lastEventId: count, updatedAt: TimestampSchema, records: z.array(SessionCacheSummarySchema).max(500) });
export type ProjectSessionCache = z.infer<typeof ProjectSessionCacheSchema>;
