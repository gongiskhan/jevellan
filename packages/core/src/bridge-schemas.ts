import { SetupProposeInputSchema, SetupProposalResultSchema } from './project-setup-schemas.js';
import { ProjectSettingsUpdateSchema, ProjectSettingsChangeResultSchema, TasksStartInputSchema, TasksStartResultSchema } from './project-parity-schemas.js';
import { VerificationReportSchema } from './merge-schemas.js';
import { GithubInputSchema, GithubResultSchema } from './github-awareness-schemas.js';
import { ProjectDailyListViewSchema, ProjectJobListViewSchema, ProjectJobRunListViewSchema } from './project-daily-schemas.js';
import { GoalListViewSchema } from './project-goal-schemas.js';
import { z } from 'zod';
import { LibraryListInputSchema, LibraryGetInputSchema, LibraryAddInputSchema, ProjectLibraryItemSchema } from './library-schemas.js';
import { MemoryNoteSchema, MemorySearchSchema, MemoryWriteSchema, MemoryEditSchema } from './memory-note-schemas.js';
import { MemoryInboxInputSchema, MemoryArchiveInputSchema, MemoryDreamBodySchema } from './project-memory-schemas.js';
import { OwnerCommandsSchema } from './owner-command-schemas.js';
import { TerminalReadInputSchema, TerminalReadResultSchema } from './terminal-schemas.js';
export { MemoryNoteSchema, MemorySearchSchema, MemoryWriteSchema, MemoryEditSchema, type MemoryNote } from './memory-note-schemas.js';
import { ProjectReviewBodySchema, ReviewFollowupInputSchema } from './project-review-schemas.js';
import { ProjectWorkTaskSchema, TaskCreateRequestSchema, TaskReceiptSchema, TaskUpdateRequestSchema } from './project-loop-schemas.js';
import { EffortSchema, FindingSchema, HandoffSchema, IdSchema, ResultSchema, TimestampSchema } from './schemas.js';
import {
  IsolationSchema, NEEDS_DECISION_QUESTION, OptionSchema, ProjectAppInputSchema, ProjectAppSchema, PullRequestStateSchema, ThreadReportFieldsSchema, ThreadReportSchema,
  ThreadReportStatusSchema, ThreadStateSchema, reportHasQuestion,
} from './project-schemas.js';

const text = z.string().min(1);
export const MemoryProposalInputSchema = MemoryWriteSchema.extend({ reason: text.max(2000) });
export const MemoryProposalSchema = MemoryProposalInputSchema.extend({ schema: z.literal('memory-proposal-v1'), id: IdSchema, conversationId: IdSchema, workId: IdSchema, projectId: IdSchema, stretch: z.number().int().positive(), source: z.enum(['agent', 'handoff', 'hook']).default('agent') });
export const MemoryAppliedSchema = z.strictObject({
  schema: z.literal('memory-applied-v1'), workId: IdSchema, projectId: IdSchema, commit: z.string().nullable(),
  notes: z.array(z.strictObject({ proposalId: IdSchema, title: text, permalink: text, outcome: z.enum(['written', 'existing']) })).min(1),
});
export type MemoryApplied = z.infer<typeof MemoryAppliedSchema>;
export const HandoffToolSchema = HandoffSchema.extend({ result: z.union([ResultSchema, ResultSchema.omit({ ref: true }).extend({ content: z.json() })]).optional() });
export const IntegrationCommandSchema = z.strictObject({ schema: z.literal('integration-command-v1'), command: z.enum(['start', 'continue', 'skip']) });
export const IntegrationStatusSchema = z.strictObject({ schema: z.literal('integration-status-v1'), status: z.enum(['clean', 'conflict']), conflicts: z.array(text) });
export type IntegrationRunner = (command: z.infer<typeof IntegrationCommandSchema>['command']) => Promise<z.infer<typeof IntegrationStatusSchema>>;

// Project tools (brief 7, D11). Inputs are bare objects (the model sees their JSON schema); results are versioned
// documents inside bridge-result-v1. Every tool exists from phase 1; projectToolNames decides what a scope lists.
const count = z.number().int().nonnegative();
const reason = text.max(400);
export const ASK_USER_OPTIONS = 'Give no options or two to four options.';
export const ThreadsListInputSchema = z.strictObject({ include: z.enum(['active', 'all']).default('active') });
export const ThreadStartInputSchema = z.strictObject({
  title: text.max(120), task: text.max(20000), isolation: IsolationSchema.optional(), runtimeId: IdSchema.optional(), accountId: IdSchema.optional(), modelId: IdSchema.optional(),
  effort: EffortSchema.optional(), deviceId: IdSchema.optional(), note: z.string().max(600).optional(),
});
export const ThreadMessageInputSchema = z.strictObject({ threadId: IdSchema, message: text.max(20000), interrupt: z.boolean().default(false) });
export const ThreadReadInputSchema = z.strictObject({ threadId: IdSchema, detail: z.enum(['summary', 'transcript']).default('summary') });
export const ThreadStopInputSchema = z.strictObject({ threadId: IdSchema, reason });
export const AskUserInputSchema = z.strictObject({ question: text.max(2000), options: z.array(OptionSchema).max(4, ASK_USER_OPTIONS).optional(), threadId: IdSchema.optional(), ownerCommands: OwnerCommandsSchema.optional(), accountId: IdSchema.optional() })
  .refine((input) => input.options?.length !== 1, { message: ASK_USER_OPTIONS, path: ['options'] });
export const WithdrawQuestionInputSchema = z.strictObject({ decisionId: IdSchema, reason });
export const AnswerQuestionInputSchema = z.strictObject({ questionId: IdSchema, optionLabel: text.max(120).optional(), text: text.max(2000).optional() })
  .refine(input => !!input.optionLabel || !!input.text, 'Choose an option or write an answer.');
export const NotebookReadInputSchema = z.strictObject({});
export const NotebookWriteInputSchema = z.strictObject({ content: z.string().max(65536), expectedRevision: count });
export const PrStatusInputSchema = z.strictObject({ threadId: IdSchema });
export const PrDiffResultSchema = z.strictObject({ schema: z.literal('pr-diff-result-v1'), threadId: IdSchema, commit: z.string(),
  files: z.array(z.strictObject({ path: z.string(), additions: count, deletions: count, status: z.string() })).max(3000), diff: z.string().max(80000), shortened: z.boolean() });
export const MailSendInputSchema = z.strictObject({ to: text.max(128), subject: text.max(200), body: z.string().max(8000) });
export const MailInboxInputSchema = z.strictObject({});
export const ReservePathsSchema = z.array(text.max(300)).min(1).max(50);
export const ReserveInputSchema = z.strictObject({ paths: ReservePathsSchema, reason: z.string().max(300).default(''), minutes: z.number().int().min(1).max(120).default(60) });
export const ReleaseInputSchema = z.strictObject({ id: IdSchema.optional() });
// The daemon fills schema, turn and synthesized: false.
export const ThreadReportInputSchema = ThreadReportFieldsSchema.omit({ schema: true, turn: true, synthesized: true, fix: true })
  .refine(reportHasQuestion, { message: NEEDS_DECISION_QUESTION, path: ['question'] });

export const ThreadsListResultSchema = z.strictObject({ schema: z.literal('threads-list-result-v1'), threads: z.array(z.strictObject({
  id: IdSchema, title: text.max(120), state: ThreadStateSchema, isolation: IsolationSchema, device: text, runtime: IdSchema,
  modelLabel: text, effort: EffortSchema, branch: z.string().optional(), pr: PullRequestStateSchema.pick({ number: true, state: true, checks: true }).optional(),
  lastSummary: z.string().max(400).optional(), turns: count })) });
export const ThreadStartResultSchema = z.strictObject({ schema: z.literal('thread-start-result-v1'), threadId: IdSchema, state: ThreadStateSchema,
  stateReason: z.string().max(400).optional(), placement: text.max(400) });
export const ThreadMessageResultSchema = z.strictObject({ schema: z.literal('thread-message-result-v1'), threadId: IdSchema, state: ThreadStateSchema,
  delivery: z.enum(['started', 'queued', 'interrupting']) });
export const ThreadReadResultSchema = z.strictObject({ schema: z.literal('thread-read-result-v1'), threadId: IdSchema, state: ThreadStateSchema,
  stateReason: z.string().max(400).optional(), reports: z.array(ThreadReportSchema).max(3), pr: PullRequestStateSchema.optional(),
  transcript: z.string().max(8000).nullable().optional(), transcriptNote: z.string().max(400).optional() });
export const ThreadStopResultSchema = z.strictObject({ schema: z.literal('thread-stop-result-v1'), threadId: IdSchema, state: ThreadStateSchema });
export const OpenQuestionsResultSchema = z.strictObject({ schema: z.literal('open-questions-v1'), questions: z.array(z.strictObject({
  number: z.number().int().positive(), questionId: IdSchema, threadTitle: text.max(160), question: text.max(2000), options: z.array(text.max(120)).max(4) })).max(1000) });
export const AskUserResultSchema = z.strictObject({ schema: z.literal('ask-user-result-v1'), decisionId: IdSchema, openQuestions: OpenQuestionsResultSchema.optional() });
export const WithdrawQuestionResultSchema = z.strictObject({ schema: z.literal('withdraw-question-result-v1'), decisionId: IdSchema, withdrawn: z.boolean() });
export const NotebookReadResultSchema = z.strictObject({ schema: z.literal('notebook-read-result-v1'), content: z.string().max(65536), revision: count });
export const NotebookWriteResultSchema = z.strictObject({ schema: z.literal('notebook-write-result-v1'), revision: count });
export const PrStatusResultSchema = z.strictObject({ schema: z.literal('pr-status-result-v1'), threadId: IdSchema, pr: PullRequestStateSchema.nullable(),
  reason: z.string().max(400).optional() });
export const MailSendResultSchema = z.strictObject({ schema: z.literal('mail-send-result-v1'), mailId: IdSchema });
export const MailInboxResultSchema = z.strictObject({ schema: z.literal('mail-inbox-result-v1'), mail: z.array(z.strictObject({
  id: IdSchema, from: text, fromTitle: text, subject: text.max(200), body: z.string().max(8000), at: TimestampSchema })) });
export const ReserveResultSchema = z.discriminatedUnion('granted', [
  z.strictObject({ schema: z.literal('reserve-result-v1'), granted: z.literal(true), id: IdSchema }),
  z.strictObject({ schema: z.literal('reserve-result-v1'), granted: z.literal(false),
    conflicts: z.array(z.strictObject({ threadTitle: text, paths: ReservePathsSchema, expiresAt: TimestampSchema })).min(1) }),
]);
export const ReleaseResultSchema = z.strictObject({ schema: z.literal('release-result-v1'), released: count });
export const ThreadReportResultSchema = z.strictObject({ schema: z.literal('thread-report-result-v1'), turn: z.number().int().positive(),
  status: ThreadReportStatusSchema, accepted: z.literal(true), repeated: z.boolean() });

export const BridgeToolSchemas = {
  jevellan_finding: FindingSchema,
  jevellan_handoff: HandoffToolSchema,
  jevellan_conversation_search: z.strictObject({ query: text }),
  jevellan_conversation_read: z.strictObject({ pointer: text }),
  jevellan_integrate: IntegrationCommandSchema,
  memory_search: z.strictObject({ query: text }),
  memory_read: z.strictObject({ permalink: text }),
  memory_write: MemoryWriteSchema,
  memory_edit: MemoryEditSchema,
  jevellan_memory_inbox_add: MemoryInboxInputSchema,
  jevellan_memory_archive: MemoryArchiveInputSchema,
  jevellan_memory_dream_report: MemoryDreamBodySchema,
  memory_propose: MemoryProposalInputSchema,
  jevellan_threads_list: ThreadsListInputSchema,
  jevellan_tasks_list: z.strictObject({ include: z.enum(['open', 'all']).default('open'), goalId: IdSchema.nullable().optional() }),
  jevellan_goals_list: z.strictObject({}),
  jevellan_jobs_list: z.strictObject({}),
  jevellan_job_run: z.strictObject({ jobId: IdSchema }),
  jevellan_job_runs: z.strictObject({ jobId: IdSchema.optional() }),
  jevellan_daily_list: z.strictObject({}),
  jevellan_settings_update: ProjectSettingsUpdateSchema,
  jevellan_setup_propose: SetupProposeInputSchema,
  jevellan_library_list: LibraryListInputSchema, jevellan_library_get: LibraryGetInputSchema, jevellan_library_add: LibraryAddInputSchema,
  jevellan_tasks_start: TasksStartInputSchema,
  jevellan_task_create: TaskCreateRequestSchema.omit({ schema: true, clientRequestId: true }).extend({ source: z.enum(['owner-request', 'refill', 'finding']) }),
  jevellan_task_update: TaskUpdateRequestSchema.omit({ schema: true, expectedRevision: true, fixed: true, now: true }).extend({ taskId: IdSchema }),
  jevellan_task_cancel: z.strictObject({ taskId: IdSchema, reason: z.string().min(1).max(400) }),
  jevellan_thread_start: ThreadStartInputSchema,
  jevellan_thread_message: ThreadMessageInputSchema,
  jevellan_thread_read: ThreadReadInputSchema,
  jevellan_thread_stop: ThreadStopInputSchema,
  jevellan_ask_user: AskUserInputSchema,
  jevellan_answer_question: AnswerQuestionInputSchema,
  jevellan_github: GithubInputSchema,
  jevellan_terminal_read: TerminalReadInputSchema,
  jevellan_withdraw_question: WithdrawQuestionInputSchema,
  jevellan_notebook_read: NotebookReadInputSchema,
  jevellan_notebook_write: NotebookWriteInputSchema,
  jevellan_pr_status: PrStatusInputSchema,
  jevellan_pr_diff: PrStatusInputSchema,
  jevellan_verification_report: VerificationReportSchema,
  jevellan_project_review_report: ProjectReviewBodySchema,
  jevellan_review_followup: ReviewFollowupInputSchema,
  // Retired schema retained only so historical ledgers remain readable. Never offered by any scope.
  jevellan_mail_send: MailSendInputSchema,
  jevellan_mail_inbox: MailInboxInputSchema,
  jevellan_reserve: ReserveInputSchema,
  jevellan_release: ReleaseInputSchema,
  jevellan_thread_report: ThreadReportInputSchema,
  jevellan_app_start: ProjectAppInputSchema,
  jevellan_app_stop: z.strictObject({ appId: IdSchema }),
  jevellan_apps_list: z.strictObject({}),
};
export type BridgeTool = keyof typeof BridgeToolSchemas;
export const BridgeToolNameSchema = z.enum(Object.keys(BridgeToolSchemas) as [BridgeTool, ...BridgeTool[]]);
export const MemoryHookEventSchema = z.enum(['PreCompact', 'Stop', 'SessionEnd']);
export const BridgeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('list') }),
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('call'), name: BridgeToolNameSchema, arguments: z.json() }),
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('memory-capture'), event: MemoryHookEventSchema,
    sessionId: z.string().min(1).max(256).optional(), transcriptPath: z.string().min(1).max(4096).optional() }),
]);
export const BridgeResultSchema = z.strictObject({ schema: z.literal('bridge-result-v1'), result: z.json() });
export const BridgeToolsSchema = z.strictObject({ schema: z.literal('bridge-tools-v1'), tools: z.array(z.strictObject({ name: BridgeToolNameSchema, description: text, inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()) })) });
export function bridgeTools(names: BridgeTool[]): z.infer<typeof BridgeToolsSchema> {
  const descriptions: Record<BridgeTool, string> = {
    jevellan_memory_inbox_add: 'Write one durable inbox note with a short evidence quote. At most eight per extraction. Code supplies its provenance.',
    jevellan_memory_archive: 'Archive a memory note with a reason. Never deletes a note and never changes an owner note.',
    jevellan_memory_dream_report: 'End the nightly dream exactly once with a concise summary. Code computes counts from its notes commit diff.',
    jevellan_jobs_list: 'Read the owner-defined deterministic jobs, gates and enabled state. You cannot define or edit jobs.',
    jevellan_job_run: 'Queue one enabled job on the coordinator device. No model runs in a job. Repeated calls in a turn return the same task.',
    jevellan_job_runs: 'Read durable job receipts with the exact commit, result and redacted log tail.',
    jevellan_daily_list: 'Read daily items, today status and nightly window. You cannot define or edit daily items.',

    jevellan_pr_diff: 'Read the current pull request head and changed files, with a unified diff of up to 80,000 characters.',
    jevellan_project_review_report: 'End the read-only nightly review with one summary and findings covering every commit in its range.',
    jevellan_review_followup: 'Choose at most one combined code-review finding fix, or explicitly choose none, for the completed nightly review.',
    jevellan_verification_report: 'End the basic PR verification with exactly one passed or failed report, commands and bounded failures.',
    jevellan_app_start: 'Start an app and return a verified browser link. Static serves HTML; command runs an executable with args, replacing {port} and {host}. The app is owned by Jevellan and stays running after this turn. Use this when the owner wants to run or use the app, rather than opening a file on the server. Do not pass credentials.',
    jevellan_app_stop: 'Stop only this project’s managed app by its appId.',
    jevellan_apps_list: 'List this project’s managed apps and their browser links.',
    jevellan_finding: 'Record a finding with a concrete pointer. Prefix durable constraints with constraint: and decisions with decision:.',
    jevellan_handoff: 'Finish this stretch exactly once with an honest handoff. Supply the full plan or other result as result.content; the daemon stores its blob. Identical retries return the original receipt.',
    jevellan_conversation_search: 'Search only this conversation and return at most 20 excerpts with ledger pointers.',
    jevellan_conversation_read: 'Read a ledger event, handoff or result blob belonging to this conversation.',
    jevellan_integrate: 'Rebase this work onto its recorded upstream with tracked Git boundaries. Start the rebase, edit the reported conflicting files, then continue. Skip only when the current commit should contribute no change. Available only during integration.',
    memory_search: 'Search this project’s memory notes.',
    memory_read: 'Read one note from this project’s memory by permalink.',
    memory_write: 'Write durable project knowledge. Jevellan supplies provenance; hub notes are shared by all project sessions and committed locally. Other memory modes require checkout ownership.',
    memory_edit: 'Edit a project memory note. For replace, provide the exact text in find.',
    memory_propose: 'Queue a proposed memory note. It does not change the checkout; Jevellan applies it later under ownership.',
    jevellan_threads_list: 'List this project’s threads with their state, isolation, device, model, branch, pull request and last report summary. include: all adds threads that ended in the last 14 days.',
    jevellan_thread_start: 'Legacy immediate start for internal restart operations.',
    jevellan_tasks_list: 'Read the task queue, including drafts and linked threads. Open includes draft, queued, active and in-review tasks.',
    jevellan_goals_list: 'Read owner-defined goals, motivations, health, state, autonomy, limits and today counts. Goals can only be changed by the owner.',
    jevellan_task_create: 'Create a session task with a self-contained brief and type. Owner-request requires an owner message in this turn; only that source may use Now. Code decides proposal state, placement and dispatch. When the owner asks for a task but not to start it yet, pass held: true; it stays queued until jevellan_task_update sets held: false on the owner\'s word.',
    jevellan_setup_propose: 'Propose repository-supported setup once for this turn setup trigger. The owner chooses what to apply.',
    jevellan_settings_update: 'Change the permitted project settings only on the owner words in this turn. Every change appears in chat with Undo.',
    jevellan_library_list: 'List files in this project library. Optionally filter by name or note.',
    jevellan_library_get: 'Get a library file by id, mirrored locally when needed. Read the returned localPath.',
    jevellan_library_add: 'Keep a file from your worktree in the project library for the owner. Give its worktree-relative path.',
    jevellan_tasks_start: 'Start proposed or held tasks only when the owner says to start them in this turn. Give their task ids.',
    jevellan_task_update: 'Edit a draft or queued task before dispatch. Never reorder an owner-ranked task. held: false starts a held task when the owner says to start it.',
    jevellan_task_cancel: 'Cancel a draft or queued task. Stop active work through its thread.',
    jevellan_thread_message: 'Send a message to a thread. An idle or in-review thread starts a turn now; a running thread receives it as its next turn, or at once with interrupt: true. Threads that are attached, done, stopped or failed refuse messages.',
    jevellan_thread_read: 'Read a thread’s state, its last three reports and its pull request. detail: transcript adds the end of its assistant text.',
    jevellan_thread_stop: 'Stop a thread: end any running turn and mark it stopped. Its worktree and branch stay until the owner discards them.',
    jevellan_ask_user: 'Ask the owner a question. Give no options or two to four short options, and name the thread when the question comes from one. When the question asks the owner to sign in to an account, pass that accountId: the question is withdrawn once the account is Ready. The answer arrives later as an event.',
    jevellan_answer_question: 'Record an answer the owner gave in chat, only during a turn carrying an owner message. Match the numbered question and its exact option label. Then send the answer to the responsible thread with jevellan_thread_message.',
    jevellan_github: 'Read this project’s GitHub workflows, runs and failed job logs, pull requests from any author, or recent commits. Results are cached for 60 seconds. Threads may read only their own pull request and runs and job logs on its current head commit.',
    jevellan_terminal_read: 'Read the owner’s open terminals and their recent commands or output when the owner refers to a terminal. Read-only: never type or run commands in an owner terminal.',
    jevellan_withdraw_question: 'Withdraw an unanswered question, for example after a thread solved it.',
    jevellan_notebook_read: 'Read the project notebook: your durable record of decisions, conventions, owner preferences and the current plan.',
    jevellan_notebook_write: 'Replace the whole notebook, at most 64 KiB. Pass the revision you read; if it changed meanwhile, the error carries the current content.',
    jevellan_pr_status: 'Fetch a thread’s pull request state fresh from GitHub.',
    jevellan_mail_send: 'Send mail to coordinate the threads that work directly on main: to a thread id, to all (every other main thread), or from a thread to coordinator.',
    jevellan_mail_inbox: 'Read unread mail addressed to this thread or to all, and mark it read.',
    jevellan_reserve: 'Reserve repository paths (files, or directories ending in /) for up to 120 minutes, 60 by default, before editing them. Other threads see the reservation; a refusal lists the conflicting threads.',
    jevellan_release: 'Release one reservation by id, or every reservation of this thread when no id is given.',
    jevellan_thread_report: 'Report this turn’s outcome exactly once, at the end of the turn. needs-decision requires a question; options are two to four short choices. Explain the result for the owner, what they can see or do and how to try it. Include limitations, tests actually run and changed files. For visual work include captioned Markdown links to screenshots saved in the worktree. summary accepts up to 4,000 characters.',
  };
  return BridgeToolsSchema.parse({ schema: 'bridge-tools-v1', tools: names.map((name) => {
    const schema = z.toJSONSchema(BridgeToolSchemas[name], { io: 'input' });
    // MCP runtimes require an object at the root. Preserve the action union's validation and declare its properties at the root too.
    const inputSchema = name === 'jevellan_github' || name === 'jevellan_terminal_read' ? { ...schema, type: 'object', required: ['action'], additionalProperties: false,
      properties: Object.assign({}, ...(schema.anyOf ?? schema.oneOf ?? []).map(variant => variant.properties ?? {})) } : schema;
    return { name, description: descriptions[name], inputSchema };
  }) });
}

// Project scopes (D104). The coordinator's read-only Claude allow list and the bridge's scope lists both derive from
// projectToolNames, never a copy.
export const COORDINATOR_TOOLS = ['jevellan_setup_propose', 'jevellan_library_list', 'jevellan_library_get', 'jevellan_review_followup', 'jevellan_jobs_list', 'jevellan_job_run', 'jevellan_job_runs', 'jevellan_daily_list', 'jevellan_goals_list', 'jevellan_tasks_list', 'jevellan_task_create', 'jevellan_tasks_start', 'jevellan_settings_update', 'jevellan_task_update', 'jevellan_task_cancel', 'jevellan_threads_list', 'jevellan_thread_message', 'jevellan_thread_read', 'jevellan_thread_stop',
  'jevellan_ask_user', 'jevellan_answer_question', 'jevellan_github', 'jevellan_terminal_read', 'jevellan_withdraw_question', 'jevellan_notebook_read', 'jevellan_notebook_write', 'jevellan_pr_status', 'jevellan_pr_diff', 'jevellan_mail_send', 'memory_search', 'memory_read'] as const satisfies readonly BridgeTool[];
const MAIN_THREAD_TOOLS = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'] as const satisfies readonly BridgeTool[];
export type ProjectToolName = typeof COORDINATOR_TOOLS[number] | typeof MAIN_THREAD_TOOLS[number] | 'jevellan_library_add' | 'jevellan_thread_report' | 'jevellan_app_start' | 'jevellan_app_stop' | 'jevellan_apps_list' | 'memory_write' | 'memory_edit';
export function threadTools(isolation: 'worktree' | 'main'): BridgeTool[] {
  return ['jevellan_library_list', 'jevellan_library_get', 'jevellan_library_add', 'jevellan_thread_report', 'jevellan_github', 'jevellan_terminal_read', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read', ...(isolation === 'main' ? MAIN_THREAD_TOOLS : [])];
}
/** The tools a scope lists: the coordinator's, or a thread's by isolation (mail and reservations only on main, brief 7.2). A fresh array each call. */
export function projectToolNames(scope: ({ kind: 'coordinator' } | { kind: 'thread'; isolation: 'worktree' | 'main' }) & { memoryMode?: 'hub' | 'repo' | 'device' }): BridgeTool[] {
  return [...(scope.kind === 'coordinator' ? COORDINATOR_TOOLS : threadTools(scope.isolation)), ...(scope.memoryMode === 'hub' ? ['memory_write', 'memory_edit'] as const : [])];
}
/** The result document each project tool returns inside bridge-result-v1. */
export const ProjectToolResultSchemas = {
  jevellan_library_list: z.strictObject({ schema: z.literal('library-list-result-v1'), items: z.array(ProjectLibraryItemSchema).max(50) }),
  jevellan_library_get: z.strictObject({ schema: z.literal('library-file-result-v1'), localPath: z.string().min(1) }),
  jevellan_library_add: z.strictObject({ schema: z.literal('library-add-result-v1'), item: ProjectLibraryItemSchema, message: z.string() }),
  jevellan_review_followup: z.strictObject({ schema: z.literal('review-followup-receipt-v1'), taskId: IdSchema.nullable(), repeated: z.boolean() }),
  jevellan_jobs_list: ProjectJobListViewSchema,
  jevellan_job_run: TaskReceiptSchema,
  jevellan_job_runs: ProjectJobRunListViewSchema,
  jevellan_daily_list: ProjectDailyListViewSchema,

  jevellan_goals_list: GoalListViewSchema,
  jevellan_app_start: ProjectAppSchema, jevellan_app_stop: ProjectAppSchema,
  jevellan_apps_list: z.strictObject({ schema: z.literal('project-apps-v1'), apps: z.array(ProjectAppSchema) }),
  jevellan_tasks_list: z.strictObject({ schema: z.literal('tasks-list-result-v1'), tasks: z.array(ProjectWorkTaskSchema.extend({ position: z.number().int().positive() })) }),
  jevellan_settings_update: ProjectSettingsChangeResultSchema,
  jevellan_setup_propose: SetupProposalResultSchema,
  jevellan_tasks_start: TasksStartResultSchema,
  jevellan_task_create: TaskReceiptSchema,
  jevellan_task_update: z.strictObject({ schema: z.literal('task-update-result-v1'), task: ProjectWorkTaskSchema }),
  jevellan_task_cancel: z.strictObject({ schema: z.literal('task-cancel-result-v1'), task: ProjectWorkTaskSchema }),
  jevellan_threads_list: ThreadsListResultSchema, jevellan_thread_message: ThreadMessageResultSchema,
  jevellan_thread_read: ThreadReadResultSchema, jevellan_thread_stop: ThreadStopResultSchema, jevellan_ask_user: AskUserResultSchema,
  jevellan_withdraw_question: WithdrawQuestionResultSchema, jevellan_notebook_read: NotebookReadResultSchema, jevellan_notebook_write: NotebookWriteResultSchema,
  jevellan_answer_question: z.strictObject({ schema: z.literal('answer-question-result-v1'), questionId: IdSchema, answered: z.literal(true), repeated: z.boolean(), openQuestions: OpenQuestionsResultSchema.optional() }),
  jevellan_github: GithubResultSchema,
  jevellan_terminal_read: TerminalReadResultSchema,
  jevellan_pr_status: PrStatusResultSchema, jevellan_mail_send: MailSendResultSchema, jevellan_mail_inbox: MailInboxResultSchema,
  jevellan_pr_diff: PrDiffResultSchema,
  jevellan_reserve: ReserveResultSchema, jevellan_release: ReleaseResultSchema, jevellan_thread_report: ThreadReportResultSchema,
  memory_search: MemorySearchSchema, memory_read: MemoryNoteSchema, memory_write: MemoryNoteSchema, memory_edit: MemoryNoteSchema,
} as const satisfies Record<ProjectToolName, z.ZodType>;
