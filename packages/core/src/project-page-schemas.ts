import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { ProjectWorkListViewSchema, ProjectWorkViewSchema, PullRequestEntrySchema } from './project-schemas.js';
import { ProjectWorkTaskSchema } from './project-loop-schemas.js';
import { GoalViewSchema } from './project-goal-schemas.js';
import { ProjectDailyListViewSchema } from './project-daily-schemas.js';

const count = z.number().int().nonnegative();
export const ProjectSidebarViewSchema = ProjectWorkListViewSchema.extend({ schema: z.literal('project-sidebar-view-v1'),
  activeIds: z.array(IdSchema), archivedIds: z.array(IdSchema), waitingTotal: count, defaultProject: IdSchema.nullable() });
export type ProjectSidebarView = z.infer<typeof ProjectSidebarViewSchema>;
const badge = z.strictObject({ text: z.string(), tone: z.enum(['ok', 'danger', 'warn', 'muted']) });
export const OverviewPullRequestSchema = z.strictObject({ entry: PullRequestEntrySchema, taskId: IdSchema.optional(),
  shadow: z.boolean(), held: z.boolean(), conflicts: z.boolean(), checks: badge.nullable(), badges: z.array(badge), mergeRefusal: z.string().nullable() });
export type OverviewPullRequest = z.infer<typeof OverviewPullRequestSchema>;
export const ProjectPageQuerySchema = z.strictObject({ resolvedDays: z.coerce.number().int().min(14).default(14) });
export const ProjectOverviewSchema = z.strictObject({ defaultSurface: z.enum(['chat', 'overview']),
  waiting: z.strictObject({ label: z.string(), emptyText: z.string(), count, isEmpty: z.boolean(), draftIds: z.array(IdSchema), threadIds: z.array(IdSchema) }),
  sections: z.array(z.strictObject({ id: z.enum(['review', 'working', 'landing', 'landed', 'idle', 'resolved']), label: z.string(),
    visible: z.boolean(), emptyText: z.string(), threadIds: z.array(IdSchema), showOlder: z.boolean() })),
  queueCount: count, goalCount: count, nightlyCount: count, showPullRequestsTab: z.boolean(),
  pullRequests: z.array(OverviewPullRequestSchema), recentlyMerged: z.array(OverviewPullRequestSchema) });
export type ProjectOverview = z.infer<typeof ProjectOverviewSchema>;
/** Separate from the compact owner-tool project-status-view-v1. */
export const ProjectPageViewSchema = z.strictObject({ schema: z.literal('project-page-view-v1'), at: TimestampSchema,
  changeToken: z.string().regex(/^[a-f0-9]{64}$/u), work: ProjectWorkViewSchema,
  tasks: z.array(ProjectWorkTaskSchema), goals: z.array(GoalViewSchema), daily: ProjectDailyListViewSchema, overview: ProjectOverviewSchema });
export type ProjectPageView = z.infer<typeof ProjectPageViewSchema>;
