import { z } from 'zod';
import { ActionSchema, EffortSchema, HandoffSchema, IdSchema, ImproverSettingsSchema, JevCallSchema, TimestampSchema, UsageSchema } from './schemas.js';
import {
  ImproverLastRunSchema, ImproverNoticeSchema, MemoryCareCountsSchema, MemoryCareReportActionSchema, MemoryCareReportRowSchema, MemoryCareStateSchema, MemoryNoteRefSchema,
  ProjectImproverLogSchema, ProjectPatchSchema, ProjectPreviewSchema, ProjectRevisionRecordSchema, ProjectRevisionRequestSchema, ProjectSuggestionActionSchema, ProjectSuggestionRowSchema,
  ProjectTaskSchema, TrialLogSchema, ImproverSummarySchema,
} from './project-improver-schemas.js';

const text = z.string().min(1);
export const RoutingFieldSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('routing-profile') }),
  z.strictObject({ kind: z.literal('menu-description'), modelId: IdSchema }),
  z.strictObject({ kind: z.literal('effort-guide'), effort: EffortSchema }),
]);
export type RoutingField = z.infer<typeof RoutingFieldSchema>;
export const RoutingDraftSchema = z.strictObject({
  schema: z.literal('routing-draft-v1'), title: text.max(200), reason: text.max(1200), field: RoutingFieldSchema,
  before: text, after: text, evidenceOverrideIds: z.array(IdSchema).min(1),
}).refine(value => value.before !== value.after, 'The suggestion must change its field.')
  .refine(value => new Set(value.evidenceOverrideIds).size === value.evidenceOverrideIds.length, 'Evidence must not be repeated.');
export type RoutingDraft = z.infer<typeof RoutingDraftSchema>;
export const RoutingGroupKeySchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('action'), from: ActionSchema.nullable(), to: ActionSchema.nullable() }),
  z.strictObject({ field: z.literal('model'), action: ActionSchema, from: IdSchema.nullable(), to: IdSchema.nullable() }),
  z.strictObject({ field: z.literal('effort'), action: ActionSchema, from: EffortSchema.nullable(), to: EffortSchema.nullable() }),
]);
export type RoutingGroupKey = z.infer<typeof RoutingGroupKeySchema>;
export const RoutingEvidenceSchema = z.strictObject({
  id: IdSchema, at: TimestampSchema, conversationId: IdSchema, projectId: IdSchema,
  workId: IdSchema, decisionId: IdSchema, stretch: z.number().int().positive().nullable(),
  context: text.max(400), mode: z.enum(['noted', 'redo', 'once', 'pin']),
});
export const RoutingGroupSchema = z.strictObject({
  schema: z.literal('routing-group-v1'), id: IdSchema, key: RoutingGroupKeySchema,
  weight: z.number().int().min(3), overrides: z.array(RoutingEvidenceSchema).min(2),
}).refine(value => new Set(value.overrides.map(override => override.id)).size === value.overrides.length
  && value.weight === value.overrides.reduce((sum, override) => sum + (override.mode === 'redo' ? 2 : 1), 0), 'The group weight must match its distinct corrections.');
export type RoutingGroup = z.infer<typeof RoutingGroupSchema>;
export const RoutingSuppressionSchema = z.strictObject({
  schema: z.literal('routing-suppression-v1'), groupId: IdSchema, overrideIds: z.array(IdSchema),
});
export type RoutingSuppression = z.infer<typeof RoutingSuppressionSchema>;
export const RoutingPreferenceSchema = z.strictObject({
  schema: z.literal('routing-preference-v1'), groupId: IdSchema, probability: z.number().min(0).max(1),
  requestedModel: text, returnedModel: text,
});
export type RoutingPreference = z.infer<typeof RoutingPreferenceSchema>;
export const EvaluationChoiceSchema = z.strictObject({ action: ActionSchema, modelId: IdSchema.nullable(), effort: EffortSchema.nullable() });
export const DecisionEvaluationSchema = z.strictObject({
  schema: z.literal('decision-evaluation-v1'), caseId: IdSchema, title: text, choice: EvaluationChoiceSchema,
  acceptable: z.boolean(), failedFields: z.array(z.enum(['action', 'model', 'effort'])), calls: z.array(JevCallSchema),
}).refine(value => value.acceptable === (value.failedFields.length === 0), 'Case outcome must match its failed fields.');
export type DecisionEvaluation = z.infer<typeof DecisionEvaluationSchema>;
export const DecisionEvaluationOutputSchema = z.strictObject({ schema: z.literal('decision-case-output-v1'), evidence: z.enum(['live', 'simulated']), result: DecisionEvaluationSchema });
export const DecisionEvaluationSummarySchema = z.strictObject({
  schema: z.literal('decision-evaluation-summary-v1'), evidence: z.enum(['live', 'simulated']),
  total: z.number().int().positive(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
}).refine(value => value.total === value.passed + value.failed, 'Case totals must match their outcomes.');
export const DecisionComparisonSchema = z.strictObject({
  schema: z.literal('decision-comparison-v1'), evidence: z.enum(['live', 'simulated']), at: TimestampSchema,
  beforeConfiguration: z.string().regex(/^[a-f0-9]{64}$/), afterConfiguration: z.string().regex(/^[a-f0-9]{64}$/), caseSet: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.strictObject({ before: DecisionEvaluationSchema, after: DecisionEvaluationSchema, change: z.enum(['unchanged', 'better', 'worse']) })).min(1),
  unchanged: z.number().int().nonnegative(), better: z.number().int().nonnegative(), worse: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  for (const entry of value.cases) {
    const expected = entry.before.acceptable === entry.after.acceptable ? 'unchanged' : entry.after.acceptable ? 'better' : 'worse';
    if (entry.before.caseId !== entry.after.caseId || ids.has(entry.before.caseId) || entry.change !== expected) context.addIssue({ code: 'custom', message: 'Case comparison does not match its results.' });
    ids.add(entry.before.caseId);
  }
  for (const kind of ['unchanged', 'better', 'worse'] as const) if (value[kind] !== value.cases.filter(entry => entry.change === kind).length) context.addIssue({ code: 'custom', message: 'Case counts do not match the results.' });
});
export type DecisionComparison = z.infer<typeof DecisionComparisonSchema>;
export const ImproverCycleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('nightly'), date: z.iso.date() }),
  z.strictObject({ kind: z.literal('manual'), id: IdSchema }),
]);
export const ImproverJobScopeSchema = z.strictObject({
  kind: z.enum(['routing', 'memory', 'context']), projectId: IdSchema.nullable(), cycle: ImproverCycleSchema,
}).refine(value => (value.kind === 'routing') === (value.projectId === null), 'Routing is global; memory and context jobs belong to a project.');
export type ImproverJobScope = z.infer<typeof ImproverJobScopeSchema>;
export const ImproverJobSchema = z.strictObject({
  schema: z.literal('improver-job-v1'), id: IdSchema, scope: ImproverJobScopeSchema,
  deviceId: IdSchema, token: IdSchema, attempt: z.number().int().positive(),
  status: z.enum(['running', 'complete', 'skipped', 'failed']), startedAt: TimestampSchema, updatedAt: TimestampSchema,
  leaseUntil: TimestampSchema, finishedAt: TimestampSchema.nullable(), note: z.string().max(1200),
}).refine(value => (value.status === 'running') === (value.finishedAt === null), 'Only unfinished jobs can be running.');
export type ImproverJob = z.infer<typeof ImproverJobSchema>;
export const SuggestionOutcomeSchema = z.strictObject({
  schema: z.literal('suggestion-outcome-v1'), kind: z.enum(['applied', 'applied-after-change', 'dismissed', 'undone']),
  at: TimestampSchema, deviceId: IdSchema, reason: z.string().max(1200).nullable(), configurationRevision: z.number().int().positive().nullable(),
}).refine(value => (value.kind === 'dismissed') === (value.configurationRevision === null), 'Applied and undone outcomes require a configuration revision.');
export const RoutingSuggestionSchema = z.strictObject({
  schema: z.literal('routing-suggestion-v1'), id: IdSchema, jobId: IdSchema, creationFingerprint: z.string().regex(/^[a-f0-9]{64}$/), group: RoutingGroupSchema, preference: RoutingPreferenceSchema,
  draft: RoutingDraftSchema, comparison: DecisionComparisonSchema, configurationRevision: z.number().int().positive(),
  status: z.enum(['pending', 'recompute', 'applied', 'dismissed', 'undone']), createdAt: TimestampSchema, updatedAt: TimestampSchema,
  outcomes: z.array(SuggestionOutcomeSchema), applied: z.strictObject({ before: text, after: text, undoUntil: TimestampSchema, revision: z.number().int().positive() }).nullable(),
}).superRefine((value, context) => {
  if (value.preference.groupId !== value.group.id || value.preference.probability < 0.7) context.addIssue({ code: 'custom', message: 'A suggestion requires a consistent preference for its group.' });
  if (value.draft.evidenceOverrideIds.some(id => !value.group.overrides.some(evidence => evidence.id === id))) context.addIssue({ code: 'custom', message: 'A suggestion cites unknown evidence.' });
  if ((value.status === 'applied' || value.status === 'undone') !== (value.applied !== null)) context.addIssue({ code: 'custom', message: 'Applied suggestions require their saved edit.' });
  const kind = value.outcomes.at(-1)?.kind;
  if (value.status === 'applied' ? kind !== 'applied' && kind !== 'applied-after-change' : value.status === 'dismissed' || value.status === 'undone' ? kind !== value.status : value.outcomes.length !== 0) context.addIssue({ code: 'custom', message: 'The suggestion status must match its recorded outcome.' });
});
export type RoutingSuggestion = z.infer<typeof RoutingSuggestionSchema>;
export const RoutingSuggestionRowSchema = z.strictObject({ schema: z.literal('routing-suggestion-row-v1'), revision: z.number().int().positive(), suggestion: RoutingSuggestionSchema });
export type RoutingSuggestionRow = z.infer<typeof RoutingSuggestionRowSchema>;
export const RoutingPreviewSchema = z.strictObject({
  schema: z.literal('routing-preview-v1'), id: IdSchema, suggestionId: IdSchema, suggestionRevision: z.number().int().positive(),
  source: z.enum(['text', 'instruction']), instruction: z.string().max(4000).nullable(), draft: RoutingDraftSchema, comparison: DecisionComparisonSchema,
  configurationRevision: z.number().int().positive(), createdAt: TimestampSchema,
});
export type RoutingPreview = z.infer<typeof RoutingPreviewSchema>;
const suggestionRequest = { schema: z.literal('routing-suggestion-action-v1'), clientRequestId: IdSchema, revision: z.number().int().positive() };
export const RoutingSuggestionActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...suggestionRequest, kind: z.literal('apply'), previewId: IdSchema.nullable() }),
  z.strictObject({ ...suggestionRequest, kind: z.literal('undo') }),
  z.strictObject({ ...suggestionRequest, kind: z.literal('dismiss'), reason: z.string().max(1200).nullable() }),
]);
export type RoutingSuggestionAction = z.infer<typeof RoutingSuggestionActionSchema>;
const DraftFileSchema = z.string().min(1).max(512).refine(value => !value.startsWith('/') && !value.includes('\\')
  && value.split('/').every(part => !!part && !['.', '..', '.git'].includes(part)), 'A draft input must use an ordinary relative file path.');
export const BackgroundDraftRequestSchema = z.strictObject({
  schema: z.literal('background-draft-request-v1'), id: IdSchema, title: text.max(200), projectId: IdSchema.nullable(),
  brief: text.max(100_000), resultType: z.enum(['suggestion', 'memory-patch']), files: z.record(DraftFileSchema, z.string().max(1_000_000)),
}).refine(value => Object.keys(value.files).length <= 500 && Object.values(value.files).reduce((sum, content) => sum + content.length, 0) <= 4_000_000, 'The draft input is too large.');
export type BackgroundDraftRequest = z.infer<typeof BackgroundDraftRequestSchema>;
export const BackgroundDraftResultSchema = z.strictObject({
  schema: z.literal('background-draft-result-v1'), runId: IdSchema, handoff: HandoffSchema, content: z.json(),
  modelId: IdSchema, accountId: IdSchema, effort: EffortSchema, usage: UsageSchema,
});
export type BackgroundDraftResult = z.infer<typeof BackgroundDraftResultSchema>;
export const RoutingImproverLogSchema = z.strictObject({
  schema: z.literal('routing-improver-log-v1'), jobId: IdSchema, startedAt: TimestampSchema,
  entries: z.array(z.strictObject({ at: TimestampSchema, groupId: IdSchema.nullable(), stage: z.enum(['started', 'judged', 'drafted', 'checked', 'suggested', 'skipped', 'complete', 'failed']),
    probability: z.number().min(0).max(1).nullable(), runId: IdSchema.nullable(), suggestionId: IdSchema.nullable(), note: z.string().max(1200) })),
});
export type RoutingImproverLog = z.infer<typeof RoutingImproverLogSchema>;
export const RoutingOutcomeContextSchema = z.strictObject({
  schema: z.literal('routing-outcome-context-v1'), outcomes: z.array(z.strictObject({ title: text, after: text, outcomes: z.array(SuggestionOutcomeSchema) })),
});

const revisionRequest = { schema: z.literal('routing-revision-request-v1'), clientRequestId: IdSchema, suggestionId: IdSchema, revision: z.number().int().positive() };
export const RoutingRevisionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...revisionRequest, kind: z.literal('text'), after: text.max(100_000) }),
  z.strictObject({ ...revisionRequest, kind: z.literal('instruction'), instruction: text.max(4000) }),
  z.strictObject({ ...revisionRequest, kind: z.literal('recompute') }),
]);
export type RoutingRevisionRequest = z.infer<typeof RoutingRevisionRequestSchema>;
export const RoutingRevisionRecordSchema = z.strictObject({
  schema: z.literal('routing-revision-record-v1'), id: IdSchema, deviceId: IdSchema, request: RoutingRevisionRequestSchema,
  configurationRevision: z.number().int().positive(), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(),
  status: z.enum(['running', 'complete', 'failed']), error: z.string().max(1200).nullable(),
  preview: RoutingPreviewSchema.nullable(), suggestion: RoutingSuggestionRowSchema.nullable(),
}).superRefine((value, context) => {
  if ((value.status === 'running') !== (value.finishedAt === null)
    || (value.status === 'failed') !== (value.error !== null)
    || (value.status === 'complete' ? value.request.kind === 'recompute' ? !value.suggestion || value.preview !== null : !value.preview || value.suggestion !== null : value.preview !== null || value.suggestion !== null)) {
    context.addIssue({ code: 'custom', message: 'The revision request must match its result.' });
  }
  if (value.preview && (value.preview.id !== value.id || value.preview.suggestionId !== value.request.suggestionId
    || value.preview.suggestionRevision !== value.request.revision || value.preview.configurationRevision !== value.configurationRevision
    || value.preview.source !== value.request.kind || value.preview.instruction !== (value.request.kind === 'instruction' ? value.request.instruction : null))
    || value.suggestion && (value.suggestion.suggestion.id !== value.request.suggestionId || value.suggestion.revision !== value.request.revision + 1
      || value.suggestion.suggestion.configurationRevision !== value.configurationRevision)) {
    context.addIssue({ code: 'custom', message: 'The revised result belongs to a different request.' });
  }
});
export type RoutingRevisionRecord = z.infer<typeof RoutingRevisionRecordSchema>;
export const ImproverJobViewSchema = z.strictObject({
  schema: z.literal('improver-job-view-v1'), id: IdSchema, scope: ImproverJobScopeSchema, deviceId: IdSchema,
  status: z.enum(['running', 'complete', 'skipped', 'failed']), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(), note: z.string().max(1200),
});
const CardStatusSchema = z.enum(['pending', 'applying', 'recompute', 'expired', 'applied', 'undoing', 'dismissed', 'undone']);
/** One card shape for every improver suggestion, whatever job produced it. */
export const ImproverCardSchema = z.strictObject({
  schema: z.literal('improver-card-v1'), kind: z.enum(['routing', 'memory-care', 'context']), id: IdSchema, revision: z.number().int().positive(),
  projectId: IdSchema.nullable(), projectName: z.string().max(200).nullable(), title: z.string().min(1).max(200), reason: z.string().min(1).max(1200),
  status: CardStatusSchema, decided: z.boolean(), error: z.string().max(1200).nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
  evidence: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('corrections'), total: z.number().int().nonnegative(), withUndo: z.number().int().nonnegative(), items: z.array(z.strictObject({
      id: IdSchema, at: TimestampSchema, conversationId: IdSchema, conversationTitle: z.string().nullable(), stretch: z.number().int().positive().nullable(),
      field: z.enum(['action', 'model', 'effort']), from: z.string().nullable(), to: z.string().nullable(), context: z.string(), mode: z.enum(['noted', 'redo', 'once', 'pin']) })) }),
    z.strictObject({ kind: z.literal('notes'), notes: z.array(MemoryNoteRefSchema) }),
  ]),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('field'), field: RoutingFieldSchema, before: z.string(), after: z.string(), diff: z.string() }),
    z.strictObject({ kind: z.literal('patch'), diff: z.string(), files: z.array(z.strictObject({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() })) }),
  ]),
  check: z.strictObject({ evidence: z.enum(['live', 'simulated']), total: z.number().int().positive(), unchanged: z.number().int().nonnegative(), better: z.number().int().nonnegative(), worse: z.number().int().nonnegative(),
    changed: z.array(z.strictObject({ caseId: IdSchema, title: z.string(), change: z.enum(['better', 'worse']) })) }).nullable(),
  counts: MemoryCareCountsSchema.nullable(),
  applied: z.strictObject({ at: TimestampSchema, undoUntil: TimestampSchema, commit: z.string().nullable(), published: z.boolean().nullable() }).nullable(),
  outcomes: z.array(z.strictObject({ kind: z.enum(['applied', 'applied-after-change', 'dismissed', 'undone']), at: TimestampSchema, reason: z.string().nullable() })),
  actions: z.strictObject({ apply: z.boolean(), undo: z.boolean(), dismiss: z.boolean(), change: z.boolean() }),
  requests: z.strictObject({ action: z.enum(['routing-suggestion-action-v1', 'project-suggestion-action-v1']), revision: z.enum(['routing-revision-request-v1', 'project-revision-request-v1']) }),
});
export type ImproverCard = z.infer<typeof ImproverCardSchema>;
export const ImproverStateSchema = z.strictObject({
  schema: z.literal('improver-state-v2'), cards: z.array(ImproverCardSchema), suggestions: z.array(RoutingSuggestionRowSchema), jobs: z.array(ImproverJobViewSchema),
  revisions: z.array(RoutingRevisionRecordSchema), projectSuggestions: z.array(ProjectSuggestionRowSchema), projectRevisions: z.array(ProjectRevisionRecordSchema),
  reports: z.array(MemoryCareReportRowSchema), lastRuns: z.array(ImproverLastRunSchema), trialLog: TrialLogSchema,
  pending: z.number().int().nonnegative(), notice: ImproverNoticeSchema.nullable(),
});
export type ImproverState = z.infer<typeof ImproverStateSchema>;
export const ImproverRunSchema = z.strictObject({
  schema: z.literal('improver-run-v1'), id: IdSchema, requestedAt: TimestampSchema, routing: ImproverJobViewSchema.nullable(),
  projects: z.array(z.strictObject({ kind: z.enum(['memory', 'context']), projectId: IdSchema })),
});
export type ImproverRun = z.infer<typeof ImproverRunSchema>;
const improverRequest = { schema: z.literal('improver-request-v1') };
export const ImproverRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...improverRequest, operation: z.literal('state') }),
  z.strictObject({ ...improverRequest, operation: z.literal('summary') }),
  z.strictObject({ ...improverRequest, operation: z.literal('run'), clientRequestId: IdSchema }),
  z.strictObject({ ...improverRequest, operation: z.literal('run-now'), clientRequestId: IdSchema }),
  z.strictObject({ ...improverRequest, operation: z.literal('log'), jobId: IdSchema }),
  z.strictObject({ ...improverRequest, operation: z.literal('revise'), input: z.union([RoutingRevisionRequestSchema, ProjectRevisionRequestSchema]) }),
  z.strictObject({ ...improverRequest, operation: z.literal('revision'), id: IdSchema }),
  z.strictObject({ ...improverRequest, operation: z.literal('act'), suggestionId: IdSchema, input: z.union([RoutingSuggestionActionSchema, ProjectSuggestionActionSchema]) }),
  z.strictObject({ ...improverRequest, operation: z.literal('report'), reportId: IdSchema, input: MemoryCareReportActionSchema }),
  z.strictObject({ ...improverRequest, operation: z.literal('notice-seen'), id: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type ImproverRequest = z.infer<typeof ImproverRequestSchema>;
export const ImproverResultSchema = z.union([
  ImproverStateSchema, ImproverSummarySchema, ImproverRunSchema, ImproverJobViewSchema, RoutingImproverLogSchema, ProjectImproverLogSchema,
  RoutingRevisionRecordSchema, ProjectRevisionRecordSchema, RoutingSuggestionRowSchema, ProjectSuggestionRowSchema, MemoryCareReportRowSchema,
]);
export type ImproverResult = z.infer<typeof ImproverResultSchema>;

/** Device-authenticated protocol between a project-owning device and the hub; never exposed to browsers. */
export const ProjectSuggestionInputSchema = z.strictObject({
  schema: z.literal('project-suggestion-input-v1'), id: IdSchema, kind: z.enum(['memory-care', 'context']), projectId: IdSchema, projectName: z.string().min(1).max(200),
  title: z.string().min(1).max(200), reason: z.string().min(1).max(1200), evidence: z.array(MemoryNoteRefSchema).min(1).max(100), counts: MemoryCareCountsSchema.nullable(),
  patch: ProjectPatchSchema, suppressionKey: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProjectSuggestionInput = z.infer<typeof ProjectSuggestionInputSchema>;
export const MemoryCareReportInputSchema = z.strictObject({
  schema: z.literal('memory-care-report-input-v1'), projectId: IdSchema, projectName: z.string().min(1).max(200), counts: MemoryCareCountsSchema,
  evidence: z.array(MemoryNoteRefSchema).max(100), patch: ProjectPatchSchema, commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), published: z.boolean(),
});
export type MemoryCareReportInput = z.infer<typeof MemoryCareReportInputSchema>;
export const ProjectTaskResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('applied'), commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), published: z.boolean() }),
  z.strictObject({ kind: z.literal('undone'), commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable() }),
  z.strictObject({ kind: z.literal('stale'), note: z.string().min(1).max(1200) }),
  z.strictObject({ kind: z.literal('recomputed'), suggestion: ProjectSuggestionInputSchema }),
  z.strictObject({ kind: z.literal('expired'), note: z.string().min(1).max(1200) }),
  z.strictObject({ kind: z.literal('failed'), note: z.string().min(1).max(1200) }),
]);
export type ProjectTaskResult = z.infer<typeof ProjectTaskResultSchema>;
const deviceRequest = { schema: z.literal('improver-device-request-v1') };
export const ImproverDeviceRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...deviceRequest, operation: z.literal('poll'), startedAt: TimestampSchema }),
  z.strictObject({ ...deviceRequest, operation: z.literal('renew'), job: ImproverJobSchema }),
  z.strictObject({ ...deviceRequest, operation: z.literal('finish'), job: ImproverJobSchema, status: z.enum(['complete', 'skipped', 'failed']), note: z.string().max(1200), careState: MemoryCareStateSchema.nullable() }),
  z.strictObject({ ...deviceRequest, operation: z.literal('log'), job: ImproverJobSchema, stage: ProjectImproverLogSchema.shape.entries.element.shape.stage, note: z.string().max(1200) }),
  z.strictObject({ ...deviceRequest, operation: z.literal('care-state'), projectId: IdSchema }),
  z.strictObject({ ...deviceRequest, operation: z.literal('suggest'), job: ImproverJobSchema, suggestion: ProjectSuggestionInputSchema }),
  z.strictObject({ ...deviceRequest, operation: z.literal('report'), job: ImproverJobSchema, report: MemoryCareReportInputSchema }),
  z.strictObject({ ...deviceRequest, operation: z.literal('task-result'), taskId: IdSchema, result: ProjectTaskResultSchema }),
]);
export type ImproverDeviceRequest = z.infer<typeof ImproverDeviceRequestSchema>;
export const ImproverDeviceWorkSchema = z.strictObject({
  schema: z.literal('improver-device-work-v1'), settings: ImproverSettingsSchema, jobs: z.array(ImproverJobSchema),
  tasks: z.array(z.strictObject({ task: ProjectTaskSchema, suggestion: ProjectSuggestionRowSchema.nullable(), report: MemoryCareReportRowSchema.nullable(), preview: ProjectPreviewSchema.nullable() })),
  knownKeys: z.record(IdSchema, z.array(z.string().regex(/^[a-f0-9]{64}$/))), open: z.record(IdSchema, z.array(z.enum(['memory-care', 'context']))),
});
export type ImproverDeviceWork = z.infer<typeof ImproverDeviceWorkSchema>;
export const ImproverDeviceAckSchema = z.strictObject({ schema: z.literal('improver-device-ack-v1') });
export const MemoryCareStateResultSchema = z.strictObject({ schema: z.literal('memory-care-state-result-v1'), state: MemoryCareStateSchema.nullable() });
export const ImproverDeviceResultSchema = z.union([ImproverDeviceWorkSchema, ImproverJobSchema, ImproverDeviceAckSchema, MemoryCareStateResultSchema, ProjectSuggestionRowSchema, MemoryCareReportRowSchema, ProjectTaskSchema]);
