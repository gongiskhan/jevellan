import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const CoordinatorHandoffInputSchema = z.strictObject({ inFlight: z.string().min(1).max(8000), pendingAsks: z.string().max(4000), decisions: z.string().max(8000),
  ownerMessages: z.array(z.strictObject({ eventId: IdSchema, outcome: z.enum(['thread', 'task', 'note', 'answered', 'declined']), ref: z.string().max(200).optional() })).max(10000) });
export const CoordinatorHandoffSchema = CoordinatorHandoffInputSchema.extend({ schema: z.literal('coordinator-handoff-v1'), id: IdSchema, projectId: IdSchema,
  deviceId: IdSchema, turn: z.number().int().positive(), at: TimestampSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.number().int().positive() });
export type CoordinatorHandoff = z.infer<typeof CoordinatorHandoffSchema>;

export const JournalConfigSchema = z.strictObject({ schema: z.literal('journal-config-v1'), name: z.string().min(1).max(200), timezone: z.string().min(1).max(120) });
const count = z.number().int().nonnegative();
export const JournalThreadSchema = z.strictObject({
  schema: z.literal('journal-thread-v1'), id: IdSchema, projectId: IdSchema, title: z.string().min(1).max(120),
  task: z.string().max(32768), taskId: IdSchema.nullable(), goal: z.string().max(400).nullable(), type: z.string().max(80).nullable(),
  runtime: IdSchema, model: z.string().min(1), effort: z.string().min(1), deviceId: IdSchema,
  isolation: z.enum(['worktree', 'main']), branch: z.string().nullable(), pr: z.number().int().positive().nullable(),
  state: z.string().min(1).max(80), createdAt: TimestampSchema, endedAt: TimestampSchema.nullable(),
});
export type JournalThread = z.infer<typeof JournalThreadSchema>;
export const JournalDocumentSchema = z.strictObject({ schema: z.literal('journal-document-v1'),
  collection: z.enum(['task', 'task-history', 'question', 'refill', 'job', 'window', 'merge', 'dream']), key: IdSchema,
  nightlyWindowId: IdSchema.optional(),
  document: z.record(z.string(), z.unknown()).refine(value => typeof value.schema === 'string', 'A journal document needs its source schema.'),
});
export type JournalDocument = z.infer<typeof JournalDocumentSchema>;
/** An immutable copy of an existing ledger event. The receiver validates its resolved payload by event type. */
export const ProjectJournalRecordSchema = z.strictObject({ schema: z.literal('project-journal-record-v1'), deviceId: IdSchema, ledgerId: IdSchema,
  event: z.strictObject({ schema: z.literal('project-ledger-event-v1'), t: TimestampSchema, id: z.number().int().positive(),
    type: IdSchema, turn: z.number().int().positive().optional(), data: z.unknown() }),
});
export type ProjectJournalRecord = z.infer<typeof ProjectJournalRecordSchema>;
export const JournalRelativePathSchema = z.string().max(300).regex(/^(?:INDEX\.md|(?:threads|days|nights)\/[A-Za-z0-9_-]+\.md|handoffs\/\d{4}-\d{2}-\d{2}-[1-9]\d*\.(?:md|json))$/u);
export const ProjectJournalStateSchema = z.strictObject({ schema: z.literal('project-journal-state-v1'),
  lastLedgerEventId: z.string().max(512).nullable(), files: z.record(JournalRelativePathSchema, z.string().regex(/^[a-f0-9]{64}$/u)),
  indexUpdatedAt: TimestampSchema,
});
export type ProjectJournalState = z.infer<typeof ProjectJournalStateSchema>;
const request = { schema: z.literal('project-journal-request-v1'), projectId: IdSchema };
export const ProjectJournalRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...request, operation: z.literal('publish'), records: z.array(ProjectJournalRecordSchema).max(100) }),
  z.strictObject({ ...request, operation: z.literal('state') }),
  z.strictObject({ ...request, operation: z.literal('file'), path: JournalRelativePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u), offset: count }),
  z.strictObject({ ...request, operation: z.literal('rebuild') }),
  z.strictObject({ ...request, operation: z.literal('handoff-write'), id: IdSchema, turn: z.number().int().positive(), input: CoordinatorHandoffInputSchema }),
]);
export type ProjectJournalRequest = z.infer<typeof ProjectJournalRequestSchema>;
export const ProjectJournalResultSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('project-journal-result-v1'), operation: z.literal('publish'), accepted: count }),
  z.strictObject({ schema: z.literal('project-journal-result-v1'), operation: z.literal('state'), state: ProjectJournalStateSchema }),
  z.strictObject({ schema: z.literal('project-journal-result-v1'), operation: z.literal('file'), path: JournalRelativePathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u), offset: count, totalBytes: count, base64: z.string().max(350000) }),
  z.strictObject({ schema: z.literal('project-journal-result-v1'), operation: z.literal('rebuild'), state: ProjectJournalStateSchema }),
  z.strictObject({ schema: z.literal('project-journal-result-v1'), operation: z.literal('handoff-write'), handoff: CoordinatorHandoffSchema }),
]);
export type ProjectJournalResult = z.infer<typeof ProjectJournalResultSchema>;
export const JournalRebuildInputSchema = z.strictObject({ schema: z.literal('project-journal-rebuild-v1'), project: z.string().min(1).max(200) });
export const JournalRebuildReceiptSchema = z.strictObject({ schema: z.literal('project-journal-rebuilt-v1'), projectId: IdSchema, files: count, path: z.string().min(1).max(4096) });
