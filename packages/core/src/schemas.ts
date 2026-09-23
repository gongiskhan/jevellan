import { z } from 'zod';

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
export const ConfigurationSchema = z.strictObject({
  name: text, version: text,
  dependencies: z.strictObject({ apm: z.array(z.union([text, z.strictObject({ path: text }), z.strictObject({ repo: text })])) }),
  'x-jevellan': z.strictObject({
    schema: z.literal(1), runtimes: z.record(IdSchema, z.strictObject({ enabled: z.boolean() })),
    decisions: z.strictObject({ provider: z.literal('jev'), model: text, timeoutMs: z.number().int().positive(), keepCurrentThreshold: z.number().min(0).max(1) }),
    menu: z.array(ModelOptionSchema).max(19), effortGuide: z.record(EffortSchema, text), routingProfile: text, guards: GuardsSchema,
  }),
}).superRefine((value, ctx) => {
  const ids = value['x-jevellan'].menu.map((model) => model.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Model menu ids must be unique.', path: ['x-jevellan', 'menu'] });
});
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
export const AccountStatusSchema = z.strictObject({
  schema: z.literal('account-status-v1'), accountId: IdSchema, deviceId: IdSchema, auth: AuthSchema,
  usage: AccountUsageSchema.optional(), coolingUntil: TimestampSchema.optional(), lastError: z.string().optional(), observedAt: TimestampSchema,
});
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
export const ConversationSchema = z.strictObject({
  schema: z.literal('conversation-v2'), id: IdSchema, title: text, projectId: IdSchema, ownerDeviceId: IdSchema,
  createdAt: TimestampSchema, updatedAt: TimestampSchema, state: ConversationStateSchema, generation: count,
  current: z.strictObject({ modelId: IdSchema, effort: EffortSchema }).optional(), pins: z.strictObject({ modelId: IdSchema.optional(), effort: EffortSchema.optional() }),
  stretchCount: count, work: WorkSchema.nullable(), outcome: z.strictObject({ kind: z.literal('finished-elsewhere'), reason: text.optional(), at: TimestampSchema }).optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
export const SummarySchema = z.strictObject({
  schema: z.literal('summary-v2'), objective: z.string(), state: z.string(), decisions: z.array(z.string()), nextWork: z.string(), updatedAtStretch: count,
});
export type Summary = z.infer<typeof SummarySchema>;
export const NativeProcessSchema = z.strictObject({ pid: z.number().int().min(2), pgid: z.number().int().min(2), sessionId: text.optional() });
export const StretchStatusSchema = z.enum(['running', 'completed', 'interrupted', 'failed', 'timed-out', 'undone']);
export const UsageSchema = z.strictObject({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), costUsd: z.number().nonnegative().optional(), costSource: z.enum(['reported', 'estimated', 'unknown']) });
export const StretchSchema = z.strictObject({
  schema: z.literal('stretch-v2'), n: z.number().int().positive(), workId: IdSchema, action: ActionSchema, modelId: IdSchema, runtime: IdSchema, model: text,
  effortRequested: EffortSchema, effortEffective: EffortSchema, accountId: IdSchema, deviceId: IdSchema, decisionId: IdSchema,
  native: NativeProcessSchema.optional(), startedAt: TimestampSchema, endedAt: TimestampSchema.optional(), status: StretchStatusSchema, usage: UsageSchema,
  gitBefore: text.optional(), gitAfter: text.optional(),
});
export type Stretch = z.infer<typeof StretchSchema>;
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
  command: text, exitCode: z.number().int(), passed: z.boolean(), outputRef: text, commit: text, treeClean: z.boolean(),
}).refine((value) => value.passed === (value.exitCode === 0), 'Verification success must match the exit code.');
export type Verification = z.infer<typeof VerificationSchema>;
export const LedgerEventSchema = z.strictObject({
  schema: z.literal('ledger-event-v1'), t: TimestampSchema, id: z.number().int().positive(),
  type: z.enum(['user-message', 'note', 'stretch-start', 'text', 'tool-start', 'tool-end', 'usage', 'finding', 'handoff', 'stretch-end', 'decision', 'override', 'undo', 'steer', 'allowance', 'verification', 'publication', 'ownership', 'memory-queued', 'notice', 'git', 'error', 'state']),
  stretch: z.number().int().positive().optional(), data: z.unknown(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export const ExclusionReasonSchema = z.enum(['needs-login', 'expired', 'usage-ceiling', 'cooling', 'disabled', 'no-account', 'paid-not-allowed', 'unsupported']);
export type ExclusionReason = z.infer<typeof ExclusionReasonSchema>;
export const DecisionRecordSchema = z.strictObject({
  schema: z.literal('decision-v2'), id: IdSchema, conversationId: IdSchema, workId: IdSchema, n: z.number().int().positive(), generation: count,
  trigger: z.enum(['user-message', 'stretch-end', 'resume', 'steer', 'redo']), at: TimestampSchema, latencyMs: z.number().nonnegative(),
  jev: z.strictObject({ requestedModel: text, returnedModel: text, usage: z.unknown(), calls: count }).optional(),
  action: z.strictObject({ chosen: ActionSchema, source: z.enum(['jev', 'only-option', 'guard', 'override', 'redo', 'manual']), allowed: z.array(ActionSchema), probabilities: probabilities.optional(), confidence: z.number().min(0).max(1).optional(), guardReason: text.optional() }),
  model: z.strictObject({ chosen: IdSchema, source: z.enum(['kept', 'jev', 'only-option', 'pin', 'override', 'redo', 'manual']), keepCurrentP: z.number().min(0).max(1).optional(), eligible: z.array(z.strictObject({ modelId: IdSchema, p: z.number().min(0).max(1).optional() })), preferredAny: z.strictObject({ modelId: IdSchema, p: z.number().min(0).max(1).optional() }).optional(), excluded: z.array(z.strictObject({ modelId: IdSchema, reason: ExclusionReasonSchema })) }).optional(),
  effort: z.strictObject({ requested: EffortSchema, effective: EffortSchema, source: z.enum(['jev', 'pin', 'override', 'redo', 'manual']), probabilities: probabilities.optional() }).optional(),
  account: z.strictObject({ chosen: IdSchema, ranking: z.array(z.strictObject({ accountId: IdSchema, eligible: z.boolean(), reason: text })) }).optional(),
  device: z.strictObject({ chosen: IdSchema, source: z.literal('here') }).optional(),
  memory: z.strictObject({ candidates: z.array(text), chosen: z.array(text), scores: z.record(z.string(), z.number().min(0).max(3)).optional(), source: z.enum(['jev', 'search-rank']) }).optional(),
  correctionsShown: z.array(IdSchema), notices: z.array(z.strictObject({ kind: z.enum(['preferred-needs-login', 'jev-unavailable', 'guard', 'effort-adjusted']), text })),
  outcome: z.strictObject({ stretch: z.number().int().positive(), status: StretchStatusSchema, handoffStatus: HandoffStatusSchema.optional() }).optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const RiggingItemSchema = z.strictObject({
  schema: z.literal('rigging-item-v1'), id: IdSchema, runtime: IdSchema, name: text,
  kind: z.enum(['skill', 'mcp', 'hook', 'rule', 'setting', 'command']), state: z.enum(['owned', 'loose', 'parked']),
  enabled: z.boolean(), builtIn: z.boolean().default(false), content: z.string(), packageRef: text.optional(), updatedAt: TimestampSchema,
});
export type RiggingItem = z.infer<typeof RiggingItemSchema>;
export const ErrorDocumentSchema = z.strictObject({ schema: z.literal('error-v1'), code: text, message: text });
export type DocumentSchema<T> = { parse(value: unknown): T };
