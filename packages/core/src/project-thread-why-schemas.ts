import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
import { PlacementFieldSchema } from './project-schemas.js';

const nullableText = z.string().nullable();
export const ProjectThreadWhyViewSchema = z.strictObject({ schema: z.literal('project-thread-why-view-v1'), projectId: IdSchema, threadId: IdSchema, title: z.string(),
  followup: nullableText, memory: z.strictObject({ summary: z.string(), notes: z.array(z.strictObject({ permalink: z.string(), title: z.string(), reason: z.string() })) }).nullable(),
  placement: z.strictObject({ sourceLabel: z.string(), fixedLine: z.string(), reasonLine: nullableText, constraintsLine: nullableText, fallbackNotice: nullableText }),
  fields: z.array(z.strictObject({ field: PlacementFieldSchema, label: z.string(), sourceLabel: z.string(), valueLabel: z.string(), showValue: z.boolean(),
    mappedEffort: z.strictObject({ requested: z.string(), effective: z.string(), note: z.string() }).nullable(),
    bars: z.array(z.strictObject({ option: z.string(), label: z.string(), p: z.number().min(0).max(1), chosen: z.boolean() })),
    listed: z.array(z.strictObject({ id: z.string(), label: z.string(), chosen: z.boolean() })),
    excluded: z.array(z.strictObject({ id: z.string(), label: z.string(), reason: nullableText })),
  })),
  account: z.strictObject({ label: z.string(), showStandalone: z.boolean(), showCandidates: z.boolean(), retainedMessage: nullableText, notice: nullableText,
    candidates: z.array(z.strictObject({ id: IdSchema, label: z.string(), chosen: z.boolean(), detail: z.string() })) }),
  escalations: z.array(z.strictObject({ at: TimestampSchema, line: z.string() })), devices: z.array(z.strictObject({ id: IdSchema, line: z.string() })),
  task: z.strictObject({ line: z.string(), needsLine: nullableText }).nullable(), corrections: z.array(z.string()),
  jev: z.strictObject({ lines: z.array(z.string()), emptyLine: z.string(), placedAt: TimestampSchema }),
});
export type ProjectThreadWhyView = z.infer<typeof ProjectThreadWhyViewSchema>;
