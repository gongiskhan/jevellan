import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
export const WorktreeDiskEntrySchema = z.strictObject({ projectId: IdSchema, id: IdSchema, kind: z.enum(['thread', 'job', 'verification', 'review']),
  bytes: z.number().int().nonnegative(), updatedAt: TimestampSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  orphan: z.boolean(), reason: z.string().max(300).optional() });
export const WorktreeDiskSchema = z.strictObject({ schema: z.literal('worktree-disk-v1'), deviceId: IdSchema, at: TimestampSchema,
  threadBytes: z.number().int().nonnegative(), jobBytes: z.number().int().nonnegative(), entries: z.array(WorktreeDiskEntrySchema).max(10000) });
export const WorktreeCleanupInputSchema = z.strictObject({ schema: z.literal('worktree-cleanup-input-v1'), confirmed: z.literal(true),
  entries: z.array(WorktreeDiskEntrySchema.pick({ projectId: true, id: true, kind: true, fingerprint: true })).min(1).max(1000)
    .refine(rows => new Set(rows.map(row => `${row.projectId}:${row.kind}:${row.id}`)).size === rows.length, 'Select each worktree once.') });
export type WorktreeDisk = z.infer<typeof WorktreeDiskSchema>;
export type WorktreeDiskEntry = z.infer<typeof WorktreeDiskEntrySchema>;
