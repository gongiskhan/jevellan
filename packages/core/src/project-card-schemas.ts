import { z } from 'zod';
import { IdSchema } from './schemas.js';

export const ThreadMutationActionSchema = z.enum(['fix-checks', 'resolve-conflicts', 'address-comments', 'publish', 'land-now', 'land-instead', 'resolve', 'reopen']);
export const ProjectBadgeSchema = z.strictObject({ text: z.string(), tone: z.enum(['ok', 'danger', 'warn', 'muted', 'jev', 'plain']) });
export const MergeConfirmationSchema = z.strictObject({ title: z.string(), actionLabel: z.string(), body: z.string() });
const actionFields = { label: z.string(), enabled: z.boolean(), refusal: z.string().nullable(), secondary: z.boolean(), help: z.string().nullable() };
export const ThreadActionItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...actionFields, kind: z.literal('mutation'), id: ThreadMutationActionSchema, confirmation: MergeConfirmationSchema.nullable() }),
  z.strictObject({ ...actionFields, kind: z.literal('merge'), id: z.literal('merge'), confirmation: MergeConfirmationSchema }),
  z.strictObject({ ...actionFields, kind: z.literal('link'), id: z.literal('open-pr'), href: z.url() }),
]);
export type ThreadActionItem = z.infer<typeof ThreadActionItemSchema>;
export const ProjectThreadActionsViewSchema = z.strictObject({ schema: z.literal('project-thread-actions-view-v1'), projectId: IdSchema, threadId: IdSchema,
  items: z.array(ThreadActionItemSchema), mergeConfirmation: MergeConfirmationSchema.nullable() });
export type ProjectThreadActionsView = z.infer<typeof ProjectThreadActionsViewSchema>;
export const TaskCardOperationSchema = z.strictObject({ path: z.string().startsWith('/api/projects/'), body: z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal('task-action-request-v1'), expectedRevision: z.number().int().positive(), action: z.enum(['approve', 'reject']), reason: z.string().optional() }),
  z.strictObject({ schema: z.literal('task-update-request-v1'), expectedRevision: z.number().int().positive(), held: z.literal(false) }),
]) });
export type TaskCardOperation = z.infer<typeof TaskCardOperationSchema>;
export const ProjectWorkCardSchema = z.strictObject({ schema: z.literal('project-work-card-v1'), id: IdSchema, kind: z.enum(['thread', 'task']), title: z.string(), href: z.string().startsWith('/projects/'),
  group: z.enum(['waiting', 'review', 'working', 'landing', 'landed', 'idle', 'resolved']).nullable(), label: z.string(), meta: z.string().nullable(),
  stateLabel: z.string().nullable(), outcome: z.string().nullable(), threadMeta: z.string().nullable(), placementLine: z.string().nullable(),
  chips: z.array(ProjectBadgeSchema), headerBadges: z.array(ProjectBadgeSchema), landingLabel: z.string().nullable(), showLandingWhy: z.boolean(),
  pr: z.strictObject({ number: z.number().int().positive(), url: z.url(), checks: ProjectBadgeSchema, conflicts: z.boolean() }).nullable(), mergedOutcome: z.string().nullable(),
  threadActions: ProjectThreadActionsViewSchema.nullable(), taskStart: TaskCardOperationSchema.nullable(), taskDismiss: TaskCardOperationSchema.nullable() });
export type ProjectWorkCard = z.infer<typeof ProjectWorkCardSchema>;
