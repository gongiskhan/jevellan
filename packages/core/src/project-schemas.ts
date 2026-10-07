import { z } from 'zod';
import { CursorTranscriptSchema } from './cursor-schemas.js';
import { EffortSchema, IdSchema, JevCallSchema, TimestampSchema } from './schemas.js';

// Browser-safe: zod and shared schemas only. Every stored, sent or received Projects document lives here.
const text = z.string().min(1);
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const revision = count;

export const IsolationSchema = z.enum(['worktree', 'main']);
export type Isolation = z.infer<typeof IsolationSchema>;
export const PlacementFieldSchema = z.enum(['isolation', 'model', 'effort', 'device']);
export type PlacementField = z.infer<typeof PlacementFieldSchema>;
export const ThreadStateSchema = z.enum(['queued', 'preparing', 'running', 'idle', 'publishing', 'in-review',
  'waiting-for-you', 'attached', 'done', 'stopped', 'failed']);
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export const OptionSchema = z.strictObject({ label: z.string().min(1).max(120), detail: z.string().max(300).optional() });
export type Option = z.infer<typeof OptionSchema>;

// 5.1 hub namespace project-work-settings, key projectId
export const ProjectWorkSettingsSchema = z.strictObject({
  schema: z.literal('project-work-settings-v1'), projectId: IdSchema, revision,
  defaultIsolation: IsolationSchema,
  coordinator: z.strictObject({ modelId: IdSchema.nullable(), effort: EffortSchema }),
  setupCommand: z.string().max(500).nullable(),
  maxRunningThreads: z.number().int().min(1).max(20),
  maxRunningPerDevice: z.number().int().min(1).max(10),
  threadTurnCap: z.number().int().min(5).max(200),
});
export type ProjectWorkSettings = z.infer<typeof ProjectWorkSettingsSchema>;
export const ProjectRequestOutcomeSchema = z.strictObject({ schema: z.literal('project-request-outcome-v1'), projectId: IdSchema, eventId: IdSchema,
  goal: z.enum(['answer', 'change', 'run-app', 'verify', 'other']).nullable(), source: z.enum(['jev', 'unavailable']),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(), calls: z.array(JevCallSchema), at: TimestampSchema });
export type ProjectRequestOutcome = z.infer<typeof ProjectRequestOutcomeSchema>;
export const ProjectAppInputSchema = z.strictObject({ kind: z.enum(['static', 'command']), directory: z.string().min(1).max(4096).default('.'),
  command: z.string().min(1).max(4096).optional(), args: z.array(z.string().max(4096)).max(64).default([]),
  healthPath: z.string().startsWith('/').max(1000).default('/') })
  .refine(input => input.kind !== 'command' || !!input.command, 'A command app needs an executable.');
export const ProjectAppSchema = z.strictObject({ schema: z.literal('project-app-v1'), id: IdSchema, projectId: IdSchema, threadId: IdSchema,
  directory: z.string(), kind: z.enum(['static', 'command']), state: z.enum(['running', 'stopped']), url: z.url(),
  access: z.enum(['tailnet', 'local']), loopbackPort: z.number().int().min(1).max(65535), httpsPort: z.number().int().min(1).max(65535).optional(),
  startedAt: TimestampSchema, stoppedAt: TimestampSchema.optional() });
export type ProjectApp = z.infer<typeof ProjectAppSchema>;
export function defaultProjectWorkSettings(projectId: string): ProjectWorkSettings {
  return ProjectWorkSettingsSchema.parse({ schema: 'project-work-settings-v1', projectId, revision: 0, defaultIsolation: 'worktree',
    coordinator: { modelId: null, effort: 'medium' }, setupCommand: null, maxRunningThreads: 6, maxRunningPerDevice: 4, threadTurnCap: 30 });
}

// 5.2 hub namespace project-coordinators, key projectId
export const ProjectCoordinatorSchema = z.strictObject({ schema: z.literal('project-coordinator-v1'), projectId: IdSchema,
  revision, deviceId: IdSchema, assignedAt: TimestampSchema });
export type ProjectCoordinator = z.infer<typeof ProjectCoordinatorSchema>;

// 5.7 The fields stay unrefined so tool inputs can derive from them; zod 4 refuses .omit/.extend on refined objects.
export const ThreadReportStatusSchema = z.enum(['progress', 'done', 'needs-decision', 'blocked']);
export const ThreadReportFieldsSchema = z.strictObject({
  schema: z.literal('thread-report-v1'), turn: positive,
  status: ThreadReportStatusSchema,
  summary: z.string().min(1).max(1200), question: z.string().max(1000).optional(),
  options: z.array(OptionSchema).min(2).max(4).optional(),
  testsRun: z.strictObject({ command: z.string(), passed: z.boolean(), summary: z.string().max(600) }).optional(),
  changedFiles: z.array(z.string()).max(200).default([]), synthesized: z.boolean(),
});
export const NEEDS_DECISION_QUESTION = 'A needs-decision report needs a question.';
export function reportHasQuestion(report: { status: string; question?: string | undefined }): boolean {
  return report.status !== 'needs-decision' || !!report.question;
}
export const ThreadReportSchema = ThreadReportFieldsSchema.refine(reportHasQuestion, { message: NEEDS_DECISION_QUESTION, path: ['question'] });
export type ThreadReport = z.infer<typeof ThreadReportSchema>;

// 5.9 answer
export const DecisionAnswerFieldsSchema = z.strictObject({ optionLabel: z.string().max(120).optional(), text: z.string().max(4000).optional() });
export const DECISION_ANSWER_REQUIRED = 'Choose an option or write an answer.';
export function answerPresent(answer: { optionLabel?: string | undefined; text?: string | undefined }): boolean {
  return !!answer.optionLabel || !!answer.text;
}
export const DecisionAnswerSchema = DecisionAnswerFieldsSchema.refine(answerPresent, DECISION_ANSWER_REQUIRED);
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

// 5.4 every variant carries schema, kind, id and at.
const ev = <K extends string, S extends z.ZodRawShape>(kind: K, fields: S) => z.strictObject({
  schema: z.literal('coordinator-event-v1'), kind: z.literal(kind), id: IdSchema, at: TimestampSchema, ...fields });
export const CoordinatorEventSchema = z.discriminatedUnion('kind', [
  ev('user-message', { text: z.string().min(1).max(20000), clientMessageId: IdSchema }),
  ev('thread-report', { threadId: IdSchema, report: ThreadReportSchema }),
  ev('thread-published', { threadId: IdSchema, result: z.enum(['pr-opened', 'pr-updated', 'main-published', 'no-changes', 'checkout-completed']),
    prNumber: positive.optional(), commit: z.string().optional() }),
  ev('thread-verification-failed', { threadId: IdSchema, attempts: positive, tail: z.string().max(4000) }),
  ev('thread-interrupted', { threadId: IdSchema, reason: z.enum(['restart', 'timeout', 'failed', 'stopped']), message: z.string().max(1000) }),
  ev('decision-answer', { decisionId: IdSchema, threadId: IdSchema.optional(), question: z.string(), answer: DecisionAnswerSchema }),
  ev('pr-update', { threadId: IdSchema, prNumber: positive, change: z.enum(['checks-failed', 'checks-passed', 'merged', 'closed', 'conflict']) }),
  ev('mail', { mailId: IdSchema, fromThreadId: IdSchema, subject: z.string().min(1).max(200), body: z.string().max(8000) }),
  ev('thread-user-message', { threadId: IdSchema, text: z.string().min(1).max(20000) }),
  ev('placement-override', { threadId: IdSchema, summary: z.string().max(400) }),
]);
export type CoordinatorEvent = z.infer<typeof CoordinatorEventSchema>;
export type CoordinatorEventKind = CoordinatorEvent['kind'];

// 5.3 owner-local <home>/projects/<pid>/coordinator.json
export const CoordinatorStateSchema = z.strictObject({
  schema: z.literal('coordinator-state-v1'), projectId: IdSchema,
  state: z.enum(['idle', 'running', 'unavailable']), unavailableReason: z.string().optional(),
  session: z.strictObject({ runtime: IdSchema, modelId: IdSchema, model: text, effort: EffortSchema, accountId: IdSchema,
    nativeSessionId: z.string().optional(), startedAt: TimestampSchema, turns: count }).nullable(),
  queue: z.array(CoordinatorEventSchema), failedTurnsInARow: count, lastTurnAt: TimestampSchema.optional(),
});
export type CoordinatorState = z.infer<typeof CoordinatorStateSchema>;

// 5.5
export const PullRequestStateSchema = z.strictObject({ number: positive, url: z.url(),
  state: z.enum(['open', 'merged', 'closed']), headSha: z.string(), checks: z.enum(['pending', 'passing', 'failing', 'none']),
  mergeable: z.enum(['clean', 'conflict', 'unknown']), updatedAt: TimestampSchema });
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;
// 5.8
export const PlacementRecordSchema = z.strictObject({ schema: z.literal('placement-v1'), questionSet: z.literal('p-v1'),
  source: z.enum(['jev', 'fixed', 'fallback']), fixed: z.array(PlacementFieldSchema), isolation: IsolationSchema,
  runtime: IdSchema, modelId: IdSchema, model: text, effortRequested: EffortSchema, effortEffective: EffortSchema,
  deviceId: IdSchema, accountId: IdSchema,
  probabilities: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  eligibleModels: z.array(IdSchema), excludedModels: z.array(z.strictObject({ modelId: IdSchema, reason: z.string() })),
  eligibleDevices: z.array(IdSchema), excludedDevices: z.array(z.strictObject({ deviceId: IdSchema, reason: z.string() })),
  error: z.strictObject({ kind: z.string(), message: z.string().max(300) }).optional(),
  jevCalls: z.array(JevCallSchema), decidedAt: TimestampSchema });
export type PlacementRecord = z.infer<typeof PlacementRecordSchema>;
// 5.5 owner-local <home>/projects/<pid>/threads/<tid>/thread.json
export const QueuedMessageSchema = z.strictObject({ id: IdSchema, from: z.enum(['coordinator', 'owner']),
  text: z.string().min(1).max(20000), at: TimestampSchema, interrupt: z.boolean() });
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
export const ThreadSchema = z.strictObject({
  schema: z.literal('project-thread-v1'), id: IdSchema, projectId: IdSchema,
  title: z.string().min(1).max(120), task: z.string().min(1).max(20000),
  createdAt: TimestampSchema, createdBy: z.enum(['coordinator', 'owner']),
  state: ThreadStateSchema, stateReason: z.string().max(400).optional(),
  isolation: IsolationSchema, placement: PlacementRecordSchema, gitPolicy: z.enum(['main', 'external']).optional(),
  ownerDeviceId: IdSchema, coordinatorDeviceId: IdSchema,
  cwd: z.string(), branch: z.string().optional(), baseBranch: z.string(), baseCommit: z.string(),
  turns: count, turnAllowance: z.number().int(),
  nativeSessionId: z.string().optional(), queuedMessages: z.array(QueuedMessageSchema),
  lastReport: ThreadReportSchema.optional(), verificationAttempts: count,
  pr: PullRequestStateSchema.optional(), publishedCommit: z.string().optional(),
  attach: z.strictObject({ startedAt: TimestampSchema }).optional(), endedAt: TimestampSchema.optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;
// 5.6 hub namespace project-threads, key threadId
export const ThreadIndexSchema = z.strictObject({ schema: z.literal('project-thread-index-v1'), revision,
  id: IdSchema, projectId: IdSchema, title: z.string().min(1).max(120), state: ThreadStateSchema, stateReason: z.string().max(400).optional(),
  isolation: IsolationSchema, gitPolicy: z.enum(['main', 'external']).optional(), ownerDeviceId: IdSchema, runtime: IdSchema, modelLabel: text, effort: EffortSchema,
  accountLabel: text, branch: z.string().optional(), pr: PullRequestStateSchema.optional(),
  lastSummary: z.string().max(400).optional(), turns: count,
  createdAt: TimestampSchema, updatedAt: TimestampSchema, endedAt: TimestampSchema.optional() });
export type ThreadIndex = z.infer<typeof ThreadIndexSchema>;
// 5.9 hub namespace project-decisions, key id
export const ProjectDecisionSchema = z.strictObject({ schema: z.literal('project-decision-v1'), revision,
  id: IdSchema, projectId: IdSchema, threadId: IdSchema.optional(), from: z.enum(['coordinator', 'thread']),
  question: z.string().min(1).max(2000), options: z.array(OptionSchema).max(4).default([]),
  createdAt: TimestampSchema, answeredAt: TimestampSchema.optional(), answer: DecisionAnswerSchema.optional(),
  withdrawnAt: TimestampSchema.optional() });
export type ProjectDecision = z.infer<typeof ProjectDecisionSchema>;
// 5.10 hub namespace project-notebooks, key projectId
export const ProjectNotebookSchema = z.strictObject({ schema: z.literal('project-notebook-v1'), projectId: IdSchema,
  revision, content: z.string().max(65536), updatedAt: TimestampSchema, updatedBy: z.enum(['coordinator', 'owner']) });
export type ProjectNotebook = z.infer<typeof ProjectNotebookSchema>;
// 5.11 hub namespaces project-mail and project-reservations
export const ProjectMailSchema = z.strictObject({ schema: z.literal('project-mail-v1'), revision,
  id: IdSchema, projectId: IdSchema, from: z.string().min(1), to: z.string().min(1),
  subject: z.string().min(1).max(200), body: z.string().max(8000), at: TimestampSchema, readBy: z.array(z.string()) });
export type ProjectMail = z.infer<typeof ProjectMailSchema>;
export const FileReservationSchema = z.strictObject({ schema: z.literal('file-reservation-v1'), revision,
  id: IdSchema, projectId: IdSchema, threadId: IdSchema, deviceId: IdSchema,
  paths: z.array(z.string().min(1).max(300)).min(1).max(50), reason: z.string().max(300),
  createdAt: TimestampSchema, expiresAt: TimestampSchema, releasedAt: TimestampSchema.optional() });
export type FileReservation = z.infer<typeof FileReservationSchema>;
// 5.12 hub namespace project-placement-overrides, key id
export const PlacementOverrideSchema = z.strictObject({ schema: z.literal('placement-override-v1'), id: IdSchema,
  projectId: IdSchema, threadId: IdSchema, mode: z.enum(['next-turn', 'restart']),
  changes: z.array(z.strictObject({ field: PlacementFieldSchema, from: z.string(), to: z.string() })).min(1),
  note: z.string().max(400).optional(), at: TimestampSchema });
export type PlacementOverride = z.infer<typeof PlacementOverrideSchema>;

// Owner-local sidecars and extra hub documents (D4, D5, D10). Never indexed, never in views.
export const TurnProcessSchema = z.strictObject({ turn: positive, pid: z.number().int().min(2), pgid: z.number().int().min(2),
  startIdentity: z.string().min(1).max(64).optional(), startedAt: TimestampSchema });
export type TurnProcess = z.infer<typeof TurnProcessSchema>;
// <home>/projects/<pid>/threads/<tid>/thread-local.json
export const ThreadLocalSchema = z.strictObject({ schema: z.literal('thread-local-v1'),
  process: TurnProcessSchema.optional(),
  pushedCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  gitIdentity: z.strictObject({ name: z.string(), email: z.string() }).optional(),
  prNotified: z.strictObject({ headSha: z.string(), checks: z.enum(['failing', 'passing']).optional(), conflict: z.boolean().optional() }).optional(),
  seenCommands: z.array(IdSchema).max(200).optional(),
  // Owner thread messages already taken, by clientMessageId with the digest of their text (D153): retries repeat.
  seenMessages: z.array(z.strictObject({ id: IdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) })).max(200).optional(),
  // phase 5: the event of the needs-decision report the thread waits on, and whether this device asked the owner directly because the
  // coordinator's device was away (decision 7, D280)
  decisionReport: z.strictObject({ eventId: IdSchema, at: TimestampSchema, asked: z.boolean() }).optional(),
  // Index labels (D138): the menu label at placement and the account label of the latest turn.
  labels: z.strictObject({ modelLabel: text, accountLabel: text }).optional(),
  // phase 8: a main thread that ended while its checkout claim was not settled (D291): every sweep settles it again (a release after a
  // publication or a conclusion without changes, or the stop settlement) until the claim is released; `message` is the last failure.
  // `seen` (P8 review N-2): the checkout as the first stop refused because someone else had it (off main, or another agent active) saw
  // it: local main's tip and, when it was on main, its working tree digest; a later stop settlement changes git only while it still is
  unsettledCheckout: z.strictObject({ settle: z.enum(['published', 'unchanged', 'stop']), message: z.string().max(400).optional(),
    seen: z.strictObject({ main: z.string().regex(/^[0-9a-f]{40,64}$/), tree: z.string().regex(/^[0-9a-f]{64}$/).optional() }).optional() }).optional(),
  // phase 8: a turn that waited because a terminal holds its account; it runs first when the thread takes its next turn
  pendingTurn: z.strictObject({ reason: z.enum(['task', 'verification', 'conflict']), body: z.string().min(1).max(40_000) }).optional() });
export type ThreadLocal = z.infer<typeof ThreadLocalSchema>;
// <home>/projects/<pid>/coordinator-local.json
export const CoordinatorLocalSchema = z.strictObject({ schema: z.literal('coordinator-local-v1'),
  process: TurnProcessSchema.optional(), deliveredTurn: count.default(0),
  fallbackEventIds: z.array(IdSchema).max(500).default([]),
  // phase 5: events this device handed over to a coordinator that moved away (3.5.4, D271), the newest 500; they no longer count as received here
  forwardedEventIds: z.array(IdSchema).max(500).optional() });
export type CoordinatorLocal = z.infer<typeof CoordinatorLocalSchema>;
// hub namespace project-coordinator-status, key projectId; written only by the coordinator device
export const ProjectCoordinatorStatusSchema = z.strictObject({ schema: z.literal('project-coordinator-status-v1'),
  revision, projectId: IdSchema, deviceId: IdSchema,
  state: z.enum(['idle', 'running', 'unavailable']), unavailableReason: z.string().max(400).optional(),
  failedTurnsInARow: count,
  session: z.strictObject({ runtime: IdSchema, modelLabel: text, effort: EffortSchema, accountLabel: text, turns: count }).nullable(),
  // phase 5: the coordinator ledger's last event id when published, so other devices' work views bound the chat history (D268)
  lastEventId: count.optional(),
  updatedAt: TimestampSchema });
export type ProjectCoordinatorStatus = z.infer<typeof ProjectCoordinatorStatusSchema>;
// hub namespace project-thread-cursors, key threadId
export const ThreadIndexCursorSchema = z.strictObject({ schema: z.literal('project-thread-cursor-v1'),
  threadId: IdSchema, deviceId: IdSchema, eventId: positive, digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ThreadIndexCursor = z.infer<typeof ThreadIndexCursorSchema>;
// <home>/projects/<pid>/requests/<clientRequestId>.json
export const ThreadStartReceiptSchema = z.strictObject({ schema: z.literal('thread-start-receipt-v1'),
  clientRequestId: IdSchema, digest: z.string(), threadId: IdSchema, at: TimestampSchema,
  // phase 5: what the start answered, so a retry still answers once the thread lives on another device (D264)
  started: z.strictObject({ state: ThreadStateSchema, stateReason: z.string().max(400).optional(), placement: z.string() }).optional() });
export type ThreadStartReceipt = z.infer<typeof ThreadStartReceiptSchema>;

// Cross-device delivery (used from phase 5).
export const ThreadCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('dispatch') }),
  z.strictObject({ type: z.literal('message'), message: QueuedMessageSchema }),
  // `notify`: a stop by the owner tells the coordinator (D28); a coordinator stop does not.
  z.strictObject({ type: z.literal('stop'), reason: z.string().max(400), notify: z.boolean().optional() }),
  z.strictObject({ type: z.literal('discard') }),
  z.strictObject({ type: z.literal('allow-turns') }),
  z.strictObject({ type: z.literal('override-next-turn'), override: PlacementOverrideSchema }),
]);
export type ThreadCommand = z.infer<typeof ThreadCommandSchema>;
// hub namespace project-envelopes, key envelope id
export const ProjectEnvelopeSchema = z.strictObject({ schema: z.literal('project-envelope-v1'), revision,
  id: IdSchema, projectId: IdSchema, sourceDeviceId: IdSchema, targetDeviceId: IdSchema,
  seq: positive, createdAt: TimestampSchema, deliveredAt: TimestampSchema.optional(),
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('coordinator-event'), event: CoordinatorEventSchema }),
    z.strictObject({ kind: z.literal('thread-start'), thread: ThreadSchema }),
    z.strictObject({ kind: z.literal('thread-command'), threadId: IdSchema, commandId: IdSchema, command: ThreadCommandSchema }),
  ]) });
export type ProjectEnvelope = z.infer<typeof ProjectEnvelopeSchema>;
// <home>/projects/<pid>/outbox/<seq padded 12>-<envelopeId>.json; 'coordinator' resolves the assignment at drain time
export const OutboxEntrySchema = z.strictObject({ schema: z.literal('project-outbox-entry-v1'),
  target: z.union([z.literal('coordinator'), IdSchema]),
  envelope: ProjectEnvelopeSchema.omit({ targetDeviceId: true, revision: true }) });
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
// <home>/projects/<pid>/outbox/seq.json: the last sequence number used, written before the entry it numbers
export const OutboxSeqSchema = z.strictObject({ schema: z.literal('project-outbox-seq-v1'), seq: count });
export type OutboxSeq = z.infer<typeof OutboxSeqSchema>;
// <home>/projects/inbox-seen.json: envelope ids this device processed, oldest first (2.6.15, D90)
export const INBOX_SEEN_LIMIT = 2000;
export const InboxSeenSchema = z.strictObject({ schema: z.literal('project-inbox-seen-v1'), ids: z.array(IdSchema).max(INBOX_SEEN_LIMIT) });
export type InboxSeen = z.infer<typeof InboxSeenSchema>;

// Project ledger (brief 5.13, D2). data stays unknown in the envelope: payloads over 64 KiB spill to a blob-ref.
export const ProjectLedgerEventTypeSchema = z.enum(['coordinator-turn-start', 'coordinator-text', 'coordinator-tool',
  'coordinator-turn-end', 'coordinator-event', 'thread-turn-start', 'thread-turn-end', 'thread-report',
  'thread-placement', 'thread-state', 'thread-verification', 'thread-publication', 'notice']);
export type ProjectLedgerEventType = z.infer<typeof ProjectLedgerEventTypeSchema>;
export const ProjectLedgerEventSchema = z.strictObject({ schema: z.literal('project-ledger-event-v1'), t: TimestampSchema,
  id: positive, type: ProjectLedgerEventTypeSchema, turn: positive.optional(), data: z.unknown() });
export type ProjectLedgerEvent = z.infer<typeof ProjectLedgerEventSchema>;
export const ProjectEventFrameSchema = z.strictObject({ schema: z.literal('project-event-v1'), event: ProjectLedgerEventSchema });
export type ProjectEventFrame = z.infer<typeof ProjectEventFrameSchema>;

export const CoordinatorTurnStartSchema = z.strictObject({ schema: z.literal('coordinator-turn-v1'), turn: positive, fresh: z.boolean(),
  runtime: IdSchema, modelLabel: text, effort: EffortSchema, accountLabel: text, eventIds: z.array(IdSchema) });
export const CoordinatorTextSchema = z.strictObject({ schema: z.literal('coordinator-text-v1'), text });
// tool is any bridge tool name; the ledger writer checks it against the bridge registry (bridge-schemas imports this module).
export const CoordinatorToolSchema = z.strictObject({ schema: z.literal('coordinator-tool-v1'), tool: IdSchema, ok: z.boolean(),
  summary: z.string().min(1).max(400), threadId: IdSchema.optional(), decisionId: IdSchema.optional(), reason: z.string().max(400).optional() });
export const CoordinatorTurnEndSchema = z.strictObject({ schema: z.literal('coordinator-turn-end-v1'), turn: positive,
  status: z.enum(['completed', 'failed', 'timed-out', 'interrupted', 'dropped']), error: z.string().max(1000).optional() });
export const ThreadTurnStartSchema = z.strictObject({ schema: z.literal('thread-turn-v1'), turn: positive, resumed: z.boolean(),
  runtime: IdSchema, modelId: IdSchema, model: text, effort: EffortSchema, accountId: IdSchema });
export const ThreadTurnEndSchema = z.strictObject({ schema: z.literal('thread-turn-end-v1'), turn: positive,
  status: z.enum(['completed', 'failed', 'timed-out', 'interrupted', 'steered', 'stopped']), error: z.string().optional() });
export const ThreadStateChangeSchema = z.strictObject({ schema: z.literal('thread-state-v1'), from: ThreadStateSchema.nullable(),
  to: ThreadStateSchema, reason: z.string().optional(), changed: z.array(z.string()) });
export const ThreadVerificationSchema = z.strictObject({ schema: z.literal('thread-verification-v1'), attempt: positive,
  command: z.string().nullable(), status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().optional(),
  timedOut: z.boolean(), commit: z.string(), outputRef: z.string().optional(), tail: z.string().max(4000) });
export const ThreadPublicationSchema = z.strictObject({ schema: z.literal('thread-publication-v1'),
  result: z.enum(['pr-opened', 'pr-updated', 'main-published', 'no-changes', 'branch-pushed', 'local-only', 'conflict', 'pr-state', 'cleanup', 'checkout-completed']),
  prNumber: positive.optional(), commit: z.string().optional(), branch: z.string().optional(), pr: PullRequestStateSchema.optional(),
  files: z.array(z.string()).optional() });
export const ProjectNoticeSchema = z.strictObject({ schema: z.literal('project-notice-v1'), text, kind: z.enum(['info', 'error']) });
export const ProjectLedgerDataSchemas = {
  'coordinator-turn-start': CoordinatorTurnStartSchema, 'coordinator-text': CoordinatorTextSchema,
  'coordinator-tool': CoordinatorToolSchema, 'coordinator-turn-end': CoordinatorTurnEndSchema,
  'coordinator-event': CoordinatorEventSchema, 'thread-turn-start': ThreadTurnStartSchema, 'thread-turn-end': ThreadTurnEndSchema,
  'thread-report': ThreadReportSchema, 'thread-placement': PlacementRecordSchema, 'thread-state': ThreadStateChangeSchema,
  'thread-verification': ThreadVerificationSchema, 'thread-publication': ThreadPublicationSchema, notice: ProjectNoticeSchema,
} as const satisfies Record<ProjectLedgerEventType, z.ZodType>;
export type ProjectLedgerData<T extends ProjectLedgerEventType> = z.output<(typeof ProjectLedgerDataSchemas)[T]>;
/** Validates a resolved ledger payload (blobs already read) against its event type. */
export function parseProjectLedgerData<T extends ProjectLedgerEventType>(type: T, data: unknown): ProjectLedgerData<T> {
  return ProjectLedgerDataSchemas[ProjectLedgerEventTypeSchema.parse(type) as T].parse(data) as ProjectLedgerData<T>;
}

// HTTP views (brief 11)
const CoordinatorStateNameSchema = z.enum(['idle', 'running', 'unavailable', 'offline', 'none']);
export const ProjectWorkListViewSchema = z.strictObject({ schema: z.literal('project-work-list-view-v1'),
  projects: z.array(z.strictObject({ projectId: IdSchema, name: text, waiting: count, running: count, inReview: count,
    coordinator: z.strictObject({ deviceId: IdSchema.nullable(), state: CoordinatorStateNameSchema }) })) });
export type ProjectWorkListView = z.infer<typeof ProjectWorkListViewSchema>;
export const CoordinatorViewSchema = z.strictObject({ state: CoordinatorStateNameSchema,
  unavailableReason: z.string().optional(), deviceId: IdSchema.nullable(), deviceName: z.string().nullable(), online: z.boolean(),
  session: z.strictObject({ runtime: IdSchema, modelLabel: text, effort: EffortSchema, accountLabel: text, turns: count }).nullable(),
  planned: z.strictObject({ runtime: IdSchema, modelLabel: text, effort: EffortSchema }).nullable(),
  canMoveHere: z.boolean(), offlineSince: TimestampSchema.optional(),
  // phase 5: why this device cannot take the coordinator although the move rule allows it (no model, account or checkout here, D282)
  moveRefusal: z.string().max(400).optional() });
export type CoordinatorView = z.infer<typeof CoordinatorViewSchema>;
export const PullRequestEntrySchema = z.strictObject({ threadId: IdSchema, title: text, branch: z.string().optional(),
  pr: PullRequestStateSchema.optional(), reason: z.string().optional() });
export type PullRequestEntry = z.infer<typeof PullRequestEntrySchema>;
// phase 5: one roster device as a new thread of the project sees it; `reason` says why no thread can run there (D281)
export const ProjectDeviceSetupSchema = z.strictObject({ schema: z.literal('project-device-setup-v1'), deviceId: IdSchema, name: text, reason: z.string().max(400).optional() });
export type ProjectDeviceSetup = z.infer<typeof ProjectDeviceSetupSchema>;
export const ProjectWorkViewSchema = z.strictObject({ schema: z.literal('project-work-view-v1'),
  project: z.strictObject({ id: IdSchema, name: text, branchPolicy: z.enum(['main', 'external']), baseBranch: z.string().nullable() }),
  settings: ProjectWorkSettingsSchema, settingsNotice: z.string().optional(),
  coordinator: CoordinatorViewSchema, threads: z.array(ThreadIndexSchema),
  decisions: z.strictObject({ open: z.array(ProjectDecisionSchema), answered: z.array(ProjectDecisionSchema).max(10) }),
  pullRequests: z.array(PullRequestEntrySchema), notebookRevision: count, lastEventId: count,
  // The placement phase gates (D88) this device applies, so the interface disables what placement would refuse (D221).
  gates: z.strictObject({ mainIsolation: z.boolean(), remoteDevices: z.boolean() }),
  // phase 5: every roster device that is not revoked, in roster order, so New thread and Override disable what placement refuses (D281)
  devices: z.array(ProjectDeviceSetupSchema).optional() });
export type ProjectWorkView = z.infer<typeof ProjectWorkViewSchema>;
export const ThreadViewSchema = z.strictObject({ schema: z.literal('project-thread-view-v1'),
  thread: ThreadIndexSchema, placement: PlacementRecordSchema, reports: z.array(ThreadReportSchema),
  transcript: CursorTranscriptSchema.nullable(), queuedMessages: z.array(QueuedMessageSchema),
  canMessage: z.boolean(), turnAllowance: count,
  deviceName: z.string(), baseBranch: z.string(), attach: z.strictObject({ startedAt: TimestampSchema }).optional(),
  attachCommand: z.string(), canOverride: z.strictObject({ nextTurn: z.boolean(), restart: z.boolean(), restartReason: z.string().optional() }),
  canDiscard: z.boolean(), atTurnLimit: z.boolean(),
  // phase 8: why Stop is not offered (an attached thread), and why a concluded main thread still holds the project checkout
  stopRefusal: z.string().max(400).optional(), checkoutHeld: z.string().max(400).optional() });
export type ThreadView = z.infer<typeof ThreadViewSchema>;

// HTTP requests. No-argument POSTs send EmptySchema.
export const CoordinatorMessageRequestSchema = z.strictObject({ schema: z.literal('coordinator-message-request-v1'),
  clientMessageId: IdSchema, text: z.string().min(1).max(20000) });
export const ThreadCreateRequestSchema = z.strictObject({ schema: z.literal('thread-create-request-v1'), clientRequestId: IdSchema,
  title: z.string().min(1).max(120), task: z.string().min(1).max(20000),
  isolation: IsolationSchema.optional(), modelId: IdSchema.optional(), effort: EffortSchema.optional(), deviceId: IdSchema.optional(),
  // A restart's owner note for placement, sent by the thread's device to the coordinator device (D266); the New thread form sends none.
  note: z.string().max(400).optional() });
export const ThreadMessageRequestSchema = z.strictObject({ schema: z.literal('thread-message-request-v1'),
  clientMessageId: IdSchema, text: z.string().min(1).max(20000), interrupt: z.boolean() });
export const ThreadStopRequestSchema = z.strictObject({ schema: z.literal('thread-stop-request-v1'), reason: z.string().max(400).optional() });
export const ThreadOverrideRequestSchema = z.strictObject({ schema: z.literal('thread-override-request-v1'), clientRequestId: IdSchema,
  mode: PlacementOverrideSchema.shape.mode, isolation: IsolationSchema.optional(), modelId: IdSchema.optional(),
  effort: EffortSchema.optional(), deviceId: IdSchema.optional(), note: z.string().max(400).optional() });
export const DecisionAnswerRequestSchema = z.strictObject({ schema: z.literal('decision-answer-request-v1'), clientRequestId: IdSchema,
  ...DecisionAnswerFieldsSchema.shape }).refine(answerPresent, DECISION_ANSWER_REQUIRED);
export const ProjectWorkSettingsRequestSchema = z.strictObject({ schema: z.literal('project-work-settings-request-v1'), revision,
  settings: ProjectWorkSettingsSchema.omit({ schema: true, projectId: true, revision: true }), clientRequestId: IdSchema.optional() });
export const NotebookRequestSchema = z.strictObject({ schema: z.literal('notebook-request-v1'), expectedRevision: revision,
  content: z.string().max(65536) });

// HTTP results
export const ProjectNotebookViewSchema = z.strictObject({ schema: z.literal('project-notebook-view-v1'),
  notebook: ProjectNotebookSchema.nullable(), revision });
export const ThreadCreatedViewSchema = z.strictObject({ schema: z.literal('thread-created-view-v1'), threadId: IdSchema,
  state: ThreadStateSchema, placement: z.string() });
export const MergeResultViewSchema = z.strictObject({ schema: z.literal('pull-request-merge-view-v1'), merged: z.boolean(),
  message: z.string().optional() });
export const ProjectWorkSettingsViewSchema = z.strictObject({ schema: z.literal('project-work-settings-view-v1'),
  settings: ProjectWorkSettingsSchema, notice: z.string().optional() });
export const CoordinatorMessageReceiptSchema = z.strictObject({ schema: z.literal('coordinator-message-receipt-v1'), repeated: z.boolean() });
/** `POST .../threads/:tid/messages` answers 202 with this; a retried client message id repeats (D153, D170). */
export const ThreadMessageReceiptSchema = z.strictObject({ schema: z.literal('thread-message-receipt-v1'), repeated: z.boolean() });
export const ThreadOverrideViewSchema = z.strictObject({ schema: z.literal('thread-override-view-v1'), newThreadId: IdSchema.optional() });
export const DecisionAnsweredViewSchema = z.strictObject({ schema: z.literal('decision-answered-view-v1'), repeated: z.boolean() });

// Terminal takeover (phase 7): local control only, never redacted, never sent off the loopback socket.
export const ThreadAttachRequestSchema = z.strictObject({ schema: z.literal('thread-attach-request-v1') });
export const ThreadAttachViewSchema = z.strictObject({ schema: z.literal('thread-attach-v1'), cwd: text,
  runtime: z.enum(['claude', 'codex']), nativeSessionId: text, model: text, effort: EffortSchema,
  env: z.record(z.string(), z.string()), deviceName: z.string() });
export const ThreadDetachRequestSchema = z.strictObject({ schema: z.literal('thread-detach-request-v1'), exitCode: z.number().int().nullable() });
export const ThreadDetachViewSchema = z.strictObject({ schema: z.literal('thread-detach-v1'), adopted: z.boolean(), state: ThreadStateSchema });
