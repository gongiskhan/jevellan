import { z } from 'zod';
import { IdSchema, TimestampSchema, UsageSchema } from './schemas.js';
import { PlacementRecordSchema, TurnProcessSchema } from './project-schemas.js';
import { MemoryCaptureSchema, MemoryInboxInputSchema } from './project-memory-schemas.js';
export const MemorySessionSchema = z.strictObject({ schema: z.literal('project-memory-session-v1'), id: IdSchema, projectId: IdSchema,
  kind: z.enum(['extraction', 'dream']), state: z.enum(['running', 'completed', 'failed']), startedAt: TimestampSchema, endedAt: TimestampSchema.optional(),
  placement: PlacementRecordSchema, captures: z.array(MemoryCaptureSchema), retries: z.number().int().nonnegative(), inputFile: z.string(),
  inbox: z.array(MemoryInboxInputSchema).max(8), dreamId: IdSchema.optional(), windowId: IdSchema.optional(), requestId: IdSchema.optional(), reason: z.string().max(1200).optional(),
  process: TurnProcessSchema.optional(), usage: UsageSchema.optional(), summary: z.string().max(1500).optional(), mainCommit: z.string().regex(/^[0-9a-f]{40,64}$/u).optional() });
export type MemorySession = z.infer<typeof MemorySessionSchema>;
