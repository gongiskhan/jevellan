import { z } from 'zod';

/** Presentation metadata is independent of native blocks, keeping the native transcript schema acyclic. */
export const TranscriptTurnPresentationSchema = z.strictObject({ schema: z.literal('transcript-turn-presentation-v1'),
  label: z.string().nullable(), collapsed: z.boolean(), preview: z.string(),
  groups: z.array(z.strictObject({ preview: z.string(), countLabel: z.string(), waitingSuffix: z.string(),
    calls: z.array(z.strictObject({ stateLabel: z.string(), files: z.array(z.string()), noResultText: z.string().nullable() })) })) });
export type TranscriptTurnPresentation = z.infer<typeof TranscriptTurnPresentationSchema>;
