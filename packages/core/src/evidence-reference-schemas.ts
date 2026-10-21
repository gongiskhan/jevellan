import { z } from 'zod';
export const EvidenceReferenceSchema = z.strictObject({ schema: z.literal('evidence-reference-v1'), kind: z.enum(['pointer', 'file', 'url', 'text']), value: z.string() });
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export const EvidenceReferencesViewSchema = z.strictObject({ schema: z.literal('evidence-references-view-v1'), entries: z.array(z.strictObject({ stretch: z.number().int().positive(), reference: EvidenceReferenceSchema })) });
