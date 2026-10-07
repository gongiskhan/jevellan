import { z } from 'zod';
import { EffortSchema, FindingSchema, HandoffSchema, IdSchema, ResultSchema, TimestampSchema } from './schemas.js';
import {
  IsolationSchema, NEEDS_DECISION_QUESTION, OptionSchema, ProjectAppInputSchema, ProjectAppSchema, PullRequestStateSchema, ThreadReportFieldsSchema, ThreadReportSchema,
  ThreadReportStatusSchema, ThreadStateSchema, reportHasQuestion,
} from './project-schemas.js';

const text = z.string().min(1);
export const MemoryNoteSchema = z.strictObject({ schema: z.literal('memory-note-v1'), title: text, permalink: text, content: z.string(), updatedAt: z.iso.datetime().optional(), unresolved: z.boolean().default(false) });
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;
export const MemorySearchSchema = z.strictObject({ schema: z.literal('memory-search-v1'), notes: z.array(MemoryNoteSchema).max(20) });
export const MemoryWriteSchema = z.strictObject({ title: text.max(300), content: text.max(256_000) });
export const MemoryEditSchema = z.strictObject({ permalink: text, operation: z.enum(['append', 'prepend', 'replace']), content: text.max(256_000), find: text.optional() }).refine((value) => value.operation !== 'replace' || !!value.find, 'A replacement needs the exact text to replace.');
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
  title: text.max(120), task: text.max(20000), isolation: IsolationSchema.optional(), modelId: IdSchema.optional(),
  effort: EffortSchema.optional(), deviceId: IdSchema.optional(), note: z.string().max(600).optional(),
});
export const ThreadMessageInputSchema = z.strictObject({ threadId: IdSchema, message: text.max(20000), interrupt: z.boolean().default(false) });
export const ThreadReadInputSchema = z.strictObject({ threadId: IdSchema, detail: z.enum(['summary', 'transcript']).default('summary') });
export const ThreadStopInputSchema = z.strictObject({ threadId: IdSchema, reason });
export const AskUserInputSchema = z.strictObject({ question: text.max(2000), options: z.array(OptionSchema).max(4, ASK_USER_OPTIONS).optional(), threadId: IdSchema.optional() })
  .refine((input) => input.options?.length !== 1, { message: ASK_USER_OPTIONS, path: ['options'] });
export const WithdrawQuestionInputSchema = z.strictObject({ decisionId: IdSchema, reason });
export const NotebookReadInputSchema = z.strictObject({});
export const NotebookWriteInputSchema = z.strictObject({ content: z.string().max(65536), expectedRevision: count });
export const PrStatusInputSchema = z.strictObject({ threadId: IdSchema });
export const MailSendInputSchema = z.strictObject({ to: text.max(128), subject: text.max(200), body: z.string().max(8000) });
export const MailInboxInputSchema = z.strictObject({});
export const ReservePathsSchema = z.array(text.max(300)).min(1).max(50);
export const ReserveInputSchema = z.strictObject({ paths: ReservePathsSchema, reason: z.string().max(300).default(''), minutes: z.number().int().min(1).max(120).default(60) });
export const ReleaseInputSchema = z.strictObject({ id: IdSchema.optional() });
// The daemon fills schema, turn and synthesized: false.
export const ThreadReportInputSchema = ThreadReportFieldsSchema.omit({ schema: true, turn: true, synthesized: true })
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
export const AskUserResultSchema = z.strictObject({ schema: z.literal('ask-user-result-v1'), decisionId: IdSchema });
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
  memory_propose: MemoryProposalInputSchema,
  jevellan_threads_list: ThreadsListInputSchema,
  jevellan_thread_start: ThreadStartInputSchema,
  jevellan_thread_message: ThreadMessageInputSchema,
  jevellan_thread_read: ThreadReadInputSchema,
  jevellan_thread_stop: ThreadStopInputSchema,
  jevellan_ask_user: AskUserInputSchema,
  jevellan_withdraw_question: WithdrawQuestionInputSchema,
  jevellan_notebook_read: NotebookReadInputSchema,
  jevellan_notebook_write: NotebookWriteInputSchema,
  jevellan_pr_status: PrStatusInputSchema,
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
  z.strictObject({ schema: z.literal('bridge-request-v1'), operation: z.literal('memory-capture'), event: MemoryHookEventSchema }),
]);
export const BridgeResultSchema = z.strictObject({ schema: z.literal('bridge-result-v1'), result: z.json() });
export const BridgeToolsSchema = z.strictObject({ schema: z.literal('bridge-tools-v1'), tools: z.array(z.strictObject({ name: BridgeToolNameSchema, description: text, inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()) })) });
export function bridgeTools(names: BridgeTool[]): z.infer<typeof BridgeToolsSchema> {
  const descriptions: Record<BridgeTool, string> = {
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
    memory_write: 'Write a project memory note under this work’s checkout ownership.',
    memory_edit: 'Edit a project memory note. For replace, provide the exact text in find.',
    memory_propose: 'Queue a proposed memory note. It does not change the checkout; Jevellan applies it later under ownership.',
    jevellan_threads_list: 'List this project’s threads with their state, isolation, device, model, branch, pull request and last report summary. include: all adds threads that ended in the last 14 days.',
    jevellan_thread_start: 'Start a thread that carries one task end to end. Write a self-contained title and task. Leave isolation, modelId, effort and deviceId out unless the owner asked for that exact choice; Jevellan places the thread. note is your one-line reason. Returns the thread id, its state and where it runs.',
    jevellan_thread_message: 'Send a message to a thread. An idle or in-review thread starts a turn now; a running thread receives it as its next turn, or at once with interrupt: true. Threads that are attached, done, stopped or failed refuse messages.',
    jevellan_thread_read: 'Read a thread’s state, its last three reports and its pull request. detail: transcript adds the end of its assistant text.',
    jevellan_thread_stop: 'Stop a thread: end any running turn and mark it stopped. Its worktree and branch stay until the owner discards them.',
    jevellan_ask_user: 'Ask the owner a question. Give no options or two to four short options, and name the thread when the question comes from one. The answer arrives later as an event.',
    jevellan_withdraw_question: 'Withdraw an unanswered question, for example after a thread solved it.',
    jevellan_notebook_read: 'Read the project notebook: your durable record of decisions, conventions, owner preferences and the current plan.',
    jevellan_notebook_write: 'Replace the whole notebook, at most 64 KiB. Pass the revision you read; if it changed meanwhile, the error carries the current content.',
    jevellan_pr_status: 'Fetch a thread’s pull request state fresh from GitHub.',
    jevellan_mail_send: 'Send mail to coordinate the threads that work directly on main: to a thread id, to all (every other main thread), or from a thread to coordinator.',
    jevellan_mail_inbox: 'Read unread mail addressed to this thread or to all, and mark it read.',
    jevellan_reserve: 'Reserve repository paths (files, or directories ending in /) for up to 120 minutes, 60 by default, before editing them. Other threads see the reservation; a refusal lists the conflicting threads.',
    jevellan_release: 'Release one reservation by id, or every reservation of this thread when no id is given.',
    jevellan_thread_report: 'Report this turn’s outcome exactly once, at the end of the turn. needs-decision requires a question; options are two to four short choices. Include the tests you ran and the files you changed.',
  };
  return BridgeToolsSchema.parse({ schema: 'bridge-tools-v1', tools: names.map((name) => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(BridgeToolSchemas[name], { io: 'input' }) })) });
}

// Project scopes (D104). The coordinator's read-only Claude allow list and the bridge's scope lists both derive from
// projectToolNames, never a copy.
export const COORDINATOR_TOOLS = ['jevellan_threads_list', 'jevellan_thread_start', 'jevellan_thread_message', 'jevellan_thread_read', 'jevellan_thread_stop',
  'jevellan_ask_user', 'jevellan_withdraw_question', 'jevellan_notebook_read', 'jevellan_notebook_write', 'jevellan_pr_status', 'jevellan_mail_send', 'memory_search', 'memory_read'] as const satisfies readonly BridgeTool[];
const MAIN_THREAD_TOOLS = ['jevellan_mail_send', 'jevellan_mail_inbox', 'jevellan_reserve', 'jevellan_release'] as const satisfies readonly BridgeTool[];
export type ProjectToolName = typeof COORDINATOR_TOOLS[number] | typeof MAIN_THREAD_TOOLS[number] | 'jevellan_thread_report' | 'jevellan_app_start' | 'jevellan_app_stop' | 'jevellan_apps_list';
export function threadTools(isolation: 'worktree' | 'main'): BridgeTool[] {
  return ['jevellan_thread_report', 'jevellan_app_start', 'jevellan_app_stop', 'jevellan_apps_list', 'memory_search', 'memory_read', ...(isolation === 'main' ? MAIN_THREAD_TOOLS : [])];
}
/** The tools a scope lists: the coordinator's, or a thread's by isolation (mail and reservations only on main, brief 7.2). A fresh array each call. */
export function projectToolNames(scope: { kind: 'coordinator' } | { kind: 'thread'; isolation: 'worktree' | 'main' }): BridgeTool[] {
  return scope.kind === 'coordinator' ? [...COORDINATOR_TOOLS] : threadTools(scope.isolation);
}
/** The result document each project tool returns inside bridge-result-v1. */
export const ProjectToolResultSchemas = {
  jevellan_app_start: ProjectAppSchema, jevellan_app_stop: ProjectAppSchema,
  jevellan_apps_list: z.strictObject({ schema: z.literal('project-apps-v1'), apps: z.array(ProjectAppSchema) }),
  jevellan_threads_list: ThreadsListResultSchema, jevellan_thread_start: ThreadStartResultSchema, jevellan_thread_message: ThreadMessageResultSchema,
  jevellan_thread_read: ThreadReadResultSchema, jevellan_thread_stop: ThreadStopResultSchema, jevellan_ask_user: AskUserResultSchema,
  jevellan_withdraw_question: WithdrawQuestionResultSchema, jevellan_notebook_read: NotebookReadResultSchema, jevellan_notebook_write: NotebookWriteResultSchema,
  jevellan_pr_status: PrStatusResultSchema, jevellan_mail_send: MailSendResultSchema, jevellan_mail_inbox: MailInboxResultSchema,
  jevellan_reserve: ReserveResultSchema, jevellan_release: ReleaseResultSchema, jevellan_thread_report: ThreadReportResultSchema,
  memory_search: MemorySearchSchema, memory_read: MemoryNoteSchema,
} as const satisfies Record<ProjectToolName, z.ZodType>;
