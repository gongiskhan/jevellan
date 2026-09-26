import { z } from 'zod';
import { IdSchema, RelativePathSchema, TimestampSchema } from './schemas.js';

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const CommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const probability = z.number().min(0).max(1);
const unique = (paths: string[]) => new Set(paths).size === paths.length;

/** A path inside a project checkout, never inside Git metadata. */
export const ProjectFileSchema = RelativePathSchema.pipe(z.string().max(512)).refine(value => !value.split('/').some(part => part === '.' || part === '.git'), 'A project file cannot use Git metadata.');
export const MemoryNoteRefSchema = z.strictObject({ path: ProjectFileSchema, permalink: text.max(512), title: text.max(300) });
export type MemoryNoteRef = z.infer<typeof MemoryNoteRefSchema>;
export const MemoryCareCountsSchema = z.strictObject({ merged: count, archived: count, fixedLinks: count, reconciled: count });
export type MemoryCareCounts = z.infer<typeof MemoryCareCountsSchema>;

export const MemoryCareCandidatesSchema = z.strictObject({
  schema: z.literal('memory-care-candidates-v1'), notes: z.array(MemoryNoteRefSchema).max(5000),
  changed: z.array(ProjectFileSchema), unresolved: z.array(ProjectFileSchema),
  pairs: z.array(z.strictObject({ a: ProjectFileSchema, b: ProjectFileSchema, basis: z.enum(['title', 'search']) })),
  stale: z.array(ProjectFileSchema), brokenLinks: z.array(z.strictObject({ path: ProjectFileSchema, target: text.max(500) })),
});
export type MemoryCareCandidates = z.infer<typeof MemoryCareCandidatesSchema>;
export const MemoryCareJudgmentSchema = z.strictObject({
  schema: z.literal('memory-care-judgment-v1'), requestedModel: text, returnedModel: text,
  pairs: z.array(z.strictObject({ a: ProjectFileSchema, b: ProjectFileSchema, probability })),
  stale: z.array(z.strictObject({ path: ProjectFileSchema, probability })),
});
export type MemoryCareJudgment = z.infer<typeof MemoryCareJudgmentSchema>;
export const ContextRuleJudgmentSchema = z.strictObject({
  schema: z.literal('context-rule-judgment-v1'), requestedModel: text, returnedModel: text,
  groups: z.array(z.strictObject({ paths: z.array(ProjectFileSchema).min(2), probability })),
});
export type ContextRuleJudgment = z.infer<typeof ContextRuleJudgmentSchema>;

/** What a read-only memory-care draft returns; paths are relative to the memory folder. */
export const MemoryPatchDraftSchema = z.strictObject({
  schema: z.literal('memory-patch-draft-v1'), summary: text.max(1200),
  files: z.array(z.strictObject({ path: RelativePathSchema.pipe(z.string().max(400)), content: z.string().max(256_000).nullable() })).max(500),
}).refine(value => unique(value.files.map(file => file.path)), 'Each file may appear once.');
export type MemoryPatchDraft = z.infer<typeof MemoryPatchDraftSchema>;
/** What a read-only context draft returns: the complete proposed instruction file. */
export const ContextDraftSchema = z.strictObject({ schema: z.literal('context-draft-v1'), title: text.max(200), reason: text.max(1200), after: text.max(256_000) });
export type ContextDraft = z.infer<typeof ContextDraftSchema>;

/** What a plain-language Change it draft returns: new text for files the suggestion already changes. */
export const ProjectRevisionDraftSchema = z.strictObject({
  schema: z.literal('project-revision-draft-v1'), title: text.max(200), reason: text.max(1200),
  files: z.array(z.strictObject({ path: RelativePathSchema.pipe(z.string().max(512)), after: z.string().max(256_000) })).min(1).max(500),
}).refine(value => unique(value.files.map(file => file.path)), 'Each file may appear once.');
export type ProjectRevisionDraft = z.infer<typeof ProjectRevisionDraftSchema>;

export const ProjectPatchFileSchema = z.strictObject({
  path: ProjectFileSchema, before: sha256.nullable(), beforeText: z.string().max(256_000).nullable(), after: z.string().max(256_000).nullable(),
}).refine(value => (value.before === null) === (value.beforeText === null) && !(value.before === null && value.after === null) && value.beforeText !== value.after, 'A patch file must change an existing or new file.');
export type ProjectPatchFile = z.infer<typeof ProjectPatchFileSchema>;
/** File hashes bind a patch to the exact files it was computed from. */
export const ProjectPatchSchema = z.strictObject({
  schema: z.literal('project-patch-v1'), files: z.array(ProjectPatchFileSchema).min(1).max(500), diff: z.string().max(1_000_000),
}).refine(value => unique(value.files.map(file => file.path)), 'Each file may appear once.');
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

export const ProjectSuggestionOutcomeSchema = z.strictObject({
  schema: z.literal('project-suggestion-outcome-v1'), kind: z.enum(['applied', 'applied-after-change', 'dismissed', 'undone']),
  at: TimestampSchema, deviceId: IdSchema, reason: z.string().max(1200).nullable(), commit: CommitSchema.nullable(),
});
export const ProjectSuggestionStatusSchema = z.enum(['pending', 'applying', 'recompute', 'expired', 'applied', 'undoing', 'dismissed', 'undone']);
export const ProjectSuggestionSchema = z.strictObject({
  schema: z.literal('project-suggestion-v1'), id: IdSchema, kind: z.enum(['memory-care', 'context']), projectId: IdSchema, projectName: text.max(200),
  deviceId: IdSchema, jobId: IdSchema, title: text.max(200), reason: text.max(1200), evidence: z.array(MemoryNoteRefSchema).min(1).max(100),
  counts: MemoryCareCountsSchema.nullable(), patch: ProjectPatchSchema, suppressionKey: sha256,
  status: ProjectSuggestionStatusSchema, error: z.string().max(1200).nullable(), outcomes: z.array(ProjectSuggestionOutcomeSchema),
  applied: z.strictObject({ commit: CommitSchema.nullable(), published: z.boolean(), at: TimestampSchema, undoUntil: TimestampSchema, patch: ProjectPatchSchema }).nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).superRefine((value, context) => {
  if ((value.kind === 'memory-care') !== (value.counts !== null)) context.addIssue({ code: 'custom', message: 'Only memory care suggestions carry counts.' });
  if (['applied', 'undoing', 'undone'].includes(value.status) !== (value.applied !== null)) context.addIssue({ code: 'custom', message: 'Applied suggestions require their applied change.' });
  const last = value.outcomes.at(-1)?.kind;
  if (value.status === 'dismissed' ? last !== 'dismissed' : value.status === 'undone' ? last !== 'undone' : ['applied', 'undoing'].includes(value.status) ? last !== 'applied' && last !== 'applied-after-change' : value.outcomes.length !== 0) {
    context.addIssue({ code: 'custom', message: 'The suggestion status must match its recorded outcome.' });
  }
});
export type ProjectSuggestion = z.infer<typeof ProjectSuggestionSchema>;
export const ProjectSuggestionRowSchema = z.strictObject({ schema: z.literal('project-suggestion-row-v1'), revision: z.number().int().positive(), suggestion: ProjectSuggestionSchema });
export type ProjectSuggestionRow = z.infer<typeof ProjectSuggestionRowSchema>;
const projectAction = { schema: z.literal('project-suggestion-action-v1'), clientRequestId: IdSchema, revision: z.number().int().positive() };
export const ProjectSuggestionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...projectAction, kind: z.literal('apply'), previewId: IdSchema.nullable() }),
  z.strictObject({ ...projectAction, kind: z.literal('undo') }),
  z.strictObject({ ...projectAction, kind: z.literal('dismiss'), reason: z.string().max(1200).nullable() }),
]);
export type ProjectSuggestionAction = z.infer<typeof ProjectSuggestionActionSchema>;

const projectRevision = { schema: z.literal('project-revision-request-v1'), clientRequestId: IdSchema, suggestionId: IdSchema, revision: z.number().int().positive() };
export const ProjectRevisionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...projectRevision, kind: z.literal('text'), files: z.array(z.strictObject({ path: ProjectFileSchema, after: z.string().max(256_000) })).min(1).max(500) }),
  z.strictObject({ ...projectRevision, kind: z.literal('instruction'), instruction: text.max(4000) }),
]);
export type ProjectRevisionRequest = z.infer<typeof ProjectRevisionRequestSchema>;
export const ProjectPreviewSchema = z.strictObject({
  schema: z.literal('project-preview-v1'), id: IdSchema, suggestionId: IdSchema, suggestionRevision: z.number().int().positive(),
  source: z.enum(['text', 'instruction']), instruction: z.string().max(4000).nullable(), title: text.max(200), reason: text.max(1200), patch: ProjectPatchSchema, createdAt: TimestampSchema,
});
export type ProjectPreview = z.infer<typeof ProjectPreviewSchema>;
export const ProjectRevisionRecordSchema = z.strictObject({
  schema: z.literal('project-revision-record-v1'), id: IdSchema, deviceId: IdSchema, request: ProjectRevisionRequestSchema,
  startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(), status: z.enum(['running', 'complete', 'failed']), error: z.string().max(1200).nullable(), preview: ProjectPreviewSchema.nullable(),
}).refine(value => (value.status === 'running') === (value.finishedAt === null) && (value.status === 'failed') === (value.error !== null) && (value.status === 'complete') === (value.preview !== null)
  && (!value.preview || value.preview.id === value.id && value.preview.suggestionId === value.request.suggestionId && value.preview.suggestionRevision === value.request.revision && value.preview.source === value.request.kind),
'The revision request must match its result.');
export type ProjectRevisionRecord = z.infer<typeof ProjectRevisionRecordSchema>;

/** The morning card for memory care in Apply and tell me mode. */
export const MemoryCareReportSchema = z.strictObject({
  schema: z.literal('memory-care-report-v1'), id: IdSchema, jobId: IdSchema, projectId: IdSchema, projectName: text.max(200), deviceId: IdSchema,
  counts: MemoryCareCountsSchema, evidence: z.array(MemoryNoteRefSchema).max(100), patch: ProjectPatchSchema, commit: CommitSchema.nullable(), published: z.boolean(), at: TimestampSchema,
  status: z.enum(['applied', 'undoing', 'undone']), error: z.string().max(1200).nullable(), undoCommit: CommitSchema.nullable(), undoneAt: TimestampSchema.nullable(),
}).refine(value => (value.status === 'undone') === (value.undoneAt !== null) && (value.undoCommit === null || value.status === 'undone'), 'The report status must match its undo.');
export type MemoryCareReport = z.infer<typeof MemoryCareReportSchema>;
export const MemoryCareReportRowSchema = z.strictObject({ schema: z.literal('memory-care-report-row-v1'), revision: z.number().int().positive(), report: MemoryCareReportSchema });
export type MemoryCareReportRow = z.infer<typeof MemoryCareReportRowSchema>;
export const MemoryCareReportActionSchema = z.strictObject({ schema: z.literal('memory-care-report-action-v1'), clientRequestId: IdSchema, revision: z.number().int().positive(), kind: z.literal('undo') });
export type MemoryCareReportAction = z.infer<typeof MemoryCareReportActionSchema>;
export const MemoryCareStateSchema = z.strictObject({ schema: z.literal('memory-care-state-v1'), projectId: IdSchema, deviceId: IdSchema, lastRunAt: TimestampSchema, lastCommit: CommitSchema.nullable() });
export type MemoryCareState = z.infer<typeof MemoryCareStateSchema>;

/** Checkout changes run on the device that has the checkout; the hub hands them out. */
export const ProjectTaskSchema = z.strictObject({
  schema: z.literal('project-improver-task-v1'), id: IdSchema, deviceId: IdSchema, projectId: IdSchema, kind: z.enum(['apply', 'undo', 'recompute', 'undo-report']),
  targetId: IdSchema, targetRevision: z.number().int().positive(), previewId: IdSchema.nullable(), requestedBy: IdSchema,
  status: z.enum(['queued', 'running', 'complete', 'failed']), createdAt: TimestampSchema, updatedAt: TimestampSchema, note: z.string().max(1200),
});
export type ProjectTask = z.infer<typeof ProjectTaskSchema>;
export const ProjectImproverLogSchema = z.strictObject({
  schema: z.literal('project-improver-log-v1'), jobId: IdSchema, startedAt: TimestampSchema,
  entries: z.array(z.strictObject({ at: TimestampSchema, stage: z.enum(['started', 'synchronized', 'collected', 'judged', 'drafted', 'applied', 'published', 'suggested', 'skipped', 'complete', 'failed']), note: z.string().max(1200) })),
});
export type ProjectImproverLog = z.infer<typeof ProjectImproverLogSchema>;

export const ImproverLastRunSchema = z.strictObject({
  kind: z.enum(['routing', 'memory', 'context']), projectId: IdSchema.nullable(), projectName: z.string().max(200).nullable(), jobId: IdSchema.nullable(), deviceId: IdSchema.nullable(),
  status: z.enum(['running', 'complete', 'skipped', 'failed', 'waiting']), at: TimestampSchema.nullable(), result: z.string().max(1200), commit: CommitSchema.nullable(),
});
export const TrialLogSchema = z.strictObject({
  schema: z.literal('trial-log-v1'), weeks: z.array(z.strictObject({
    weekStart: z.iso.date(), inJevellan: count, outside: count,
    reasons: z.array(z.strictObject({ conversationId: IdSchema, title: text, projectId: IdSchema, at: TimestampSchema, reason: z.string().nullable() })),
  })),
});
export type TrialLog = z.infer<typeof TrialLogSchema>;
export const ImproverNoticeSchema = z.strictObject({ schema: z.literal('improver-notice-v1'), id: sha256, lines: z.array(text.max(400)).min(1).max(20) });
export type ImproverNotice = z.infer<typeof ImproverNoticeSchema>;
export const ImproverSummarySchema = z.strictObject({ schema: z.literal('improver-summary-v1'), pending: count, notice: ImproverNoticeSchema.nullable() });
