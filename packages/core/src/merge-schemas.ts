import { z } from 'zod';
import { IdSchema, JevCallSchema, TimestampSchema } from './schemas.js';
import { TaskPlacementContextSchema } from './task-types.js';
const commit = z.string().regex(/^[a-f0-9]{40,64}$/u), revision = z.number().int().nonnegative();
export const MergeRouteNameSchema = z.enum(['merge', 'test-then-merge', 'ask-owner']);
export const MergeRouteStateSchema = z.strictObject({ schema: z.literal('merge-route-state-v1'),
  title: z.string().max(120), task: TaskPlacementContextSchema, summary: z.string().max(4000), riskyAreas: z.string().max(2000),
  files: z.array(z.strictObject({ path: z.string().max(4096), additions: revision, deletions: revision })).max(3000),
  totalSize: revision, corrections: z.array(z.string().max(500)).max(8) });
export const VerificationReportSchema = z.strictObject({ result: z.enum(['passed', 'failed']), commands: z.array(z.string().max(500)).max(50),
  failures: z.array(z.strictObject({ what: z.string().min(1).max(500), output: z.string().max(2000) })).max(50) })
  .refine(report => report.result !== 'passed' || report.failures.length === 0, 'A passing verification cannot have failures.');
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
const identity = { id: IdSchema, projectId: IdSchema, revision, deviceId: IdSchema, threadId: IdSchema, commit, at: TimestampSchema };
export const MergeRouteSchema = z.strictObject({ schema: z.literal('merge-route-v1'), ...identity, prNumber: z.number().int().positive(), questionSet: z.literal('m-v1'),
  route: MergeRouteNameSchema, source: z.enum(['jev', 'unavailable', 'guard']), reason: z.string().max(1200).optional(), packet: MergeRouteStateSchema,
  calls: z.array(JevCallSchema), probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  state: z.enum(['waiting', 'verifying', 'asked', 'merging', 'merged', 'failed']), failures: z.number().int().min(0).max(3),
  notified: z.array(z.string().max(80)).max(12).default([]),
  mergedAt: TimestampSchema.optional(), decisionId: IdSchema.nullable(), verificationId: IdSchema.nullable(), nextAttemptAt: TimestampSchema.optional() });
export type MergeRoute = z.infer<typeof MergeRouteSchema>;
export const MergeCorrectionSchema = z.strictObject({ schema: z.literal('merge-correction-v1'), ...identity, title: z.string().max(120),
  correction: z.enum(['should-have-asked', 'did-not-need-asking']), receivedOrder: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
export const VerificationRunSchema = z.strictObject({ schema: z.literal('verification-run-v1'), ...identity,
  runtime: IdSchema, modelId: IdSchema, model: z.string().min(1), modelLabel: z.string().min(1), providerChoice: z.enum(['other-provider', 'different-model']),
  state: z.enum(['reserved', 'running', 'passed', 'failed']), report: VerificationReportSchema.nullable(), endedAt: TimestampSchema.optional(), note: z.string().max(1200).optional() });
export type VerificationRun = z.infer<typeof VerificationRunSchema>;
export const MergeDocumentSchema = z.discriminatedUnion('schema', [MergeRouteSchema, MergeCorrectionSchema, VerificationRunSchema]);
export type MergeDocument = z.infer<typeof MergeDocumentSchema>;
export const MergeDocumentsViewSchema = z.strictObject({ schema: z.literal('merge-documents-view-v1'), records: z.array(MergeDocumentSchema).max(10000) });
export const MergeCorrectionInputSchema = z.strictObject({ schema: z.literal('merge-correction-input-v1'), clientRequestId: IdSchema,
  commit, correction: MergeCorrectionSchema.shape.correction });
