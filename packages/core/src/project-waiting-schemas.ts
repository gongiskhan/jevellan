import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { DecisionAnswerRequestSchema, ProjectDecisionSchema } from './project-schemas.js';

export const ProjectWaitingItemSchema = z.strictObject({ schema: z.literal('project-waiting-item-v1'), decision: ProjectDecisionSchema,
  number: z.number().int().positive(), source: z.string(), routedTo: z.string(), answerSummary: z.string().nullable(),
  allowsFreeText: z.boolean(), paragraphs: z.array(z.strictObject({ text: z.string(), strong: z.boolean() })).nullable(),
  commandScope: z.strictObject({ decisionId: IdSchema, threadId: IdSchema.optional(), cwd: z.enum(['worktree', 'checkout']), clearDevice: z.boolean() }),
  respondPath: z.string().startsWith('/api/projects/'), requestBase: z.strictObject({ schema: z.literal('decision-answer-request-v1'), expectedRevision: DecisionAnswerRequestSchema.shape.expectedRevision }) });
export type ProjectWaitingItem = z.infer<typeof ProjectWaitingItemSchema>;
export const ProjectWaitingItemsViewSchema = z.strictObject({ schema: z.literal('project-waiting-items-view-v1'), projectId: IdSchema,
  open: z.array(ProjectWaitingItemSchema), answered: z.array(ProjectWaitingItemSchema).max(10), showSent: z.boolean() });
export type ProjectWaitingItemsView = z.infer<typeof ProjectWaitingItemsViewSchema>;
