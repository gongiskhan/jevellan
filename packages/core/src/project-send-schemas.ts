import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
export const OwnerViaSchema = z.string().trim().min(1).max(80).refine(value => !/[\r\n\0]/u.test(value), 'Use one line for the source label.');
export const ProjectSendRequestSchema = z.strictObject({ schema: z.literal('project-send-request-v1'), clientMessageId: IdSchema,
  text: z.string().min(1).max(200000).refine(value => !!value.trim(), 'Write a message.'), via: OwnerViaSchema.optional(), waitSeconds: z.number().int().min(0).max(3600).default(0) });
export const ProjectSendSavedSchema = z.strictObject({ schema: z.literal('project-send-saved-v1'), projectId: IdSchema, at: TimestampSchema,
  input: ProjectSendRequestSchema.omit({ waitSeconds: true }) });
export const CoordinatorReplySchema = z.strictObject({ schema: z.literal('coordinator-reply-v1'), projectId: IdSchema, turn: z.number().int().positive(), reply: z.string().max(200000), at: TimestampSchema });
export const ProjectSendResultSchema = z.strictObject({ schema: z.literal('project-send-result-v1'), projectId: IdSchema, turn: z.number().int().positive().nullable(), reply: z.string().max(200000).nullable(), at: TimestampSchema });
export const COORDINATOR_REPLY_TIMEOUT = 'The coordinator has not answered yet. It keeps working; read the reply in Jevellan.';
