import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { ConversationFileSchema } from './conversation-schemas.js';
import { EvidenceReferenceSchema } from './evidence-reference-schemas.js';
import { storedPointer } from './evidence-references.js';
export const EvidenceSourceSwitchingSchema = z.strictObject({ workingLabel: z.string(), workingDisabled: z.boolean(), recordedLabel: z.string(), recordedDisabled: z.boolean() });
export function evidenceSourceSwitching(ref: string, stretch: number | undefined, source: 'step' | 'working-tree' | undefined) {
  return !storedPointer(ref) && stretch ? { workingLabel: 'Open working copy', workingDisabled: source === 'working-tree', recordedLabel: 'Open recorded step', recordedDisabled: source !== 'working-tree' } : null;
}
export const ConversationEvidenceRequestSchema = z.strictObject({ schema: z.literal('conversation-evidence-request-v1'), ref: z.string().min(1), stretch: z.number().int().positive().optional(), source: z.enum(['step', 'working-tree']).default('step'), output: z.boolean().default(false) });
export const EvidenceFilePresentationSchema = z.strictObject({ schema: z.literal('evidence-file-presentation-v1'), sourceLabel: z.string(), initialSource: z.boolean(), linkBase: z.string() });
export type EvidenceFilePresentation = z.infer<typeof EvidenceFilePresentationSchema>;
export const ConversationEvidenceViewSchema = z.strictObject({ schema: z.literal('conversation-evidence-view-v1'), projectId: IdSchema, conversationId: IdSchema, request: ConversationEvidenceRequestSchema, reference: EvidenceReferenceSchema,
  view: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('file'), file: ConversationFileSchema, presentation: EvidenceFilePresentationSchema }), z.strictObject({ kind: z.literal('markdown'), text: z.string() }), z.strictObject({ kind: z.literal('text'), text: z.string() })]),
  switching: EvidenceSourceSwitchingSchema.nullable() });
export type ConversationEvidenceView = z.infer<typeof ConversationEvidenceViewSchema>;
export function evidenceFilePresentation(value: z.infer<typeof ConversationFileSchema>): EvidenceFilePresentation {
  return EvidenceFilePresentationSchema.parse({ schema: 'evidence-file-presentation-v1', sourceLabel: value.source === 'working-tree' ? 'Current working copy · not a saved step' : value.source === 'before-step' ? 'Before this step · file deleted by the step' : 'Recorded checkpoint', initialSource: Boolean(value.line), linkBase: value.path });
}
export function evidenceDocumentView(content: unknown, output: boolean): { kind: 'markdown' | 'text'; text: string } {
  return typeof content === 'string' ? { kind: output ? 'text' : 'markdown', text: content } : { kind: 'text', text: JSON.stringify(content, null, 2) ?? '' };
}
