import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { ProjectHealthChecksSchema, ProjectHealthRunSchema } from './project-health-schemas.js';
import { ProjectRelativePathSchema } from './project-parity-schemas.js';
const commit = z.string().regex(/^[a-f0-9]{40}$/u), revision = z.number().int().nonnegative();
export const ProjectDeploySettingsSchema = z.strictObject({ mode: z.enum(['approve', 'automatic']).default('approve'), jobId: IdSchema.nullable().default(null), desktopJobId: IdSchema.nullable().default(null), suiteJobId: IdSchema.nullable().default(null) });
export const DeploymentJobSchema = z.strictObject({ deployId: IdSchema, commandCommit: commit.optional(), mode: z.enum(['deploy', 'rollback', 'desktop']), commit, previousCommit: commit.nullable() });
export type DeploymentJob = z.infer<typeof DeploymentJobSchema>;
export const ProjectDeployJobResultSchema = z.strictObject({ schema: z.literal('project-deploy-job-result-v1'), mode: z.enum(['preflight', 'deploy', 'rollback', 'desktop']), commit,
  previousCommit: commit.nullable(), rollbackAvailable: z.boolean(), releaseStarted: z.boolean().default(false), released: z.boolean(), migrationChanged: z.boolean(),
  desktop: z.strictObject({ state: z.enum(['built', 'skipped', 'failed']), reason: z.string().max(1000).optional() }).optional(), missing: z.array(z.string().max(200)).max(100), summary: z.string().max(1200) }).superRefine((value, ctx) => {
    if (['preflight', 'desktop'].includes(value.mode) && (value.released || value.releaseStarted)) ctx.addIssue({ code: 'custom', message: 'This job mode cannot release.' });
    if ((value.mode === 'desktop') !== !!value.desktop) ctx.addIssue({ code: 'custom', message: 'Desktop jobs need a desktop result.' });
    if (value.rollbackAvailable && !value.previousCommit) ctx.addIssue({ code: 'custom', message: 'Rollback needs a known previous commit.' });
  });
export const ProjectDeployBaselineSchema = z.strictObject({ schema: z.literal('project-deploy-baseline-v1'), id: IdSchema, projectId: IdSchema, revision,
  commit: commit.nullable(), rollbackAvailable: z.boolean(), migrationPaths: z.array(ProjectRelativePathSchema).max(30).default([]),
  desktopPaths: z.array(ProjectRelativePathSchema).max(30).default([]), desktopSecretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u)).max(30).default([]), desktopSecretAlternatives: z.array(z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u)).min(1).max(20)).max(10).default([]), updatedAt: TimestampSchema });
export type ProjectDeployBaseline = z.infer<typeof ProjectDeployBaselineSchema>;
const healthResult = z.strictObject({ checkId: IdSchema, passed: z.boolean() });
export const ProjectDeploySchema = z.strictObject({ schema: z.literal('project-deploy-v1'), id: IdSchema, projectId: IdSchema, revision,
  timezone: z.string().min(1).max(100).default('UTC').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid timezone.'),
  state: z.enum(['open', 'approved', 'running', 'deployed', 'failed', 'rolled-back']), commit, previousCommit: commit.nullable(),
  threads: z.array(z.strictObject({ threadId: IdSchema, title: z.string().max(120), landingCommit: commit })).max(1000),
  suite: z.strictObject({ commit, conclusion: z.enum(['passed', 'failed']).nullable(), runId: IdSchema.optional() }),
  health: z.strictObject({ before: z.array(healthResult).max(20), after: z.array(healthResult).max(100) }),
  messageHealth: z.array(ProjectHealthRunSchema).max(10).default([]), supersedes: IdSchema.optional(), rollbackNotice: z.string().max(1200).optional(),
  releaseUncertain: z.boolean().default(false), checks: ProjectHealthChecksSchema, rollbackAvailable: z.boolean(), migrationChanged: z.boolean().default(false),
  rollback: z.strictObject({ at: TimestampSchema, reason: z.enum(['health', 'owner']), toCommit: commit, jobRunId: IdSchema, result: z.enum(['done', 'failed']), failure: z.string().max(1200).optional() }).optional(),
  decisionId: IdSchema, notNowAt: TimestampSchema.optional(), createdAt: TimestampSchema, updatedAt: TimestampSchema, approvedAt: TimestampSchema.optional(), jobRunId: IdSchema.optional(), deployedAt: TimestampSchema.optional(), failure: z.string().max(1200).optional(),
  healthBeforeJobRunId: IdSchema.optional(), desktopPlan: z.strictObject({ state: z.enum(['not-needed', 'waiting', 'skipped']), reason: z.string().max(1000).optional() }).optional(),
  jobTaskId: IdSchema.optional(), desktopTaskId: IdSchema.optional(), desktopJobRunId: IdSchema.optional(),
  desktop: z.strictObject({ state: z.enum(['not-needed', 'waiting', 'built', 'skipped', 'failed']), reason: z.string().max(1000).optional() }).optional(),
  monitor: z.strictObject({ stage: z.enum(['one', 'five', 'repeat-one', 'repeat-five', 'rollback-one', 'rollback-five', 'rollback-repeat-one', 'rollback-repeat-five']), dueAt: TimestampSchema, repeatIds: z.array(IdSchema).max(10).default([]) }).optional(),
  rollbackPending: z.strictObject({ reason: z.enum(['health', 'owner']), checkName: z.string().max(80), taskId: IdSchema, jobRunId: IdSchema, at: TimestampSchema }).optional(),
  rollbackDecisionId: IdSchema.optional(), failureDecisionId: IdSchema.optional(), notified: z.array(z.string().max(100)).max(100).default([]),
  answers: z.array(z.strictObject({ id: IdSchema, decisionId: IdSchema, optionLabel: z.string().max(120).optional(), text: z.string().max(20000).optional(), digest: z.string().regex(/^[a-f0-9]{64}$/u), closed: z.boolean() })).max(1000).default([]),
});
export type ProjectDeploy = z.infer<typeof ProjectDeploySchema>;
export const ProjectDeployViewSchema = z.strictObject({ schema: z.literal('project-deploy-view-v1'), projectId: IdSchema, records: z.array(ProjectDeploySchema).max(10000), baseline: ProjectDeployBaselineSchema.nullable() });
export const DeployRollbackRequestSchema = z.strictObject({ schema: z.literal('project-deploy-rollback-request-v1'), clientRequestId: IdSchema, expectedRevision: revision });
export const DeployBaselineRequestSchema = ProjectDeployBaselineSchema.omit({ schema: true, id: true, projectId: true, revision: true, updatedAt: true }).extend({ schema: z.literal('project-deploy-baseline-request-v1'), expectedRevision: revision });
