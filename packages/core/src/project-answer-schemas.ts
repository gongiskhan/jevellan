import {z} from 'zod';

// 5.9 answer
export const DecisionAnswerFieldsSchema = z.strictObject({ optionLabel: z.string().max(120).optional(), text: z.string().max(4000).optional() });
export const DECISION_ANSWER_REQUIRED = 'Choose an option or write an answer.';
export function answerPresent(answer: { optionLabel?: string | undefined; text?: string | undefined }): boolean {
  return !!answer.optionLabel || !!answer.text;
}
export const DecisionAnswerSchema = DecisionAnswerFieldsSchema.extend({
  // Missing on historical answers; all new answers name their source.
  source: z.enum(['panel', 'owner-chat']).optional(), ownerMessage: z.string().min(1).optional(),
}).refine(answerPresent, DECISION_ANSWER_REQUIRED)
  .refine(answer => answer.source !== 'owner-chat' || !!answer.ownerMessage, 'A chat answer needs the owner message.');
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;
