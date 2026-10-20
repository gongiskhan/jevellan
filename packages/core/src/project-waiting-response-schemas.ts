import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { DecisionAnswerRequestSchema, DecisionAnsweredViewSchema } from './project-schemas.js';
import { ProjectPageRequestSchema, ProjectPageViewSchema } from './project-page-schemas.js';

export const ProjectWaitingRespondRequestSchema = z.strictObject({ schema: z.literal('project-waiting-respond-request-v1'),
  answer: DecisionAnswerRequestSchema, view: ProjectPageRequestSchema.omit({ schema: true }).default({ resolvedDays: 14 }) });
export type ProjectWaitingRespondRequest = z.infer<typeof ProjectWaitingRespondRequestSchema>;
export const ProjectWaitingResponseSchema = z.strictObject({ schema: z.literal('project-waiting-response-v1'), receipt: DecisionAnsweredViewSchema,
  page: ProjectPageViewSchema, feedback: z.strictObject({ text: z.string(), known: z.array(IdSchema) }).nullable() });
export type ProjectWaitingResponse = z.infer<typeof ProjectWaitingResponseSchema>;
