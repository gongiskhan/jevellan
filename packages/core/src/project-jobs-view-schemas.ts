import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { ProjectDailySchema, ProjectJobSchema } from './project-daily-schemas.js';

export const DailyEnabledRequestSchema = z.strictObject({ schema: z.literal('daily-enabled-request-v1'), expectedRevision: z.number().int().positive(), enabled: z.boolean() });
export const JobPausedRequestSchema = z.strictObject({ schema: z.literal('job-paused-request-v1'), expectedRevision: z.number().int().positive(), paused: z.boolean() });
const action = z.strictObject({ path: z.string().startsWith('/api/projects/'), enabled: z.boolean(), refusal: z.string().nullable() });
const lastRun = z.strictObject({ summary: z.string(), commitLabel: z.string(), logTail: z.string(), href: z.url().nullable() });
export const ProjectDailyRowSchema = z.strictObject({ definition: ProjectDailySchema, state: z.enum(['disabled', 'done', 'running', 'queued', 'failed', 'not-run']),
  stateLabel: z.string(), kindLabel: z.string(), daysLabel: z.string().nullable(), goalLabel: z.string().nullable(),
  tonight: z.strictObject({ taskId: IdSchema.nullable(), endedAt: TimestampSchema.nullable() }), lastRun: lastRun.nullable(), failure: z.string().nullable(),
  runNow: action, toggle: z.strictObject({ path: z.string().startsWith('/api/projects/'), body: DailyEnabledRequestSchema }) });
export const ProjectJobRowSchema = z.strictObject({ definition: ProjectJobSchema, kindLabel: z.string(), stateLabel: z.string(), gateLabel: z.string().nullable(),
  scheduleLine: z.string().nullable(), runNow: action, pause: z.strictObject({ path: z.string().startsWith('/api/projects/'), label: z.string(), body: JobPausedRequestSchema }).nullable() });
export const ProjectJobsViewSchema = z.strictObject({ schema: z.literal('project-jobs-view-v1'), projectId: IdSchema, timezone: z.string(),
  counts: z.strictObject({ nightly: z.number().int().nonnegative(), goals: z.number().int().nonnegative() }),
  displayDay: z.strictObject({ date: z.string(), label: z.string() }),
  mergeHold: z.strictObject({ held: z.boolean(), allowedThreadIds: z.array(IdSchema), banner: z.string().nullable(), notice: z.string().nullable() }),
  banner: z.strictObject({ windowId: IdSchema, text: z.string() }).nullable(), dailies: z.array(ProjectDailyRowSchema), jobs: z.array(ProjectJobRowSchema),
  lastWindowOutcome: z.string().nullable(), review: z.strictObject({ commitLabel: z.string(), summary: z.string(),
    findings: z.array(z.strictObject({ what: z.string(), detail: z.string(), filesLabel: z.string() })), emptyText: z.string().nullable() }).nullable() });
export type ProjectJobsView = z.infer<typeof ProjectJobsViewSchema>;
