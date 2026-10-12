import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { HubMemoryScopeSchema, MemoryEditSchema, MemoryNoteSchema, MemoryProvenanceSchema, MemorySearchSchema, MemoryWriteSchema } from './memory-note-schemas.js';
export * from './memory-note-schemas.js';

const count = z.number().int().nonnegative();
const commit = z.string().regex(/^[0-9a-f]{40,64}$/u);
export const MemoryCaptureSchema = z.strictObject({ schema: z.literal('memory-capture-v1'), id: IdSchema, projectId: IdSchema,
  scope: z.enum(['coordinator', 'thread', 'review', 'verification', 'attached']), threadId: IdSchema.optional(), taskId: IdSchema.optional(),
  runtime: z.string().min(1).max(200), model: z.string().min(1).max(200), sessionId: z.string().min(1).max(256), transcriptPath: z.string().min(1).max(4096),
  fromByte: count, toByte: count, fragment: z.strictObject({ index: count, count: z.number().int().positive() }).optional(), at: TimestampSchema, processedAt: TimestampSchema.nullable(), extractionId: IdSchema.nullable() })
  .refine(value => value.toByte >= value.fromByte, 'Capture byte ranges must be ordered.')
  .refine(value => !value.fragment || value.fragment.index < value.fragment.count, 'Capture fragments must have a valid index.');
export type MemoryCapture = z.infer<typeof MemoryCaptureSchema>;
export const MemoryInboxInputSchema = z.strictObject({ title: z.string().min(1).max(120), body: z.string().min(1).max(1500),
  kind: z.enum(['how-to', 'gotcha', 'convention', 'decision', 'preference', 'fact']),
  evidence: z.strictObject({ threadId: IdSchema.optional(), taskId: IdSchema.optional(), quote: z.string().max(300) }) });
export type MemoryInboxInput = z.infer<typeof MemoryInboxInputSchema>;
export const MemoryDreamBodySchema = z.strictObject({ summary: z.string().min(1).max(1500) });
export const MemoryArchiveInputSchema = z.strictObject({ note: z.string().min(1).max(1024), reason: z.string().min(1).max(300) });
export const MemoryDreamReportSchema = z.strictObject({ schema: z.literal('memory-dream-report-v1'), projectId: IdSchema, dreamId: IdSchema, at: TimestampSchema,
  fromCommit: commit, toCommit: commit, mainCommit: commit,
  counts: z.strictObject({ inboxPromoted: count, inboxDropped: count, merged: count, corrected: count, archived: count, created: count }),
  briefUpdated: z.boolean(), summary: z.string().max(1500), changes: z.array(z.strictObject({ note: z.string().min(1).max(1024),
    action: z.enum(['created', 'updated', 'merged', 'archived', 'dropped']), reason: z.string().max(300) })).max(200) });
export type MemoryDreamReport = z.infer<typeof MemoryDreamReportSchema>;
export const MemoryDreamStateSchema = z.strictObject({ schema: z.literal('memory-dream-state-v1'), projectId: IdSchema, id: IdSchema,
  mode: z.enum(['apply', 'suggest']), state: z.enum(['running', 'suggested', 'applied', 'undone', 'failed']),
  startedAt: TimestampSchema, completedAt: TimestampSchema.optional(), fromCommit: commit, mainCommit: commit,
  report: MemoryDreamReportSchema.nullable(), diff: z.string().max(1_000_000), reason: z.string().max(1200).optional(),
  provenance: MemoryProvenanceSchema, previousMainCommit: commit.nullable().default(null), applyId: IdSchema.optional(), undoCommit: commit.optional() });
export type MemoryDreamState = z.infer<typeof MemoryDreamStateSchema>;
export const ProjectMemoryViewSchema = z.strictObject({ schema: z.literal('project-memory-view-v1'), projectId: IdSchema,
  notes: z.array(MemoryNoteSchema).max(1000), inbox: z.array(MemoryNoteSchema).max(1000), dream: MemoryDreamStateSchema.nullable(), truncated: z.boolean().default(false), notice: z.string().max(1500).nullable().default(null) });

const request = { schema: z.literal('project-memory-request-v1'), projectId: IdSchema, scope: HubMemoryScopeSchema, ownerSession: z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).optional() };
export const ProjectMemoryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...request, operation: z.literal('search'), query: z.string().min(1).max(20000) }),
  z.strictObject({ ...request, operation: z.literal('read'), permalink: z.string().min(1).max(1024) }),
  z.strictObject({ ...request, operation: z.literal('find-title'), title: z.string().min(1).max(300) }),
  z.strictObject({ ...request, operation: z.enum(['sync', 'view']) }),
  z.strictObject({ ...request, operation: z.literal('write'), input: MemoryWriteSchema, requestId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('edit'), input: MemoryEditSchema, requestId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('archive'), input: MemoryArchiveInputSchema, requestId: IdSchema }),
  z.strictObject({ ...request, operation: z.literal('capture'), capture: MemoryCaptureSchema, text: z.string().max(300_000) }),
  z.strictObject({ ...request, operation: z.enum(['dream-run', 'dream-apply', 'dream-undo', 'dream-discard']), requestId: IdSchema.optional() }),
  z.strictObject({ ...request, operation: z.literal('import'), requestId: IdSchema, sourcePath: z.string().min(1).max(4096),
    files: z.array(z.strictObject({ path: z.string().min(1).max(1024), content: z.string().max(1_400_000) })).max(5), final: z.boolean() }),
]);
export type ProjectMemoryRequest = z.infer<typeof ProjectMemoryRequestSchema>;
export const ProjectMemoryResultSchema = z.discriminatedUnion('schema', [
  MemorySearchSchema, MemoryNoteSchema, ProjectMemoryViewSchema,
  z.strictObject({ schema: z.literal('memory-found-v1'), note: MemoryNoteSchema.nullable() }),
  z.strictObject({ schema: z.literal('memory-operation-v1'), accepted: z.literal(true) }),
  MemoryDreamStateSchema,
]);
export type ProjectMemoryResult = z.infer<typeof ProjectMemoryResultSchema>;
export const MemoryCaptureCursorSchema = z.strictObject({ schema: z.literal('memory-capture-cursor-v1'), sessionId: z.string().min(1),
  transcriptPath: z.string(), byte: count });
export const MemoryExtractionStateSchema = z.strictObject({ schema: z.literal('memory-extraction-state-v1'), projectId: IdSchema,
  id: IdSchema, state: z.enum(['running', 'completed', 'failed']), at: TimestampSchema, captureIds: z.array(IdSchema),
  retries: count, reason: z.string().max(1200).optional() });
export const MemoryImportSchema = z.strictObject({ schema: z.literal('memory-import-v1'), projectId: IdSchema,
  sourcePath: z.string(), at: TimestampSchema, files: count });
export const MemoryDreamRunReceiptSchema = z.strictObject({ schema: z.literal('memory-dream-run-receipt-v1'), id: IdSchema, accepted: z.literal(true) });
export const MemoryDreamRequestSchema = z.strictObject({ schema: z.literal('memory-dream-request-v1'), id: IdSchema, projectId: IdSchema,
  state: z.enum(['pending', 'started', 'finished']), at: TimestampSchema, sessionId: IdSchema.optional(), reason: z.string().max(1200).optional() });
export const MemoryDreamWatermarkSchema = z.strictObject({ schema: z.literal('memory-dream-watermark-v1'), projectId: IdSchema, commit: commit.nullable() });
