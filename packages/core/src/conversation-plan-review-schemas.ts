import { z } from 'zod';
import { IdSchema } from './schemas.js';

export const ConversationPlanReviewSchema = z.strictObject({ schema: z.literal('conversation-plan-review-v1'), pointer: z.string().min(1), step: z.number().int().positive(), generation: z.number().int().nonnegative(),
  approved: z.boolean(), offered: z.boolean(), status: z.enum(['awaiting-approval', 'approved', 'recorded']), badge: z.string(), domId: z.string(), ariaLabel: z.string(), title: z.string(), intro: z.string().nullable(),
  loading: z.string(), loadFailure: z.string(), retryLabel: z.string(), approveLabel: z.string(), changesLabel: z.string(), feedbackLabel: z.string(), feedbackPlaceholder: z.string(), sendLabel: z.string(), cancelLabel: z.string() });
export type ConversationPlanReview = z.infer<typeof ConversationPlanReviewSchema>;
export const ConversationPlansViewSchema = z.strictObject({ schema: z.literal('conversation-plans-view-v1'), projectId: IdSchema, conversationId: IdSchema, blocked: z.boolean(),
  current: z.strictObject({ pointer: z.string().min(1), step: z.number().int().positive().nullable(), domId: z.string().nullable() }).nullable(), reviews: z.array(ConversationPlanReviewSchema),
  notice: z.strictObject({ text: z.string(), label: z.string(), target: z.string().nullable() }).nullable() });
export type ConversationPlansView = z.infer<typeof ConversationPlansViewSchema>;
