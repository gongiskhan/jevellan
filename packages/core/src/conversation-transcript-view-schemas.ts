import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { CursorTurnSchema } from './cursor-schemas.js';
export const ConversationTranscriptSourceSchema = z.strictObject({ step: z.number().int().positive(), tail: z.number().int().nonnegative(), running: z.boolean() });
export const ConversationTranscriptRequestSchema = z.strictObject({ schema: z.literal('conversation-transcript-request-v1'), step: z.number().int().positive() });
export const ConversationTranscriptViewSchema = z.strictObject({ schema: z.literal('conversation-transcript-view-v1'), projectId: IdSchema, conversationId: IdSchema, step: z.number().int().positive(), tail: z.number().int().nonnegative(), head: z.number().int().nonnegative(), running: z.boolean(), summary: z.string().nullable(),
  turns: z.array(CursorTurnSchema), activity: z.array(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('response'), id: z.string(), turnId: z.string() }), z.strictObject({ kind: z.literal('tools'), id: z.string(), turnIds: z.array(z.string()) })])), answerIds: z.array(z.string()), fallbackAnswer: z.string().nullable(), hiddenNoticeIds: z.array(z.number().int().positive()) });
export type ConversationTranscriptView = z.infer<typeof ConversationTranscriptViewSchema>;
