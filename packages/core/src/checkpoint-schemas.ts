import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const SessionCheckpointSettingsSchema = z.strictObject({ enabled: z.boolean(), checkpointMinTokens: z.number().int().min(20000).max(200000) });
export type SessionCheckpointSettings = z.infer<typeof SessionCheckpointSettingsSchema>;
export const SessionCheckpointedSchema = z.strictObject({ schema: z.literal('session-checkpointed-v1'),
  owner: z.strictObject({ kind: z.enum(['coordinator', 'thread']), id: IdSchema }), previousSessionId: hash, newSessionId: hash, reason: z.literal('cold'),
  idleSeconds: z.number().nonnegative(), previousContextTokens: z.number().int().nonnegative(), digestChars: z.number().int().nonnegative(),
  firstTurnCacheWriteTokens: z.number().int().nonnegative().nullable(), at: TimestampSchema });
export type SessionCheckpointed = z.infer<typeof SessionCheckpointedSchema>;
export const SessionHistorySchema = z.strictObject({ schema: z.literal('project-session-history-v1'), key: hash, nativeSessionId: z.string().min(1),
  runtime: IdSchema, model: z.string().min(1), accountId: IdSchema, at: TimestampSchema });
export type SessionHistory = z.infer<typeof SessionHistorySchema>;
export const SessionHistoryLinkSchema = SessionHistorySchema.omit({ nativeSessionId: true });
