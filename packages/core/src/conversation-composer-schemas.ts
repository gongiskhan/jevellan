import { z } from 'zod';
import { ComposerChoiceSchema, ComposerInitialSchema } from './composer-schemas.js';
import { IdSchema } from './schemas.js';

export const ConversationComposerRequestSchema = z.strictObject({
  schema: z.literal('conversation-composer-request-v1'), projectId: IdSchema, initial: ComposerInitialSchema,
  choice: ComposerChoiceSchema.optional(),
});
export const ConversationComposerViewSchema = z.strictObject({
  schema: z.literal('conversation-composer-view-v1'), projectId: IdSchema, conversationId: IdSchema.nullable(),
  initial: ComposerInitialSchema, summary: z.string().nullable(),
  fields: z.array(z.strictObject({
    id: z.enum(['action', 'model', 'effort']), label: z.string(), selected: z.string(),
    scope: z.enum(['kept', 'once-then-pin', 'once']).nullable(), scopeLabel: z.string().nullable(),
    options: z.array(z.strictObject({ value: z.string(), label: z.string(), disabled: z.boolean(), choice: ComposerChoiceSchema })),
    keep: ComposerChoiceSchema.nullable(), clear: ComposerChoiceSchema.nullable(),
  })),
});
export type ConversationComposerView = z.infer<typeof ConversationComposerViewSchema>;
