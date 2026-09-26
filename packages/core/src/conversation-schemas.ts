import { z } from 'zod';
import { ConversationIndexSchema } from './schemas.js';
import { ComposerInitialSchema, ComposerOverrideRecordSchema } from './composer-schemas.js';
import { ActionSchema, ConversationSchema, DecisionRecordSchema, EffortSchema, GitCheckpointPlanSchema, GitSnapshotSchema, GitUndoPlanSchema, GitUndoResultSchema, HandoffSchema, IdSchema, JevCallSchema, LedgerEventSchema, ProjectSchema, StretchSchema, SummarySchema, VerificationSchema, WorkControlSchema, WorkSchema } from './schemas.js';

export const ProjectWriteSchema = z.strictObject({ schema: z.literal('project-write-v1'), clientRequestId: IdSchema.optional(), revision: z.number().int().nonnegative(), project: ProjectSchema, createContext: z.boolean().optional() });
export const ProjectViewSchema = z.strictObject({ schema: z.literal('project-view-v1'), revision: z.number().int().positive(), project: ProjectSchema });
export const ProjectsListSchema = z.strictObject({ schema: z.literal('projects-list-v1'), projects: z.array(ProjectViewSchema) });
export const ProjectFoldersSchema = z.strictObject({ schema: z.literal('project-folders-v1'), path: z.string(), parent: z.string().nullable(), folders: z.array(z.strictObject({ name: z.string(), path: z.string() })) });
export const ProjectVisibilitySchema = z.strictObject({ schema: z.literal('project-visibility-v1'), projectId: IdSchema, deviceId: IdSchema, visibility: z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL', 'UNKNOWN']), checkedAt: z.iso.datetime() });
export const StartConversationSchema = z.strictObject({ schema: z.literal('start-conversation-v1'), id: IdSchema, projectId: IdSchema, title: z.string().min(1).max(200), message: z.string().min(1).max(100_000), clientMessageId: IdSchema, choices: ComposerInitialSchema.optional() });
export const ConversationMessageSchema = z.strictObject({ schema: z.literal('conversation-message-v1'), clientMessageId: IdSchema, text: z.string().min(1).max(100_000), kind: z.enum(['message', 'note']).default('message') });
export const RenameConversationSchema = z.strictObject({ schema: z.literal('rename-conversation-v1'), clientRequestId: IdSchema, previousTitle: z.string().min(1), title: z.string().trim().min(1).max(200) });
export const ConversationRenamedSchema = z.strictObject({ schema: z.literal('conversation-renamed-v1'), request: RenameConversationSchema });
export const FinishOutsideSchema = z.strictObject({ schema: z.literal('finish-outside-v1'), clientRequestId: IdSchema, generation: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(2000).optional() });
export const FinishOutsideOperationSchema = z.strictObject({ schema: z.literal('finish-outside-operation-v1'), request: FinishOutsideSchema, workId: IdSchema.nullable(), status: z.enum(['requested', 'completed', 'blocked']), retained: z.boolean().optional(), reason: z.string().optional() }).refine((value) => value.status !== 'completed' || value.retained !== undefined, 'Completion must record checkout retention.');
export type FinishOutsideOperation = z.infer<typeof FinishOutsideOperationSchema>;
/** Records who started a conversation when that was not known at creation (conversations from before the field existed). */
export const ConversationOriginSchema = z.strictObject({ schema: z.literal('conversation-origin-v1'), origin: z.enum(['context-operation']) });
export const ConversationControlSchema = z.union([ConversationRenamedSchema, FinishOutsideOperationSchema, ConversationOriginSchema]);
export const ManualStepSchema = z.strictObject({ schema: z.literal('manual-step-v1'), generation: z.number().int().nonnegative(), action: ActionSchema.exclude(['integrate']), modelId: IdSchema.optional(), effort: EffortSchema.optional(), remember: z.boolean().default(false) });
export type ManualStep = z.infer<typeof ManualStepSchema>;
export const ExternalActivityWaitSchema = z.strictObject({ schema: z.literal('external-activity-wait-v1'), id: IdSchema, workId: IdSchema, generation: z.number().int().nonnegative(), choice: ManualStepSchema, source: z.enum(['manual', 'automatic']) });
export const HubWaitSchema = z.strictObject({
  schema: z.literal('hub-wait-v1'), id: IdSchema, workId: IdSchema, generation: z.number().int().nonnegative(),
  boundary: z.enum(['decision', 'launch', 'checkpoint', 'settings', 'account-report', 'memory', 'publication', 'publication-release', 'checkout-release', 'integration-abort', 'settlement', 'undo', 'context']), status: z.enum(['waiting', 'completed', 'interrupted']),
  message: z.string().min(1), at: z.iso.datetime(),
  checkpoint: z.strictObject({ stretch: z.number().int().positive(), before: GitSnapshotSchema }).optional(),
});
export type HubWait = z.infer<typeof HubWaitSchema>;
export const RetryExternalActivitySchema = z.strictObject({ schema: z.literal('retry-external-activity-v1'), waitId: IdSchema, generation: z.number().int().nonnegative() });
export const DecisionWaitSchema = z.strictObject({ schema: z.literal('decision-wait-v1'), workId: IdSchema, generation: z.number().int().nonnegative(),
  kind: z.enum(['jev-unavailable', 'no-eligible-model', 'choice-unavailable']), text: z.string().min(1), calls: z.array(JevCallSchema),
  reasons: z.array(z.strictObject({ modelId: IdSchema, reason: z.string(), accountIds: z.array(IdSchema) })).default([]) });
export type DecisionWait = z.infer<typeof DecisionWaitSchema>;
export const ResumeDecisionSchema = z.strictObject({ schema: z.literal('resume-decision-v1'), generation: z.number().int().nonnegative() });
export const StepChoicesSchema = z.strictObject({ action: ActionSchema.exclude(['integrate']).optional(), modelId: IdSchema.optional(), effort: EffortSchema.optional() }).refine((value) => Object.values(value).some((entry) => entry !== undefined), 'Choose a field to correct.');
export const CorrectStepSchema = z.strictObject({ schema: z.literal('correct-step-v1'), clientRequestId: IdSchema, generation: z.number().int().nonnegative(), stretch: z.number().int().positive(), mode: z.enum(['noted', 'redo']), choices: StepChoicesSchema });
export const OverrideRecordSchema = z.strictObject({
  schema: z.literal('override-v1'), id: IdSchema, request: CorrectStepSchema, conversationId: IdSchema, workId: IdSchema, projectId: IdSchema, decisionId: IdSchema,
  at: z.iso.datetime(), action: ActionSchema, context: z.string().min(1),
  changes: z.array(z.discriminatedUnion('field', [
    z.strictObject({ field: z.literal('action'), from: ActionSchema, to: ActionSchema.exclude(['integrate']) }),
    z.strictObject({ field: z.literal('model'), from: IdSchema, to: IdSchema }),
    z.strictObject({ field: z.literal('effort'), from: EffortSchema, to: EffortSchema }),
  ])).min(1),
});
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;
export const CorrectionRecordSchema = z.union([OverrideRecordSchema, ComposerOverrideRecordSchema]);
export type CorrectionRecord = z.infer<typeof CorrectionRecordSchema>;
export const CorrectionsReadSchema = z.strictObject({ schema: z.literal('corrections-read-v1'), ids: z.array(IdSchema).max(8) });
export const CorrectionsListSchema = z.strictObject({ schema: z.literal('corrections-list-v1'), records: z.array(CorrectionRecordSchema).max(8) });
export const RetryRedoSchema = z.strictObject({ schema: z.literal('retry-redo-v1'), clientRequestId: IdSchema, id: IdSchema, generation: z.number().int().nonnegative() });
export const RedoOperationSchema = z.strictObject({ schema: z.literal('redo-operation-v1'), id: IdSchema, workId: IdSchema,
  followingWorkId: IdSchema.optional(),
  status: z.enum(['requested', 'prepared', 'git-applied', 'applied', 'completed', 'blocked']),
  generation: z.number().int().nonnegative(), fromStretch: z.number().int().positive(), throughStretch: z.number().int().positive().optional(),
  plan: GitUndoPlanSchema.optional(), result: GitUndoResultSchema.optional(), reason: z.string().optional(), retries: z.array(RetryRedoSchema).default([]), needsReconciliation: z.boolean().optional(),
});
export type RedoOperation = z.infer<typeof RedoOperationSchema>;
export const PlanApprovalSchema = z.strictObject({ schema: z.literal('plan-approval-v1'), generation: z.number().int().nonnegative(), ref: z.string().min(1) });
export const SettleWorkSchema = z.strictObject({ schema: z.literal('settle-work-v1'), clientRequestId: IdSchema, workId: IdSchema, generation: z.number().int().nonnegative(), choice: z.enum(['publish', 'keep', 'discard']) });
export const WorkSettlementSchema = z.strictObject({
  schema: z.literal('work-settlement-v1'), id: IdSchema, workId: IdSchema, choice: SettleWorkSchema.shape.choice,
  status: z.enum(['requested', 'completed', 'blocked']), closedAs: z.enum(['cancelled', 'closed-by-you']), reclose: z.boolean(),
  before: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), savedRef: z.string().optional(), retained: z.boolean().optional(), reason: z.string().optional(),
});
export const CheckpointBlockSchema = z.strictObject({ schema: z.literal('checkpoint-block-v1'), workId: IdSchema, stretch: z.number().int().positive(), reason: z.string().min(1), before: GitSnapshotSchema.optional() });
export const CheckpointReviewSchema = z.strictObject({ schema: z.literal('checkpoint-review-v1'), mode: z.enum(['checkpoint', 'acknowledge']).default('checkpoint'), generation: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason: z.string().optional() });
export const AdoptChangesSchema = z.strictObject({ schema: z.literal('adopt-changes-v1'), clientRequestId: IdSchema, workId: IdSchema, stretch: z.number().int().positive(), generation: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const CheckpointAdoptionSchema = z.strictObject({
  schema: z.literal('checkpoint-adoption-v1'), mode: z.enum(['checkpoint', 'acknowledge']).default('checkpoint'), request: AdoptChangesSchema, blocks: z.array(z.number().int().positive()).min(1),
  status: z.enum(['requested', 'prepared', 'completed', 'blocked']), plan: GitCheckpointPlanSchema.optional(), reason: z.string().optional(),
});
export type CheckpointAdoption = z.infer<typeof CheckpointAdoptionSchema>;
export const ConversationProgressSchema = z.strictObject({ schema: z.literal('conversation-progress-v1'), phase: z.enum(['preparing', 'deciding', 'memory', 'starting', 'running', 'saving', 'verifying', 'publishing']), since: z.iso.datetime() });
export const ConversationPublicSchema = z.strictObject({
  schema: z.literal('conversation-view-v1'), progress: ConversationProgressSchema.optional(), conversation: ConversationSchema, summary: SummarySchema, closedWorks: z.array(WorkSchema),
  stretches: z.array(StretchSchema.omit({ native: true })), handoffs: z.array(HandoffSchema),
  messages: z.array(z.strictObject({ id: z.number().int().positive(), type: z.enum(['user-message', 'note']), clientMessageId: IdSchema, text: z.string(), workId: IdSchema })),
  pause: WorkControlSchema.options[0].optional(), decisionWait: DecisionWaitSchema.optional(), decisions: z.array(DecisionRecordSchema), busy: z.boolean(), allowed: z.array(ActionSchema),
  settlements: z.array(WorkSettlementSchema), overrides: z.array(OverrideRecordSchema), composerOverrides: z.array(ComposerOverrideRecordSchema).default([]), redos: z.array(RedoOperationSchema),
  finishes: z.array(FinishOutsideOperationSchema).default([]),
  externalWait: ExternalActivityWaitSchema.optional(),
  checkpointBlocks: z.array(CheckpointBlockSchema.extend({ eventId: z.number().int().positive() })).default([]),
});
export const ConversationListSchema = z.strictObject({ schema: z.literal('conversations-list-v2'), conversations: z.array(ConversationIndexSchema) });
export const ConversationNoticeSchema = z.strictObject({ schema: z.literal('conversation-notice-v1'), text: z.string().min(1), kind: z.enum(['info', 'error', 'closing', 'steer']) });
export const ConversationEventSchema = z.strictObject({ schema: z.literal('conversation-event-v1'), event: LedgerEventSchema });
export const ConversationReadSchema = z.strictObject({ schema: z.literal('conversation-read-v1'), pointer: z.string().min(1), content: z.unknown() });
export const ConversationFileRequestSchema = z.strictObject({ schema: z.literal('conversation-file-request-v1'), ref: z.string().min(1).max(4000), stretch: z.number().int().positive(), source: z.enum(['step', 'working-tree']).default('step') });
export const ConversationFileSchema = z.strictObject({ schema: z.literal('conversation-file-v1'), path: z.string().min(1), source: z.enum(['checkpoint', 'before-step', 'working-tree']), commit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), line: z.number().int().positive().optional(), kind: z.enum(['text', 'markdown', 'image']), encoding: z.enum(['utf8', 'base64']), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).optional(), content: z.string(), bytes: z.number().int().nonnegative() });
export const CheckpointReceiptSchema = z.strictObject({ schema: z.literal('checkpoint-receipt-v1'), workId: IdSchema, stretch: z.number().int().positive(), kind: z.enum(['stretch', 'memory', 'context']), before: z.string().regex(/^[a-f0-9]{40,64}$/), after: z.string().regex(/^[a-f0-9]{40,64}$/), adoptionId: IdSchema.optional() });
export const ConversationOperationSchema = z.strictObject({ schema: z.literal('conversation-operation-v1'), busy: z.boolean() });
export const ConversationChangesSchema = z.strictObject({ schema: z.literal('conversation-changes-v1'), stretch: z.number().int().positive(), diff: z.string(), uncommitted: z.string(), files: z.array(z.strictObject({ path: z.string().min(1), source: z.enum(['step', 'working-tree']) })).default([]), evidence: HandoffSchema.shape.evidence, verifications: z.array(VerificationSchema), recovery: CheckpointReviewSchema.optional() });
