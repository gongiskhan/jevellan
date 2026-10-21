import { z } from 'zod';
import { TimestampSchema } from './schemas.js';

export const ImproverCardPresentationSchema = z.strictObject({
  schema: z.literal('improver-card-presentation-v1'),
  evidence: z.strictObject({ summary: z.string(), entries: z.array(z.strictObject({
    id: z.string(), at: TimestampSchema.nullable(), label: z.string(), detail: z.string().nullable(),
    action: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('conversation'), href: z.string() }), z.strictObject({ kind: z.literal('note'), permalink: z.string() })]),
  })) }),
  check: z.strictObject({ summary: z.string(), simulatedNotice: z.string().nullable(), cases: z.array(z.strictObject({ id: z.string(), text: z.string() })) }).nullable(),
});
export const RoutingPreviewPresentationSchema = z.strictObject({ schema: z.literal('routing-preview-presentation-v1'), diff: z.string(), checkSummary: z.string(), simulatedNotice: z.string().nullable() });
