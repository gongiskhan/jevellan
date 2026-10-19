import { z } from 'zod';
import { ProjectReviewReportSchema } from './project-review-schemas.js';
import { WorkflowDispatchHandoffSchema, WorkflowHandoffStateSchema, WorkflowInputNameSchema, WorkflowInputsSchema, WorkflowSchedulerSwitchSchema, WorkflowSchedulerStateSchema, WorkflowWatchChainSchema } from './workflow-schemas.js';
import { IdSchema, TimestampSchema } from './schemas.js';
import { ProjectWorkTaskSchema, TaskTypeSchema } from './project-loop-schemas.js';
const revision = z.number().int().nonnegative(), date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), text = z.string().trim().min(1);
export const JobRunSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: text.max(2000), needs: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/u)).max(8).default([]), cwd: z.enum(['checkout', 'workspace']).default('checkout'), timeoutMinutes: z.number().int().min(1).max(240) }),
  z.strictObject({ kind: z.literal('github-workflow'), workflow: text.max(200), mode: z.enum(['watch', 'dispatch']), timeoutMinutes: z.number().int().min(5).max(600),
    inputs: WorkflowInputsSchema.optional(), commitInput: WorkflowInputNameSchema.optional(), dispatchAfterMerge: WorkflowDispatchHandoffSchema.optional(), schedulerSwitch: WorkflowSchedulerSwitchSchema.optional(), watchChain: WorkflowWatchChainSchema.optional(), pinCommitRef: z.boolean().optional(),
    // Explicit evidence requirements, for workflows whose successful scheduling jobs can skip the suite.
    requiredJobs: z.array(text.max(200)).max(20).optional(), requiredSteps: z.array(text.max(200)).max(20).optional() }),
]);
export const ProjectJobSchema = z.strictObject({ schema: z.literal('project-job-v1'), id: IdSchema, projectId: IdSchema, revision,
  name: text.max(80), goalId: IdSchema.nullable(), run: JobRunSpecSchema, gate: z.strictObject({ jobId: IdSchema }).nullable(), enabled: z.boolean(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(), createdAt: TimestampSchema, updatedAt: TimestampSchema });
export type ProjectJob = z.infer<typeof ProjectJobSchema>;
export const ProjectJobRunSchema = z.strictObject({ schema: z.literal('project-job-run-v1'), id: IdSchema, projectId: IdSchema, revision,
  jobId: IdSchema, taskId: IdSchema, commit: z.string().regex(/^[0-9a-f]{40}$/u), deviceId: IdSchema, projectDay: date,
  startedAt: TimestampSchema, endedAt: TimestampSchema.optional(), cleanedAt: TimestampSchema.optional(), conclusion: z.enum(['passed', 'failed', 'timed-out', 'cancelled', 'skipped']).nullable(),
  summary: z.string().max(1200), logTail: z.string().max(8000), url: z.url().optional(), workflowRunId: z.number().int().positive().optional(), workflowHeadBound: z.boolean().optional(),
  dispatchRef: z.string().max(200).optional(), gateRunId: IdSchema.optional(), requestedByDeviceId: IdSchema.optional(), waitingUntil: TimestampSchema.optional(), workspaceRetainedAt: TimestampSchema.optional(),
  phase: z.enum(['waiting', 'reserved', 'executing', 'watching', 'finished']), pollAfter: TimestampSchema.optional(),
  workflowHandoff: WorkflowHandoffStateSchema.optional(), workflowScheduler: WorkflowSchedulerStateSchema.optional(), nightlyWindowId: IdSchema.optional(), workflowCompletedAt: TimestampSchema.optional(), dispatchRefDeletedAt: TimestampSchema.optional(),
  // Snapshot before execution: an edit never changes an already reserved job.
  spec: JobRunSpecSchema, setupCommand: z.string().max(500).nullable().default(null), baseBranch: z.string().min(1).max(200), watchAfter: TimestampSchema });
export type ProjectJobRun = z.infer<typeof ProjectJobRunSchema>;
export const ProjectDailySchema = z.strictObject({ schema: z.literal('project-daily-v1'), id: IdSchema, projectId: IdSchema, revision,
  name: text.max(80), goalId: IdSchema.nullable(), order: z.number().int().min(0).max(100),
  target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('memory-dream') }), z.strictObject({ kind: z.literal('job'), jobId: IdSchema }), z.strictObject({ kind: z.literal('review-since-last'), reviewFromCommit: z.string().regex(/^[0-9a-f]{40}$/u).optional() }), z.strictObject({ kind: z.literal('session'), title: text.max(120), brief: text.max(20000), type: TaskTypeSchema })]),
  reviewFromVersion: revision.default(0), reviewFromOwner: z.boolean().default(false), enabledSince: TimestampSchema.optional(),
  enabled: z.boolean(), requestDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(), createdAt: TimestampSchema, updatedAt: TimestampSchema });
export type ProjectDaily = z.infer<typeof ProjectDailySchema>;
export const ProjectWindowSchema = z.strictObject({ schema: z.literal('project-window-v1'), id: IdSchema, projectId: IdSchema, revision, date, closingProjectDay: date,
  state: z.enum(['open', 'finished']), mergesHeld: z.boolean(), openedAt: TimestampSchema, jobPhaseStartedAt: TimestampSchema.optional(), scheduledAt: TimestampSchema.optional(), openedLateReason: z.string().max(400).optional(), finishedAt: TimestampSchema.optional(), taskIds: z.array(IdSchema).max(50),
  plans: z.array(ProjectWorkTaskSchema).max(50), workflowScheduler: WorkflowSchedulerStateSchema.optional(), outcome: z.string().max(8000).optional(), failed: z.boolean().optional() });
export type ProjectWindow = z.infer<typeof ProjectWindowSchema>;
const jobFields = ProjectJobSchema.omit({ schema: true, id: true, projectId: true, revision: true, createdAt: true, updatedAt: true, requestDigest: true }).shape;
const dailyFields = ProjectDailySchema.omit({ schema: true, id: true, projectId: true, revision: true, createdAt: true, updatedAt: true, requestDigest: true, reviewFromVersion: true, reviewFromOwner: true, enabledSince: true }).shape;
export const JobCreateRequestSchema = z.strictObject({ schema: z.literal('job-create-request-v1'), clientRequestId: IdSchema, ...jobFields });
export const JobUpdateRequestSchema = z.strictObject({ schema: z.literal('job-update-request-v1'), expectedRevision: z.number().int().positive(), ...jobFields });
export const DailyCreateRequestSchema = z.strictObject({ schema: z.literal('daily-create-request-v1'), clientRequestId: IdSchema, ...dailyFields });
export const DailyUpdateRequestSchema = z.strictObject({ schema: z.literal('daily-update-request-v1'), expectedRevision: z.number().int().positive(), ...dailyFields });
export const ProjectRunRequestSchema = z.strictObject({ schema: z.literal('project-run-request-v1'), clientRequestId: IdSchema });
export const ProjectJobListViewSchema = z.strictObject({ schema: z.literal('project-job-list-view-v1'), projectId: IdSchema, jobs: z.array(ProjectJobSchema) });
export const ProjectJobRunListViewSchema = z.strictObject({ schema: z.literal('project-job-run-list-view-v1'), projectId: IdSchema, runs: z.array(ProjectJobRunSchema) });
export const ProjectDailyListViewSchema = z.strictObject({ schema: z.literal('project-daily-list-view-v1'), projectId: IdSchema, projectDay: date, dailies: z.array(ProjectDailySchema),
  jobs: z.array(ProjectJobSchema), runs: z.array(ProjectJobRunSchema), tasks: z.array(ProjectWorkTaskSchema), window: ProjectWindowSchema.nullable(), mergesHeld: z.boolean(), mergeAllowedThreads: z.array(IdSchema).default([]), lastReviewedCommit: z.string().regex(/^[0-9a-f]{40}$/u).nullable().default(null), lastReview: ProjectReviewReportSchema.nullable().default(null) });

export const ProjectJobContextSchema = z.strictObject({ schema: z.literal('project-job-context-v1'), runId: IdSchema, projectId: IdSchema, jobId: IdSchema, commit: z.string().regex(/^[0-9a-f]{40}$/u) });
export type ProjectJobContext = z.infer<typeof ProjectJobContextSchema>;
