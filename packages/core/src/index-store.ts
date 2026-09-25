import { z } from 'zod';
import { CorrectionRecordSchema, type CorrectionRecord } from './conversation-schemas.js';
import { ConversationIndexSchema, DecisionIndexSchema, IdSchema, type ConversationIndex } from './schemas.js';

export const IndexDocumentSchema = z.union([ConversationIndexSchema, DecisionIndexSchema, CorrectionRecordSchema]);
export type IndexDocument = z.infer<typeof IndexDocumentSchema>;
export const IndexUpdateSchema = z.strictObject({ schema: z.literal('index-update-v1'), eventId: z.number().int().positive(), document: IndexDocumentSchema });
export type IndexUpdate = z.infer<typeof IndexUpdateSchema>;
export const IndexReceiptSchema = z.strictObject({ schema: z.literal('index-receipt-v1'), id: IdSchema, kind: z.enum(['conversations', 'decisions', 'overrides']), eventId: z.number().int().positive() });
export type IndexReceipt = z.infer<typeof IndexReceiptSchema>;
export const IndexCursorSchema = IndexReceiptSchema.extend({ schema: z.literal('index-cursor-v1'), conversationId: IdSchema, deviceId: IdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export function indexKind(document: IndexDocument): IndexReceipt['kind'] { return document.schema === 'conversation-index-v1' ? 'conversations' : document.schema === 'decision-index-v1' ? 'decisions' : 'overrides'; }
export function indexConversation(document: IndexDocument): string { return document.schema === 'conversation-index-v1' ? document.id : document.conversationId; }
export interface SharedIndexes {
  publish(update: IndexUpdate): IndexReceipt | Promise<IndexReceipt>;
  conversations(): ConversationIndex[] | Promise<ConversationIndex[]>;
  corrections(): CorrectionRecord[] | Promise<CorrectionRecord[]>;
}
const base = { schema: z.literal('index-request-v1') };
export const IndexRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('publish'), update: IndexUpdateSchema }),
  z.strictObject({ ...base, operation: z.enum(['conversations', 'corrections']), after: IdSchema.optional() }),
]);
export const IndexResultSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('index-result-v1'), operation: z.literal('publish'), receipt: IndexReceiptSchema }),
  z.strictObject({ schema: z.literal('index-result-v1'), operation: z.literal('conversations'), records: z.array(ConversationIndexSchema).max(100), next: IdSchema.nullable() }),
  z.strictObject({ schema: z.literal('index-result-v1'), operation: z.literal('corrections'), records: z.array(CorrectionRecordSchema).max(100), next: IdSchema.nullable() }),
]);
