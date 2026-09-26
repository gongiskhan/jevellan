import { z } from 'zod';
import { RiggingBundleSchema } from './rigging-bundle-schemas.js';

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;
export const ActionSchema = z.enum(['reply', 'plan', 'implement', 'test', 'review', 'adversarial-review', 'integrate', 'ask-you', 'done']);
export type Action = z.infer<typeof ActionSchema>;
const count = z.number().int().nonnegative();
const percentage = z.number().min(0).max(100);
const text = z.string().min(1);
const stringMap = z.record(z.string(), z.string());
const probabilities = z.record(z.string(), z.number().min(0).max(1));

export const ModelOptionSchema = z.strictObject({
  id: IdSchema, runtime: IdSchema, model: text, efforts: z.array(EffortSchema).min(1),
  label: text, description: text, enabled: z.boolean(), unavailableReason: z.string().optional(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;
export const GuardsSchema = z.strictObject({
  maxStretchesPerWork: z.number().int().positive().default(24), stretchTimeoutMin: z.number().positive().default(30),
  reviewCap: count.default(2), noProgressLimit: z.number().int().positive().default(2),
  testFailureLimit: z.number().int().positive().default(3), pauseAfterPlan: z.boolean().default(false),
  workCostCapUsd: z.number().positive().nullable().default(null), externalActivityWindowMin: z.number().positive().default(5),
});
export type Guards = z.infer<typeof GuardsSchema>;

export const ImproverSettingsSchema = z.strictObject({
  schema: z.literal('improver-settings-v1'),
  schedule: z.strictObject({ enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  routing: z.strictObject({ enabled: z.boolean(), mode: z.literal('suggest') }),
  memory: z.strictObject({ enabled: z.boolean(), mode: z.enum(['apply-and-tell', 'suggest']), projects: z.record(IdSchema, z.boolean()) }),
  context: z.strictObject({ enabled: z.boolean(), mode: z.literal('suggest') }),
});
export type ImproverSettings = z.infer<typeof ImproverSettingsSchema>;
export function defaultImproverSettings(): ImproverSettings {
  return ImproverSettingsSchema.parse({ schema: 'improver-settings-v1', schedule: { enabled: true, time: '03:00' },
    routing: { enabled: true, mode: 'suggest' }, memory: { enabled: true, mode: 'apply-and-tell', projects: {} }, context: { enabled: true, mode: 'suggest' } });
}
const ConfigurationFields = {
  name: text, version: text,
  dependencies: z.strictObject({ apm: z.array(z.union([text, z.strictObject({ path: text }), z.strictObject({ repo: text })])) }),
};
const SettingsFields = {
  runtimes: z.record(IdSchema, z.strictObject({ enabled: z.boolean() })),
  decisions: z.strictObject({ provider: z.literal('jev'), model: text, timeoutMs: z.number().int().positive(), keepCurrentThreshold: z.number().min(0).max(1) }),
  menu: z.array(ModelOptionSchema).max(19), effortGuide: z.record(EffortSchema, text), routingProfile: text, guards: GuardsSchema,
};
export const LegacyConfigurationSchema = z.strictObject({ ...ConfigurationFields, 'x-jevellan': z.strictObject({ schema: z.literal(1), ...SettingsFields }) });
const CurrentConfigurationSchema = z.strictObject({
  ...ConfigurationFields, 'x-jevellan': z.strictObject({ schema: z.literal(2), ...SettingsFields, improver: ImproverSettingsSchema }),
}).superRefine((value, ctx) => {
  const ids = value['x-jevellan'].menu.map((model) => model.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Model menu ids must be unique.', path: ['x-jevellan', 'menu'] });
});
export const ConfigurationSchema = z.union([CurrentConfigurationSchema, LegacyConfigurationSchema]).transform((value): z.input<typeof CurrentConfigurationSchema> => {
  const settings = value['x-jevellan'];
  return { ...value, 'x-jevellan': { ...settings, schema: 2 as const, improver: settings.schema === 2 ? settings.improver : defaultImproverSettings() } };
}).pipe(CurrentConfigurationSchema);
export type Configuration = z.infer<typeof ConfigurationSchema>;
export const ConfigRevisionSchema = z.strictObject({
  schema: z.literal('config-revision-v1'), revision: z.number().int().positive(), configuration: ConfigurationSchema,
  at: TimestampSchema, changedBy: z.strictObject({ deviceId: IdSchema, source: z.enum(['ui', 'improver', 'install']) }),
});
export type ConfigRevision = z.infer<typeof ConfigRevisionSchema>;

export const AccountSchema = z.strictObject({
  schema: z.literal('account-v1'), id: IdSchema, runtime: IdSchema, label: text,
  kind: z.enum(['subscription', 'api-key']), enabled: z.boolean(), ceilingPct: percentage.default(90),
  credential: z.enum(['shared', 'per-device', 'hub-refreshed']), secretRef: IdSchema.optional(),
  identity: z.strictObject({ email: z.email().optional(), plan: z.string().optional() }).optional(),
  paidUse: z.enum(['always', 'when-subscriptions-run-out', 'never']).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'api-key' && !value.paidUse) ctx.addIssue({ code: 'custom', path: ['paidUse'], message: 'Choose when Jevellan may use this key.' });
  if (value.kind === 'subscription' && value.paidUse) ctx.addIssue({ code: 'custom', path: ['paidUse'], message: 'Paid-use policy applies only to API keys.' });
  if (value.runtime === 'codex' && value.kind === 'subscription' && value.credential === 'shared') ctx.addIssue({ code: 'custom', path: ['credential'], message: 'Codex subscription logins are per device.' });
});
export type Account = z.infer<typeof AccountSchema>;
export const AuthSchema = z.enum(['ready', 'needs-login', 'expired', 'revoked', 'missing', 'checking', 'unknown']);
export const AccountUsageSchema = z.strictObject({
  fiveHourPct: percentage.optional(), weeklyPct: percentage.optional(),
  fiveHourResetsAt: TimestampSchema.optional(), weeklyResetsAt: TimestampSchema.optional(),
  source: z.enum(['probe', 'stream', 'unknown']), observedAt: TimestampSchema,
});
/** v2 adds per-model cooling, keyed by the runtime's model id, for limits that apply to one model rather than the whole account. */
const AccountStatusV2Schema = z.strictObject({
  schema: z.literal('account-status-v2'), accountId: IdSchema, deviceId: IdSchema, auth: AuthSchema,
  usage: AccountUsageSchema.optional(), coolingUntil: TimestampSchema.optional(), modelCooling: z.record(z.string().min(1).max(200), TimestampSchema).optional(),
  lastError: z.string().optional(), observedAt: TimestampSchema,
});
// Stored v1 statuses have no model cooling; they read as v2 unchanged otherwise.
export const AccountStatusSchema = z.preprocess((value) => value && typeof value === 'object' && (value as { schema?: unknown }).schema === 'account-status-v1' ? { ...value, schema: 'account-status-v2' } : value, AccountStatusV2Schema);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const DeviceSchema = z.strictObject({
  schema: z.literal('device-v1'), id: IdSchema, name: text, role: z.enum(['hub', 'member']), url: z.url(),
  os: z.enum(['darwin', 'linux']), version: text, joinedAt: TimestampSchema, lastHeartbeatAt: TimestampSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;
export const DeviceConfigSchema = z.strictObject({
  schema: z.literal('device-config-v1'), deviceId: IdSchema, name: text, role: z.enum(['hub', 'member']),
  hubUrl: z.url(), url: z.url(), version: text,
});
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;
export const RelativePathSchema = text.refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => part === '..' || part === ''), 'Expected a confined relative path.');
export const ProjectSchema = z.strictObject({
  schema: z.literal('project-v1'), id: IdSchema, name: text, remoteUrl: text.optional(), paths: stringMap,
  branchPolicy: z.enum(['main', 'external']), testCommand: text.optional(), allowedDevices: z.array(IdSchema).optional(),
  memory: z.strictObject({ mode: z.enum(['repo', 'device']), dir: RelativePathSchema }),
  context: z.strictObject({ state: z.enum(['linked', 'needs-decision', 'none', 'left-as-is']), primary: z.enum(['AGENTS.md', 'CLAUDE.md']).optional() }),
});
export type Project = z.infer<typeof ProjectSchema>;
export const ExternalSessionSchema = z.strictObject({
  runtime: z.enum(['claude', 'codex', 'cursor', 'gemini']), cwd: text,
  projectId: IdSchema.optional(), lastActivityAt: TimestampSchema, source: text,
});
export type ExternalSession = z.infer<typeof ExternalSessionSchema>;
export const ExternalSessionsSchema = z.strictObject({
  schema: z.literal('external-sessions-v1'), at: TimestampSchema, sessions: z.array(ExternalSessionSchema),
  unavailable: z.array(z.enum(['claude', 'codex', 'cursor', 'gemini'])),
});
export type ExternalSessions = z.infer<typeof ExternalSessionsSchema>;
export const HeartbeatSchema = z.strictObject({
  schema: z.literal('heartbeat-v1'), deviceId: IdSchema, at: TimestampSchema, version: text,
  runningConversations: z.array(IdSchema), projects: z.array(z.strictObject({ projectId: IdSchema, path: text, branch: text, head: text, dirty: z.boolean(), ahead: count, behind: count })),
  externalSessions: z.array(ExternalSessionSchema), load: z.strictObject({ cpuPct: percentage, memFreeMb: z.number().nonnegative() }),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const WorkSchema = z.strictObject({
  schema: z.literal('work-v1'), id: IdSchema, requestEventId: text, request: text, messageEventIds: z.array(text), constraints: z.array(text), baseCommit: text.optional(),
  counters: z.strictObject({ stretches: count, reviews: count, noProgress: count, testFailures: count, costUsd: z.number().nonnegative(), unknownCostStretches: count }),
  allowance: z.strictObject({ stretches: count, grants: z.array(z.strictObject({ at: TimestampSchema, extra: z.number().int().positive(), via: z.enum(['reply', 'button']) })) }),
  latestPlanRef: text.optional(), approvedPlanRef: text.optional(), openedAt: TimestampSchema, closedAt: TimestampSchema.optional(), closedAs: z.enum(['done', 'cancelled', 'closed-by-you']).optional(),
});
export type Work = z.infer<typeof WorkSchema>;
export const ConversationStateSchema = z.enum(['idle', 'running', 'waiting-for-you', 'blocked', 'done', 'cancelled']);
export const NextChoicesSchema = z.strictObject({ action: ActionSchema.exclude(['integrate']).optional(), modelId: IdSchema.optional(), effort: EffortSchema.optional() });
export const ConversationSchema = z.strictObject({
  schema: z.literal('conversation-v2'), id: IdSchema, title: text, projectId: IdSchema, ownerDeviceId: IdSchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema, state: ConversationStateSchema, generation: count,
  current: z.strictObject({ modelId: IdSchema, effort: EffortSchema }).optional(), pins: z.strictObject({ modelId: IdSchema.optional(), effort: EffortSchema.optional() }), once: NextChoicesSchema.default({}),
  stretchCount: count, work: WorkSchema.nullable(), outcome: z.strictObject({ kind: z.literal('finished-elsewhere'), reason: text.optional(), at: TimestampSchema }).optional(),
  /** Set only on conversations Jevellan starts itself; absent means a user request. */
  origin: z.enum(['context-operation']).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const SummarySchema = z.strictObject({
  schema: z.literal('summary-v2'), objective: z.string(), state: z.string(), decisions: z.array(z.string()), nextWork: z.string(), updatedAtStretch: count,
});
export type Summary = z.infer<typeof SummarySchema>;
export const NativeProcessSchema = z.strictObject({ pid: z.number().int().min(2), pgid: z.number().int().min(2), startIdentity: z.string().min(1).max(64).optional(), sessionId: text.optional() });
export const StretchStatusSchema = z.enum(['running', 'completed', 'interrupted', 'failed', 'timed-out', 'undone']);
export const UsageSchema = z.strictObject({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), costUsd: z.number().nonnegative().optional(), costSource: z.enum(['reported', 'estimated', 'unknown']) });
export const StretchSchema = z.strictObject({
  schema: z.literal('stretch-v2'), n: z.number().int().positive(), workId: IdSchema, action: ActionSchema, modelId: IdSchema, runtime: IdSchema, model: text,
  effortRequested: EffortSchema, effortEffective: EffortSchema, accountId: IdSchema, deviceId: IdSchema, decisionId: IdSchema,
  native: NativeProcessSchema.optional(), startedAt: TimestampSchema, endedAt: TimestampSchema.optional(), status: StretchStatusSchema, usage: UsageSchema,
  gitBefore: text.optional(), gitAfter: text.optional(),
});
export type Stretch = z.infer<typeof StretchSchema>;
const CommitIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const UndoAppliedSchema = z.strictObject({
  schema: z.literal('undo-applied-v1'), id: IdSchema, workId: IdSchema,
  followingWorkId: IdSchema.optional(),
  fromStretch: z.number().int().positive(), throughStretch: z.number().int().positive(), generation: count,
  mode: z.enum(['reset', 'revert', 'unchanged', 'external']), before: CommitIdSchema.optional(), after: CommitIdSchema.optional(), savedRef: text.optional(),
  keepClosed: z.strictObject({ as: z.enum(['done', 'cancelled', 'closed-by-you']), at: TimestampSchema }).optional(),
}).refine((value) => value.throughStretch >= value.fromStretch, 'Undo must include its starting step.');
export type UndoApplied = z.infer<typeof UndoAppliedSchema>;
export const GitUndoPlanSchema = z.strictObject({
  schema: z.literal('git-undo-plan-v1'), mode: z.enum(['reset', 'revert', 'unchanged']),
  step: z.number().int().positive(), before: CommitIdSchema, target: CommitIdSchema, sourceTip: CommitIdSchema,
  commits: z.array(CommitIdSchema), savedRef: text, resultCommit: CommitIdSchema.optional(),
  ranges: z.array(z.strictObject({ before: CommitIdSchema, after: CommitIdSchema })).min(1).optional(),
});
export type GitUndoPlan = z.infer<typeof GitUndoPlanSchema>;
export const GitUndoResultSchema = z.strictObject({ schema: z.literal('git-undo-result-v1'), plan: GitUndoPlanSchema, after: CommitIdSchema });
export type GitUndoResult = z.infer<typeof GitUndoResultSchema>;
export const GitUndoRecoverySchema = z.strictObject({ schema: z.literal('git-undo-recovery-v1'), status: z.enum(['ready', 'completed', 'blocked']), result: GitUndoResultSchema.optional(), reason: text.optional() });
export const HandoffStatusSchema = z.enum(['done', 'partial', 'blocked', 'failed']);
export const FindingSchema = z.strictObject({ claim: text, pointer: text });
export const ResultSchema = z.strictObject({ type: z.enum(['plan', 'answer', 'suggestion', 'merge-draft', 'memory-patch']), ref: text });
export const HandoffSchema = z.strictObject({
  schema: z.literal('handoff-v2'), stretch: z.number().int().positive(), action: ActionSchema, status: HandoffStatusSchema,
  summary: text.max(1200), result: ResultSchema.optional(),
  evidence: z.array(z.strictObject({ kind: z.enum(['test', 'file', 'command', 'screenshot', 'url']), ref: text, note: z.string().optional() })),
  findings: z.array(FindingSchema), blockers: z.array(text), failedApproaches: z.array(text), proposedNext: ActionSchema.nullable(), changedFiles: z.array(text),
  testsRun: z.strictObject({ command: text, passed: z.boolean(), summary: z.string() }).optional(), question: text.optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;
export const VerificationSchema = z.strictObject({
  schema: z.literal('verification-v1'), id: IdSchema, workId: IdSchema, at: TimestampSchema, trigger: z.enum(['done-gate', 'publication']),
  command: text, exitCode: z.number().int(), passed: z.boolean(), outputRef: text, commit: text, treeClean: z.boolean(), headStable: z.boolean().default(true),
  worktreeBefore: z.string().regex(/^[a-f0-9]{64}$/).optional(), worktreeAfter: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((value) => value.passed === (value.exitCode === 0), 'Verification success must match the exit code.');
export type Verification = z.infer<typeof VerificationSchema>;
export const LedgerEventSchema = z.strictObject({
  schema: z.literal('ledger-event-v1'), t: TimestampSchema, id: z.number().int().positive(),
  type: z.enum(['user-message', 'note', 'stretch-start', 'text', 'tool-start', 'tool-end', 'usage', 'finding', 'handoff', 'stretch-end', 'decision', 'override', 'undo', 'steer', 'allowance', 'verification', 'publication', 'ownership', 'memory-queued', 'notice', 'git', 'error', 'state', 'conversation-control']),
  stretch: z.number().int().positive().optional(), data: z.unknown(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export const BlobDocumentSchema = z.strictObject({ schema: z.literal('conversation-blob-v1'), content: z.json() });
export const BlobReferenceSchema = z.strictObject({
  schema: z.literal('blob-ref-v1'), ref: z.string().regex(/^blobs\/[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(),
}).refine((value) => value.ref === `blobs/${value.sha256}`, 'Blob path must match its digest.');
export type BlobReference = z.infer<typeof BlobReferenceSchema>;
export const LedgerLockSchema = z.strictObject({ schema: z.literal('ledger-lock-v1'), pid: z.number().int().min(2) });
export const DaemonOwnershipSchema = z.strictObject({ schema: z.literal('daemon-ownership-v1'), pid: z.number().int().min(2), startIdentity: text, token: IdSchema, held: z.boolean() });
export const ConversationCreatedSchema = z.strictObject({ schema: z.literal('conversation-created-v1'), conversation: ConversationSchema });
export const WorkMessageSchema = z.strictObject({
  schema: z.literal('work-message-v1'), clientMessageId: IdSchema, text, workId: IdSchema,
  initialAllowance: z.number().int().positive(), allowanceGranted: count.default(0),
});
export const AllowanceEventSchema = z.strictObject({ schema: z.literal('allowance-event-v1'), workId: IdSchema, messageEventId: text.optional(), extra: z.number().int().positive(), via: z.enum(['reply', 'button']) });
export const GuardKindSchema = z.enum(['steps', 'no-progress', 'test-failures', 'cost']);
export const WorkControlSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('pause'), state: z.enum(['waiting-for-you', 'blocked']), reason: text, guard: GuardKindSchema.optional() }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('base-commit'), commit: text }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('plan-approved'), ref: text, generation: count }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('close'), closedAs: z.enum(['done', 'cancelled', 'closed-by-you']) }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('native'), n: z.number().int().positive(), native: NativeProcessSchema }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('pins'), modelId: IdSchema.nullable().optional(), effort: EffortSchema.nullable().optional() }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('invalidate'), reason: z.enum(['cancel', 'undo', 'override']) }),
  z.strictObject({ schema: z.literal('work-control-v1'), kind: z.literal('reopen'), workId: IdSchema }),
]);
export type WorkControl = z.infer<typeof WorkControlSchema>;
export const StretchFinishedSchema = z.strictObject({ schema: z.literal('stretch-finished-v1'), stretch: StretchSchema, changed: z.boolean(), correction: z.boolean(), pause: WorkControlSchema.options[0].optional() });
export const RestartRecoveryErrorSchema = z.strictObject({ schema: z.literal('restart-recovery-error-v1'), message: text });
export const CheckoutClaimSchema = z.strictObject({
  schema: z.literal('checkout-claim-v1'), deviceId: IdSchema, path: text, held: z.boolean(),
  conversationId: IdSchema, conversationTitle: text, workId: IdSchema, pid: z.number().int().min(2), updatedAt: TimestampSchema,
});
export type CheckoutClaim = z.infer<typeof CheckoutClaimSchema>;
export const PublicationLeaseSchema = z.strictObject({
  schema: z.literal('publication-lease-v1'), remote: text, owner: IdSchema, token: IdSchema, held: z.boolean(), expiresAt: TimestampSchema,
});
export type PublicationLease = z.infer<typeof PublicationLeaseSchema>;
export const GitSnapshotSchema = z.strictObject({
  schema: z.literal('git-snapshot-v1'), head: z.string().regex(/^[a-f0-9]{40,64}$/), branch: text, clean: z.boolean(),
  refsDigest: text, otherRefsDigest: text, remotesDigest: text, remoteHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
});
export type GitSnapshot = z.infer<typeof GitSnapshotSchema>;
export const GitCheckpointPlanSchema = z.strictObject({
  schema: z.literal('git-checkpoint-plan-v1'), id: IdSchema, before: GitSnapshotSchema,
  worktreeDigest: z.string().regex(/^[a-f0-9]{64}$/), tree: CommitIdSchema, after: CommitIdSchema,
});
export type GitCheckpointPlan = z.infer<typeof GitCheckpointPlanSchema>;
export const PublicationEventSchema = z.strictObject({
  schema: z.literal('publication-event-v1'), workId: IdSchema, status: z.enum(['published', 'blocked', 'external']),
  commit: text, attempts: z.number().int().nonnegative(), verificationId: IdSchema.optional(), savedRef: text.optional(), notice: text.optional(), verificationExemption: z.literal('memory-only').optional(),
});
export type PublicationEvent = z.infer<typeof PublicationEventSchema>;
const GitObjectSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const MemoryPublicationScopeSchema = z.strictObject({ schema: z.literal('memory-publication-scope-v1'), workId: IdSchema, baseCommit: GitObjectSchema, commit: GitObjectSchema, upstream: GitObjectSchema });
const GitConflictSideSchema = z.strictObject({ mode: z.string().regex(/^[0-7]{6}$/), oid: GitObjectSchema, content: z.string().nullable() });
export const GitConflictSchema = z.strictObject({ schema: z.literal('git-conflict-v1'), path: RelativePathSchema,
  base: GitConflictSideSchema.nullable(), upstream: GitConflictSideSchema.nullable(), local: GitConflictSideSchema.nullable() });
export type GitConflict = z.infer<typeof GitConflictSchema>;
export const GitConflictResolutionSchema = z.strictObject({ schema: z.literal('git-conflict-resolution-v1'), path: RelativePathSchema, content: z.string(), mode: z.enum(['100644', '100755']) });
export type GitConflictResolution = z.infer<typeof GitConflictResolutionSchema>;
export const MemoryConflictMergeSchema = z.strictObject({ schema: z.literal('memory-conflict-merge-v1'), workId: IdSchema, deviceId: IdSchema, at: TimestampSchema,
  upstream: GitObjectSchema, commit: GitObjectSchema, files: z.array(z.strictObject({ path: RelativePathSchema, upstream: GitObjectSchema.nullable(), local: GitObjectSchema.nullable() })).min(1) });
export const ExclusionReasonSchema = z.enum(['needs-login', 'expired', 'usage-ceiling', 'cooling', 'disabled', 'no-account', 'paid-not-allowed', 'unsupported']);
export type ExclusionReason = z.infer<typeof ExclusionReasonSchema>;
export const JevCallSchema = z.strictObject({ schema: z.literal('jev-call-v1'), kind: z.enum(['action', 'model', 'memory']), requestedModel: text, returnedModel: text,
  usage: z.strictObject({ input_tokens: count, output_tokens: count }), latencyMs: z.number().nonnegative() });
export type JevCall = z.infer<typeof JevCallSchema>;
export const DecisionRecordSchema = z.strictObject({
  schema: z.literal('decision-v2'), id: IdSchema, conversationId: IdSchema, workId: IdSchema, n: z.number().int().positive(), generation: count,
  trigger: z.enum(['user-message', 'stretch-end', 'resume', 'steer', 'redo']), at: TimestampSchema, latencyMs: z.number().nonnegative(),
  redoOf: IdSchema.optional(), latestMessageEventId: count.optional(), questionSet: z.literal('q-v2').optional(), remember: z.boolean().optional(),
  jev: z.strictObject({ requestedModel: text, returnedModel: text, usage: z.unknown(), calls: count, records: z.array(JevCallSchema).optional() }).optional(),
  action: z.strictObject({ chosen: ActionSchema, source: z.enum(['jev', 'only-option', 'guard', 'override', 'redo', 'manual']), allowed: z.array(ActionSchema), probabilities: probabilities.optional(), confidence: z.number().min(0).max(1).optional(), guardReason: text.optional() }),
  model: z.strictObject({ chosen: IdSchema, source: z.enum(['kept', 'jev', 'only-option', 'pin', 'override', 'redo', 'manual']), keepCurrentP: z.number().min(0).max(1).optional(), eligible: z.array(z.strictObject({ modelId: IdSchema, p: z.number().min(0).max(1).optional() })), preferredAny: z.strictObject({ modelId: IdSchema, p: z.number().min(0).max(1).optional() }).optional(), excluded: z.array(z.strictObject({ modelId: IdSchema, reason: ExclusionReasonSchema })) }).optional(),
  effort: z.strictObject({ requested: EffortSchema, effective: EffortSchema, source: z.enum(['jev', 'pin', 'override', 'redo', 'manual']), probabilities: probabilities.optional() }).optional(),
  account: z.strictObject({ chosen: IdSchema, ranking: z.array(z.strictObject({ accountId: IdSchema, eligible: z.boolean(), reason: text })) }).optional(),
  device: z.strictObject({ chosen: IdSchema, source: z.literal('here') }).optional(),
  memory: z.strictObject({ candidates: z.array(text), chosen: z.array(text), scores: z.record(z.string(), z.number().min(0).max(3)).optional(), source: z.enum(['jev', 'search-rank']) }).optional(),
  context: z.strictObject({ project: text, action: ActionSchema, changeSize: z.enum(['small', 'medium', 'large']), riskyAreasTouched: z.array(text) }).optional(),
  composer: z.strictObject({ schema: z.literal('composer-bindings-v1'), stretch: z.number().int().positive().nullable(), choices: z.array(z.strictObject({ id: IdSchema, status: z.enum(['applied', 'superseded']) })) }).optional(),
  correctionsShown: z.array(IdSchema), notices: z.array(z.strictObject({ kind: z.enum(['preferred-needs-login', 'jev-unavailable', 'guard', 'effort-adjusted']), text, accountId: IdSchema.optional() })),
  outcome: z.strictObject({ stretch: z.number().int().positive(), status: StretchStatusSchema, handoffStatus: HandoffStatusSchema.optional() }).optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const ConversationIndexSchema = ConversationSchema.pick({ id: true, title: true, projectId: true, ownerDeviceId: true, state: true, updatedAt: true, current: true, outcome: true, origin: true }).extend({ schema: z.literal('conversation-index-v1') });
export type ConversationIndex = z.infer<typeof ConversationIndexSchema>;
export const DecisionIndexSchema = DecisionRecordSchema.pick({ id: true, conversationId: true, workId: true, at: true, notices: true, outcome: true }).extend({
  schema: z.literal('decision-index-v1'),
  action: DecisionRecordSchema.shape.action.pick({ chosen: true, source: true }),
  model: DecisionRecordSchema.shape.model.unwrap().pick({ chosen: true, source: true }).optional(),
  effort: DecisionRecordSchema.shape.effort.unwrap().pick({ requested: true, effective: true, source: true }).optional(),
});
export type DecisionIndex = z.infer<typeof DecisionIndexSchema>;
export function conversationIndex(value: Conversation): ConversationIndex {
  const { id, title, projectId, ownerDeviceId, state, updatedAt, current, outcome, origin } = ConversationSchema.parse(value);
  return ConversationIndexSchema.parse({ schema: 'conversation-index-v1', id, title, projectId, ownerDeviceId, state, updatedAt, ...(current ? { current } : {}), ...(outcome ? { outcome } : {}), ...(origin ? { origin } : {}) });
}
export function decisionIndex(value: DecisionRecord): DecisionIndex {
  const { id, conversationId, workId, at, notices, outcome, action, model, effort } = DecisionRecordSchema.parse(value);
  return DecisionIndexSchema.parse({ schema: 'decision-index-v1', id, conversationId, workId, at, notices, ...(outcome ? { outcome } : {}),
    action: { chosen: action.chosen, source: action.source }, ...(model ? { model: { chosen: model.chosen, source: model.source } } : {}),
    ...(effort ? { effort: { requested: effort.requested, effective: effort.effective, source: effort.source } } : {}) });
}

export const RiggingItemSchema = z.strictObject({
  schema: z.literal('rigging-item-v1'), id: IdSchema, runtime: IdSchema, name: text,
  kind: z.enum(['skill', 'mcp', 'hook', 'rule', 'setting', 'command']), state: z.enum(['owned', 'loose', 'parked']),
  enabled: z.boolean(), builtIn: z.boolean().default(false), content: z.string(), packageRef: text.optional(), bundle: RiggingBundleSchema.optional(), updatedAt: TimestampSchema,
});
export type RiggingItem = z.infer<typeof RiggingItemSchema>;
export const ErrorDocumentSchema = z.strictObject({ schema: z.literal('error-v1'), code: text, message: text, retryable: z.boolean().optional() });
export type DocumentSchema<T> = { parse(value: unknown): T };
