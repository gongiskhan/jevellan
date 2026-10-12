import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
const commit = z.string().regex(/^[0-9a-f]{40}$/u);
export const ProjectReviewBodySchema = z.strictObject({ summary: z.string().trim().min(1).max(5000), findings: z.array(z.strictObject({ what: z.string().trim().min(1).max(300), detail: z.string().trim().min(1).max(2000), files: z.array(z.string().min(1).max(500)).max(10) })).max(30) });
export type ProjectReviewBody = z.infer<typeof ProjectReviewBodySchema>;
export const ProjectReviewReportSchema = ProjectReviewBodySchema.extend({ schema: z.literal('project-review-report-v1'), projectId: IdSchema, taskId: IdSchema, fromCommit: commit.nullable(), commit, reviewedAt: TimestampSchema, runtime: IdSchema, model: z.string().min(1).max(200) });
export type ProjectReviewReport = z.infer<typeof ProjectReviewReportSchema>;
/** Embedded in the existing versioned task receipt: the completed report is the project's durable review watermark. */
export const ProjectReviewRunSchema = z.strictObject({ schema: z.literal('project-review-run-v1'), sequence: z.number().int().positive(), state: z.enum(['reserved', 'running', 'completed', 'failed']), commit, fromCommit: commit.nullable(),
  deviceId: IdSchema, runtime: IdSchema, modelId: IdSchema, model: z.string().min(1).max(200), modelLabel: z.string().min(1).max(200), majorityProvider: IdSchema.nullable(), selectionBasis: z.string().max(500),
  reviewFromVersion: z.number().int().nonnegative().optional(), startedAt: TimestampSchema, completedAt: TimestampSchema.optional(), report: ProjectReviewReportSchema.nullable(), followupChosen: z.boolean().default(false), fixTaskId: IdSchema.nullable().default(null) }).refine(run => run.state !== 'completed' || !!run.report && !!run.completedAt, 'Completed reviews require a report and completion time.');
export type ProjectReviewRun = z.infer<typeof ProjectReviewRunSchema>;
export const ReviewFollowupInputSchema = z.strictObject({ reviewTaskId: IdSchema, task: z.strictObject({ title: z.string().trim().min(1).max(120), brief: z.string().trim().min(1).max(20000) }).nullable() });
