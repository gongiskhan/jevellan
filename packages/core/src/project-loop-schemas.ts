import { z } from 'zod';
import { EffortSchema, IdSchema, TimestampSchema } from './schemas.js';
import { IsolationSchema } from './project-schemas.js';

export const TaskTypeSchema = z.enum(['feature', 'fix', 'finding', 'refactor', 'docs', 'analysis', 'review', 'ops']);
export const TaskKindSchema = z.enum(['session', 'job']);
export const TaskStateSchema = z.enum(['draft', 'queued', 'active', 'in-review', 'done', 'failed', 'cancelled']);
export const TaskSourceSchema = z.enum(['owner', 'owner-request', 'refill', 'finding', 'daily', 'ekoa']);
export const TaskFixedSchema = z.strictObject({ isolation: IsolationSchema.optional(), runtimeId: IdSchema.optional(), accountId: IdSchema.optional(),
  modelId: IdSchema.optional(), effort: EffortSchema.optional(), deviceId: IdSchema.optional() });
const title = z.string().trim().min(1).max(120), brief = z.string().trim().min(1).max(20000);
const needs = z.array(z.string().regex(/^[a-z0-9-]{1,32}$/u)).max(8), after = z.array(IdSchema).max(10);
/** Separate from the legacy Improver ProjectTaskSchema and namespace (decision 636). */
export const ProjectWorkTaskSchema = z.strictObject({ schema: z.literal('project-work-task-v1'), id: IdSchema, projectId: IdSchema, revision: z.number().int().nonnegative(),
  title, brief, kind: TaskKindSchema, type: TaskTypeSchema, goalId: IdSchema.nullable(), source: TaskSourceSchema, state: TaskStateSchema,
  rank: z.string().min(1).max(64), ownerRanked: z.boolean(), now: z.boolean(), after, needs,
  dailyId: IdSchema.nullable(), jobId: IdSchema.nullable(), threadId: IdSchema.nullable(), jobRunId: IdSchema.nullable(), fixed: TaskFixedSchema,
  placementNote: z.string().max(400).optional(), createdAt: TimestampSchema, updatedAt: TimestampSchema, dispatchedAt: TimestampSchema.optional(), endedAt: TimestampSchema.optional(), endNote: z.string().max(400).optional(),
  // Frozen before the first start. A lost response/restart repeats identical start input.
  dispatchText: z.string().min(1).max(32768).optional(), dispatchBrief: z.string().min(1).max(32768).optional(), requestDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional() });
export type ProjectWorkTask = z.infer<typeof ProjectWorkTaskSchema>;
export const TaskPositionSchema = z.union([z.enum(['top', 'bottom']), z.strictObject({ before: IdSchema }), z.strictObject({ after: IdSchema })]);
export const TaskCreateRequestSchema = z.strictObject({ schema: z.literal('task-create-request-v1'), clientRequestId: IdSchema, title, brief,
  type: TaskTypeSchema.default('feature'), goalId: IdSchema.nullable().default(null), now: z.boolean().default(false), after: after.default([]), needs: needs.default([]), fixed: TaskFixedSchema.default({}), placementNote: z.string().max(400).optional() });
export const TaskUpdateRequestSchema = z.strictObject({ schema: z.literal('task-update-request-v1'), expectedRevision: z.number().int().positive(),
  title: title.optional(), brief: brief.optional(), type: TaskTypeSchema.optional(), goalId: IdSchema.nullable().optional(), after: after.optional(), needs: needs.optional(),
  fixed: TaskFixedSchema.optional(), now: z.boolean().optional(), position: TaskPositionSchema.optional() });
export const TaskActionRequestSchema = z.strictObject({ schema: z.literal('task-action-request-v1'), expectedRevision: z.number().int().positive(),
  action: z.enum(['approve', 'reject', 'cancel', 'now', 'later']), reason: z.string().max(400).optional() });
export const TaskReceiptSchema = z.strictObject({ schema: z.literal('task-receipt-v1'), taskId: IdSchema, state: TaskStateSchema, repeated: z.boolean() });
export const TaskViewSchema = z.strictObject({ schema: z.literal('task-view-v1'), task: ProjectWorkTaskSchema });
export const TaskHistoryEventSchema = z.strictObject({ schema: z.literal('task-history-event-v1'), taskId: IdSchema, projectId: IdSchema, sequence: z.number().int().positive(),
  state: TaskStateSchema, title, at: TimestampSchema, threadId: IdSchema.nullable(), note: z.string().max(400).optional() });
export type TaskHistoryEvent = z.infer<typeof TaskHistoryEventSchema>;
export const TaskListViewSchema = z.strictObject({ schema: z.literal('task-list-view-v1'), projectId: IdSchema, tasks: z.array(ProjectWorkTaskSchema) });
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;
export type TaskUpdateRequest = z.infer<typeof TaskUpdateRequestSchema>;
