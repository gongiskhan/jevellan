import { z } from 'zod';
import { GitCheckpointPlanSchema, GitSnapshotSchema, IdSchema, ProjectSchema } from './schemas.js';

export const ContextNameSchema = z.enum(['AGENTS.md', 'CLAUDE.md']);
export const ContextFileSchema = z.strictObject({
  name: ContextNameSchema, kind: z.enum(['missing', 'file', 'link']), tracked: z.boolean(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), content: z.string(), target: ContextNameSchema.optional(),
});
export const ContextViewSchema = z.strictObject({
  schema: z.literal('project-context-v1'), projectId: IdSchema,
  state: ProjectSchema.shape.context.shape.state, primary: ContextNameSchema.optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), files: z.tuple([ContextFileSchema, ContextFileSchema]),
  claudeReadsAgents: z.boolean(),
});
export type ContextView = z.infer<typeof ContextViewSchema>;
export const ContextChoiceSchema = z.discriminatedUnion('choice', [
  z.strictObject({ schema: z.literal('context-choice-v1'), fingerprint: z.string(), choice: z.literal('keep-agents') }),
  z.strictObject({ schema: z.literal('context-choice-v1'), fingerprint: z.string(), choice: z.literal('keep-claude') }),
  z.strictObject({ schema: z.literal('context-choice-v1'), fingerprint: z.string(), choice: z.literal('merge'), content: z.string().min(1).max(256_000) }),
  z.strictObject({ schema: z.literal('context-choice-v1'), fingerprint: z.string(), choice: z.literal('leave') }),
]);
export type ContextChoice = z.infer<typeof ContextChoiceSchema>;

export const ContextRequestSchema = z.strictObject({
  schema: z.literal('context-request-v1'), clientRequestId: IdSchema, revision: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  choice: z.enum(['create', 'link', 'keep-agents', 'keep-claude', 'merge', 'leave']), modelId: IdSchema.optional(),
});
export const ContextContinueSchema = z.strictObject({
  schema: z.literal('context-continue-v1'), clientRequestId: IdSchema, operationId: IdSchema,
  generation: z.number().int().nonnegative(), action: z.enum(['apply', 'cancel', 'retry', 'accept-changes']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const ContextOperationSchema = z.strictObject({
  schema: z.literal('context-operation-v1'), id: IdSchema, projectId: IdSchema, conversationId: IdSchema, workId: IdSchema,
  createdAt: z.iso.datetime(), beforeGit: GitSnapshotSchema.optional(),
  request: ContextRequestSchema, before: ContextViewSchema, continuations: z.array(ContextContinueSchema).default([]), approved: z.boolean().default(false),
  status: z.enum(['requested', 'drafting', 'draft-ready', 'applying', 'applied', 'completed', 'cancelled', 'blocked']),
  generation: z.number().int().nonnegative(), modelId: IdSchema.optional(), projectRevision: z.number().int().positive().optional(), beforeHead: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  activityReason: z.string().optional(), checkpointPlan: GitCheckpointPlanSchema.optional(),
  afterFingerprint: z.string().optional(), afterContentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), appliedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  draft: z.string().min(1).max(256_000).optional(), draftRef: z.string().optional(), draftStretch: z.number().int().positive().optional(), applied: z.boolean().default(false), reason: z.string().optional(),
});
export type ContextOperation = z.infer<typeof ContextOperationSchema>;
export const ContextPanelSchema = z.strictObject({ schema: z.literal('context-panel-v1'), context: ContextViewSchema, revision: z.number().int().positive(), operations: z.array(ContextOperationSchema), busy: z.boolean() });

export const ContextReviewSchema = z.strictObject({ schema: z.literal('context-review-v1'), operationId: IdSchema, generation: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), diff: z.string() });
