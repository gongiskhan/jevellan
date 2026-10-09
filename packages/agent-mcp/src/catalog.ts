import { z } from 'zod';
import { EffortSchema, IdSchema, IsolationSchema } from '@jevellan/core';
import { AgentWatchRequestSchema } from './schemas.js';

const autoId = z.union([z.literal('auto'), IdSchema]);
const choice = {
  providerId: autoId.optional().describe('Runtime/provider ID from discovery, or auto. Alias of runtimeId.'),
  runtimeId: autoId.optional().describe('Runtime ID, or auto. Unspecified fields stay automatic.'),
  accountId: autoId.optional().describe('Eligible account ID, or auto. Explicit accounts still obey login, usage, paid-use and device limits.'),
  modelId: autoId.optional().describe('Stable model menu ID from discovery, or auto.'),
  effort: z.union([z.literal('auto'), EffortSchema]).optional(),
};
const placement = { ...choice, isolation: z.union([z.literal('auto'), IsolationSchema]).optional(), deviceId: autoId.optional() };
const project = { projectId: IdSchema };
const resourceDevice = { deviceId: autoId.optional().describe('Device ID from discovery. Omit or use auto for the connected device.') };
const thread = { ...project, threadId: IdSchema };
const job = { conversationId: IdSchema };
const requestId = { clientRequestId: IdSchema.describe('Stable ID chosen before calling. Reuse it only for retries of this exact request.') };
const generation = { generation: z.number().int().nonnegative().describe('Current generation from read; stale updates are refused.') };
const text = z.string().min(1).max(20_000);
const empty = z.strictObject({});
export type AgentOperation = { name: string; title: string; description: string; input: z.ZodType; readOnly: boolean; destructive?: boolean; idempotent?: boolean };
const operation = (name: string, title: string, description: string, input: z.ZodType, readOnly: boolean, extra: Pick<AgentOperation, 'destructive' | 'idempotent'> = {}): AgentOperation => ({ name, title, description, input, readOnly, ...extra });

/** The same catalog serves both transports and the daemon's capability allowlist. */
export const AGENT_OPERATIONS: readonly AgentOperation[] = [
  operation('discover', 'Discover Jevellan', 'Read capabilities, providers/runtimes, supported models and efforts, accounts and readiness, devices, project access, limits and override semantics. Discover IDs before starting work.', empty, true),
  operation('projects_list', 'List projects', 'List accessible registered projects and their coordinator/job counts.', empty, true),
  operation('project_read', 'Read project work', 'Read the project, coordinator state, threads, open decisions, pull requests, settings and notebook revision.', z.strictObject(project), true),
  operation('project_settings_read', 'Read project work settings', 'Read revisioned placement defaults, coordinator choices and project limits.', z.strictObject(project), true),
  operation('coordinator_send', 'Message coordinator', 'Give the project coordinator work or a correction. It decides meaning and can start threads. Reuse clientMessageId on retries.', z.strictObject({ ...project, clientMessageId: IdSchema, text }), false, { idempotent: true }),
  operation('coordinator_read', 'Read coordinator', 'Read project coordinator state and recent project history without starting work. Use watch for resumable output.', z.strictObject(project), true),
  operation('coordinator_stop', 'Stop coordinator', 'Stop this project coordinator turn through the normal owner guard. Its threads keep running.', z.strictObject(project), false, { destructive: true }),
  operation('coordinator_fresh', 'Fresh coordinator context', 'Start a fresh coordinator context using its notebook and project state, through normal owner controls.', z.strictObject(project), false, { destructive: true }),
  operation('coordinator_move', 'Move coordinator here', 'Move the coordinator to this device only when existing project gates and owner rules permit it.', z.strictObject(project), false),
  operation('coordinator_override', 'Override coordinator choices', 'Change runtime/provider, account, model or effort for later coordinator turns. Auto clears a runtime/account/model override; effort auto restores the configured default. Does not move active work.', z.strictObject({ ...project, ...requestId, revision: z.number().int().nonnegative(), ...choice }), false, { idempotent: true }),
  operation('threads_list', 'List project threads', 'List all project jobs/threads, their states, owner devices, choices and conclusions.', z.strictObject(project), true),
  operation('thread_start', 'Start project job', 'Start a project thread with a task. Each placement field accepts auto or an explicit value; automatic meaning/model/effort/isolation choices use Jev and resource gates remain enforced.', z.strictObject({ ...project, ...requestId, title: z.string().min(1).max(120), task: text, ...placement, note: z.string().max(400).optional() }), false, { idempotent: true }),
  operation('thread_read', 'Read project job', 'Read one thread, placement explanation, reports, output and available controls. Native sessions and authentication never leave the owner.', z.strictObject(thread), true),
  operation('thread_send', 'Message project job', 'Send a correction or a queued next-turn message to this thread. interrupt=true requests interruption using its normal guard.', z.strictObject({ ...thread, clientMessageId: IdSchema, text, interrupt: z.boolean().default(false) }), false, { idempotent: true }),
  operation('thread_stop', 'Stop project job', 'Stop a thread through normal process termination and checkout settlement. Manual git projects keep edits; automatic worktrees follow their normal cleanup policy.', z.strictObject({ ...thread, reason: z.string().max(400).optional() }), false, { destructive: true }),
  operation('thread_override', 'Override next project turn', 'Apply choices to the next turn where supported. Changing runtime/isolation/device requires restart; account and effort eligibility are still enforced.', z.strictObject({ ...thread, ...requestId, ...placement, note: z.string().max(400).optional() }), false, { idempotent: true }),
  operation('thread_restart', 'Restart project job', 'Stop and restart this task with chosen placement. This uses the same restart and cleanup behavior as the app; inspect thread_read before using it.', z.strictObject({ ...thread, ...requestId, ...placement, note: z.string().max(400).optional() }), false, { destructive: true, idempotent: true }),
  operation('thread_discard', 'Discard project worktree', 'Discard a concluded worktree through the normal guarded control. Refused when cleanup is unsafe.', z.strictObject(thread), false, { destructive: true }),
  operation('thread_allow_turns', 'Allow more job turns', 'Grant the same additional turn allowance offered in the app after a turn limit.', z.strictObject(thread), false),
  operation('jobs_list', 'List conversation jobs', 'List ordinary Jevellan conversations across the mesh, filtered to accessible projects.', empty, true),
  operation('job_start', 'Start conversation job', 'Start ordinary conversation work in a registered project. Auto choices leave selection to Jev. New jobs start on the connected device; use a project thread for device placement.', z.strictObject({ ...project, ...requestId, conversationId: IdSchema, title: z.string().min(1).max(200), message: z.string().min(1).max(100_000), ...choice, action: z.enum(['auto', 'reply', 'plan', 'implement', 'test', 'review', 'ask-you', 'done']).optional() }), false, { idempotent: true }),
  operation('job_read', 'Read conversation job', 'Read state, generation, work, messages, handoffs, decisions, available actions and controls.', z.strictObject(job), true),
  operation('job_send', 'Message conversation job', 'Send a correction/message or a noninterrupting note. Reuse clientMessageId for retries; normal open-work continuity applies.', z.strictObject({ ...job, clientMessageId: IdSchema, text: z.string().min(1).max(100_000), kind: z.enum(['message', 'note']).default('message') }), false, { idempotent: true }),
  operation('job_cancel', 'Cancel conversation job', 'Cancel through normal termination and work settlement. Read the resulting job for any outstanding checkout choices.', z.strictObject(job), false, { destructive: true }),
  operation('job_override', 'Set next conversation choice', 'Override or pin one runtime/account/model/effort/action choice. Auto clears it. Generation comes from job_read; action only supports once.', z.strictObject({ ...job, ...requestId, ...generation, field: z.enum(['runtime', 'account', 'model', 'effort', 'action']), mode: z.enum(['once', 'pin']).default('once'), value: z.string().min(1).max(200) }), false, { idempotent: true }),
  operation('job_manual', 'Choose manual conversation step', 'Choose the next action when Jev is unavailable, using eligible runtime/account/model/effort overrides or auto.', z.strictObject({ ...job, ...generation, action: z.enum(['reply', 'plan', 'implement', 'test', 'review', 'ask-you', 'done']), ...choice, remember: z.boolean().default(false) }), false),
  operation('job_resume', 'Resume conversation decisions', 'Retry the pending decision through the normal generation guard.', z.strictObject({ ...job, ...generation }), false),
  operation('job_approve_plan', 'Approve conversation plan', 'Approve the exact current plan reference and generation when the project pauses after plans.', z.strictObject({ ...job, ...generation, ref: z.string().min(1).max(4000) }), false),
  operation('job_close_work', 'Settle conversation work', 'Close work with publish, keep or discard under normal verification and checkout guards. Discard removes this work changes; it is never implicit.', z.strictObject({ ...job, ...requestId, ...generation, workId: IdSchema, choice: z.enum(['publish', 'keep', 'discard']) }), false, { destructive: true, idempotent: true }),
  operation('job_changes', 'Read job changes', 'Read a step diff, uncommitted changes, evidence and Jevellan verification receipts.', z.strictObject({ ...job, stretch: z.number().int().positive() }), true),
  operation('job_read_pointer', 'Read job evidence', 'Read a stored ledger, handoff or blob pointer from this job only.', z.strictObject({ ...job, pointer: z.string().min(1).max(4000) }), true),
  operation('decisions_list', 'List project decisions', 'Read open and recently answered decision items. Answer only choices authorized by the owner; continue other jobs while waiting.', z.strictObject(project), true),
  operation('decision_answer', 'Answer project decision', 'Answer an open decision by option label and/or text using the normal decision guard.', z.strictObject({ ...project, ...requestId, decisionId: IdSchema, optionLabel: z.string().max(120).optional(), text: z.string().max(4000).optional() }).refine(v => Boolean(v.optionLabel?.trim() || v.text?.trim()), 'Provide an option or answer.'), false, { idempotent: true }),
  operation('notebook_read', 'Read project notebook', 'Read the project notebook and its revision.', z.strictObject(project), true),
  operation('notebook_write', 'Update project notebook', 'Write the notebook with an expected revision. A concurrent coordinator update is refused instead of overwritten.', z.strictObject({ ...project, expectedRevision: z.number().int().nonnegative(), content: z.string().max(65_536) }), false),
  operation('mail_list', 'Read project mail', 'Read project mail without marking another worker inbox read.', z.strictObject({ ...project, after: IdSchema.optional() }), true),
  operation('mail_send', 'Send project mail', 'Send a project coordination message as this external connection to a main thread or coordinator; no worker impersonation. Reuse the request ID on retries.', z.strictObject({ ...project, ...requestId, to: IdSchema, subject: z.string().min(1).max(200), body: z.string().min(1).max(8000) }), false, { idempotent: true }),
  operation('reservations_list', 'Read file reservations', 'Read active file/folder reservations and their owner threads. Reservations are held by actual jobs, not by external callers.', z.strictObject(project), true),
  operation('apps_list', 'List managed apps', 'Read running project app URLs and stop instructions on the connected device by default, or the explicit deviceId. Apps can stay alive after their thread concludes.', z.strictObject({ ...project, ...resourceDevice }), true),
  operation('app_start', 'Start managed project app', 'Serve a static app inside a project thread or its registered checkout. Returns a verified browser URL. Executable commands are not available through external connections.', z.strictObject({ ...thread, ...requestId, kind: z.literal('static').default('static'), directory: z.string().min(1).max(4096).default('.'), label: z.string().max(120).optional() }), false, { idempotent: true }),
  operation('app_stop', 'Stop managed project app', 'Stop the named managed app for this project on the connected device by default, or the explicit deviceId. Does not stop or restart Jevellan.', z.strictObject({ ...project, ...resourceDevice, appId: IdSchema }), false, { destructive: true }),
  operation('pull_requests_list', 'List project pull requests', 'Read thread pull requests, merge conflicts and reported check state.', z.strictObject(project), true),
  operation('pull_request_refresh', 'Refresh project pull request', 'Refresh this thread pull request state using the configured GitHub client.', z.strictObject(thread), false),
  operation('pull_request_merge', 'Merge project pull request', 'Merge only after the normal project verification and publication guards permit it. Use only when the owner authorized merging.', z.strictObject(thread), false, { destructive: true }),
  operation('memory_search', 'Search project memory', 'Read-only search of Jevellan isolated project memory on the connected device by default, or the explicit deviceId. No native agent memory is accessed.', z.strictObject({ ...project, ...resourceDevice, query: z.string().min(1).max(4000) }), true),
  operation('memory_read', 'Read project memory', 'Read a project memory note by permalink on the connected device by default, or the explicit deviceId.', z.strictObject({ ...project, ...resourceDevice, permalink: z.string().min(1).max(4000) }), true),
  operation('watch', 'Watch organized output', 'Read or wait up to 30 seconds for resumable project/job output. Set streamMs to receive multiple formatted incremental progress batches during a bounded window. Returns Markdown and structured blocks, adjacent same-tool groups, offsets, stable block IDs and a cursor. Save each returned cursor and pass it unchanged on the next call; each target has its own cursor. Does not start, resume or modify work.', AgentWatchRequestSchema, true),
];

export function normalizeAgentArguments(raw: Record<string, unknown>): Record<string, unknown> {
  const result = Object.fromEntries(Object.entries(raw).filter(([key, value]) => !Object.hasOwn(choice, key) && key !== 'deviceId' && key !== 'isolation' || value !== 'auto'));
  const provider = result.providerId; delete result.providerId;
  if (provider !== undefined && result.runtimeId !== undefined && provider !== result.runtimeId) throw new Error('providerId and runtimeId must name the same provider.');
  if (provider !== undefined) result.runtimeId = provider;
  return result;
}
