import { z } from 'zod';
export const MessageDeliveryViewSchema = z.strictObject({ schema: z.literal('message-delivery-view-v1'), canSend: z.boolean(), canSteer: z.boolean(), canQueue: z.boolean(), reason: z.string().nullable(), primaryLabel: z.string(), primaryTitle: z.string(), primaryEnabled: z.boolean(), queueLabel: z.string(), queueTitle: z.string(), queueEnabled: z.boolean() });
export type MessageDeliveryView = z.infer<typeof MessageDeliveryViewSchema>;
export const BranchChangeViewSchema = z.strictObject({ schema: z.literal('branch-change-view-v1'), title: z.string(), from: z.string(), to: z.literal('main'), text: z.string(), body: z.string() });
export type BranchChangeView = z.infer<typeof BranchChangeViewSchema>;
export const ChangesDiffRowSchema = z.strictObject({ line: z.string(), kind: z.enum(['hunk', 'addition', 'removal', 'context', 'meta']), before: z.number().int().nonnegative().optional(), after: z.number().int().nonnegative().optional() });
export const ChangesDiffViewSchema = z.strictObject({ schema: z.literal('changes-diff-view-v1'), empty: z.boolean(), emptyLabel: z.string(), sections: z.array(z.strictObject({ path: z.string(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), rows: z.array(ChangesDiffRowSchema) })) });
export type ChangesDiffView = z.infer<typeof ChangesDiffViewSchema>;
