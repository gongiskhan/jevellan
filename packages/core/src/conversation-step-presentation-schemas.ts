import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';

export const RecordedNoticeSchema = z.strictObject({ text: z.string(), action: z.strictObject({ label: z.string(), href: z.string() }).nullable() });
export const ConversationLocationSchema = z.strictObject({ schema: z.literal('conversation-location-v1'), id: IdSchema, projectId: IdSchema, ownerDeviceId: IdSchema });
export const ConversationStepPresentationSchema = z.strictObject({
  schema: z.literal('conversation-step-presentation-v1'),
  statusBadge: z.strictObject({ label: z.string(), tone: z.string(), spinner: z.boolean() }).nullable(),
  corrections: z.array(z.strictObject({ id: IdSchema, text: z.string() })), notices: z.array(RecordedNoticeSchema),
  timing: z.strictObject({ startedAt: TimestampSchema, endedAt: TimestampSchema.nullable(), ticking: z.boolean(), clockStartAt: TimestampSchema.nullable(),
    durationMs: z.number().nonnegative().nullable(), endLabel: z.string(), durationLabel: z.string().nullable() }),
});
export type ConversationStepPresentation = z.infer<typeof ConversationStepPresentationSchema>;
