import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as C from '@jevellan/core';
import { assertAgentProject } from '@jevellan/mesh';
import { publicProjectData } from '@jevellan/projects';
import { AGENT_OPERATIONS, AgentTargetSchema, AgentEventPageSchema, AgentOutputJournalSchema, AgentOutputJournalDocumentSchema, agentJournalPage, emptyAgentJournal, normalizeAgentArguments, reconcileAgentJournal, type AgentApi, type AgentTarget, type AgentEventPage } from '@jevellan/agent-mcp';
import { z } from 'zod';
import type { Application } from './application.js';
import { publicConversationData } from './conversation-events.js';

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
export const AgentPeerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ schema: z.literal('agent-peer-request-v1'), kind: z.literal('call'), operation: z.string().min(1).max(120), arguments: z.record(z.string(), z.unknown()) }),
  z.strictObject({ schema: z.literal('agent-peer-request-v1'), kind: z.literal('events'), target: z.unknown(), after: z.number().int().nonnegative(), limit: z.number().int().min(1).max(200) }),
]);
export const AgentPeerResultSchema = z.strictObject({ schema: z.literal('agent-peer-result-v1'), data: z.unknown() });
const PRIVATE = new Set(['native', 'nativeSessionId', 'sessionId', 'secretRef', 'secret', 'env', 'authorization', 'ownerSession', 'token', 'tokenRef', 'tokenFingerprint', 'requestFingerprint', 'cwd']);
function agentDataWithoutPrivateFields(value: unknown): unknown {
  const clean = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(clean) : entry && typeof entry === 'object'
    ? Object.fromEntries(Object.entries(entry).filter(([key]) => !PRIVATE.has(key)).map(([key, child]) => [key, clean(child)])) : entry;
  return clean(publicProjectData(publicConversationData(value)));
}
export function publicAgentData(app: Application, value: unknown): unknown {
  return C.boundedRedaction(app.redactor, agentDataWithoutPrivateFields(value));
}
/** Opaque pointer payloads can contain raw native records/deltas with no completed document boundary. */
function publicAgentSourceData(app: Application, value: unknown): unknown {
  // No field name establishes a completed-document boundary inside an opaque payload.
  const visit = (entry: unknown): unknown => typeof entry === 'string' ? app.redactor.streamToolText(entry)
    : Array.isArray(entry) ? entry.map(visit) : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).map(([field, child]) => [app.redactor.streamToolText(field), visit(child)])) : entry;
  return C.boundedRedaction(app.redactor, visit(agentDataWithoutPrivateFields(value)));
}
/**
 * Completed owner documents retain their full ordinary content. Only known projections of unfinished
 * native output, request mirrors and opaque pointer payloads need credential-prefix withholding.
 */
export function publicAgentOutputData(app: Application, value: unknown): unknown {
  const record = (entry: unknown): Record<string, unknown> => entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  const text = (entry: unknown) => typeof entry === 'string' ? app.redactor.streamText(entry) : entry;
  const turn = (entry: unknown): unknown => {
    const current = record(entry); if (!Array.isArray(current.blocks)) return entry;
    return { ...current, blocks: current.blocks.map(raw => {
      const block = record(raw);
      if (block.type === 'text' || block.type === 'thinking') return { ...block, text: text(block.text) };
      if (block.type !== 'tool') return block;
      return { ...block, ...(typeof block.input === 'string' ? { input: app.redactor.streamToolText(block.input) } : {}),
        ...(typeof block.output === 'string' ? { output: app.redactor.streamToolText(block.output) } : {}) };
    }) };
  };
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== 'object') return entry;
    const original = record(entry); const result = Object.fromEntries(Object.entries(original).map(([key, child]) => [key, visit(child)]));
    if (original.schema === 'conversation-read-v1') result.content = publicAgentSourceData(app, original.content);
    else if (original.schema === 'work-v1') result.request = text(original.request);
    else if (original.schema === 'summary-v2') {
      for (const key of ['objective', 'state', 'nextWork']) result[key] = text(original[key]);
      if (Array.isArray(original.decisions)) result.decisions = original.decisions.map(text);
    } else if (original.schema === 'conversation-view-v1' && Array.isArray(original.messages)) {
      result.messages = original.messages.map(message => ({ ...record(message), text: text(record(message).text) }));
    } else if (original.schema === 'cursor-transcript-v1' || original.schema === 'cursor-activity-v1') {
      if (Array.isArray(original.turns)) result.turns = original.turns.map(turn);
      if (Array.isArray(original.activity)) result.activity = original.activity.map(turn);
      if (Array.isArray(original.messages)) result.messages = original.messages.map(message => ({ ...record(message), text: text(record(message).text) }));
    }
    return result;
  };
  return C.boundedRedaction(app.redactor, visit(agentDataWithoutPrivateFields(value)));
}
export const SUPPORTED_AGENT_OPERATIONS = AGENT_OPERATIONS.map(operation => operation.name);
const pick = (input: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
const selections = ['runtimeId', 'accountId', 'modelId', 'effort', 'isolation', 'deviceId', 'note'];
const journalQueues = new WeakMap<Application, Map<string, Promise<unknown>>>();

/** The external connection calls the same services and gates as the app, with explicit project and device boundaries. */
export class AgentApiAdapter implements AgentApi {
  readonly supportedOperations = SUPPORTED_AGENT_OPERATIONS;
  constructor(readonly app: Application, readonly grant: C.AgentAccessGrant, private readonly authorization: string, private readonly peer = false) {}
  isActive(): Promise<boolean> { return this.app.agentAccess.isActive(this.grant.connectionId); }
  async #authorized(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); if (!await this.isActive()) throw failure('This agent connection was revoked or expired.', 401); }
  async #project(projectId: string): Promise<C.Project> {
    assertAgentProject(this.grant, projectId);
    const view = await this.app.state.projects.get(projectId); if (!view) throw failure('Project not found.', 404);
    return view.project;
  }
  async #job(conversationId: string) {
    const row = (await this.app.conversations.list()).conversations.find(entry => entry.id === conversationId);
    if (!row) throw failure('Conversation not found.', 404); await this.#project(row.projectId); return row;
  }
  async #forward(deviceId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.peer) throw failure('This work belongs to another device.', 409);
    const row = (await this.app.roster()).devices.find(entry => entry.device.id === deviceId);
    if (!row || row.revoked || row.status === 'offline') throw failure('The device that owns this work is unavailable.', 409);
    const url = new URL(C.DeviceOriginSchema.parse(row.device.url)); url.pathname = '/api/agent-peer';
    let response: Response;
    try { response = await fetch(url, { method: 'POST', redirect: 'manual', signal, headers: { Authorization: this.authorization, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(AgentPeerRequestSchema.parse(input)) }); }
    catch { throw failure('The device that owns this work could not be reached.', 502); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw failure('The device connection redirected unexpectedly.', 502); }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) { const parsed = C.ErrorDocumentSchema.safeParse(data); throw failure(parsed.success ? parsed.data.message : 'The device refused this operation.', response.status); }
    await this.#authorized(signal);
    return AgentPeerResultSchema.parse(data).data;
  }
  async call(operation: string, raw: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    await this.#authorized(signal);
    const definition = AGENT_OPERATIONS.find(entry => entry.name === operation);
    if (!definition || !this.supportedOperations.includes(operation)) throw failure('This agent operation is not available.', 404);
    const parsed = definition.input.parse(raw) as Record<string, unknown>; const input = normalizeAgentArguments(parsed);
    const projectId = typeof input.projectId === 'string' ? input.projectId : undefined;
    const threadId = typeof input.threadId === 'string' ? input.threadId : undefined;
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : undefined;
    if (projectId) await this.#project(projectId);
    let owner: string | null | undefined;
    if (conversationId && operation !== 'job_start') owner = (await this.#job(conversationId)).ownerDeviceId;
    if (threadId && projectId) { owner = await this.app.projectWork.threadOwner(projectId, threadId); if (!owner) throw failure('Thread not found.', 404); }
    if (projectId && ['coordinator_send', 'coordinator_stop', 'coordinator_fresh', 'thread_start'].includes(operation)) owner = await this.app.projectWork.coordinatorDevice(projectId);
    if (['apps_list', 'app_stop', 'memory_search', 'memory_read'].includes(operation) && typeof input.deviceId === 'string') owner = input.deviceId;
    if (owner && owner !== this.app.device.deviceId) return this.#forward(owner, { schema: 'agent-peer-request-v1', kind: 'call', operation, arguments: parsed }, signal);
    const release = definition.readOnly ? undefined : this.app.lifecycle.enter({ kind: 'request' });
    try {
      await Promise.all([this.app.conversations.ready, this.app.projectWork.ready]);
      let result: unknown;
      const work = this.app.projectWork;
      switch (operation) {
        case 'discover': {
          const settings = (await this.app.configuration()).configuration['x-jevellan'];
          const [projects, accounts, offered, roster] = await Promise.all([this.app.state.projects.list(), this.app.accounts.list(), this.app.accounts.offered(), this.app.roster()]);
          result = { schema: 'agent-discovery-v1', connection: this.grant, deviceId: this.app.device.deviceId, tools: this.supportedOperations,
            providers: [...this.app.runtimes.values()].map(runtime => ({ id: runtime.id, label: runtime.displayName, enabled: settings.runtimes[runtime.id]?.enabled === true, capabilities: runtime.capabilities })),
            accounts, offered, models: settings.menu, efforts: C.EffortSchema.options, devices: roster.devices.map(row => ({ device: row.device, status: row.status, revoked: row.revoked })),
            projects: projects.filter(row => !this.grant.projectIds || this.grant.projectIds.includes(row.project.id)),
            guards: settings.guards, overrides: { automatic: 'Omit a choice or use auto. Jev decides meaning; account, device, usage and project gates still apply.', providerField: 'runtimeId', modelsUseMenuIds: true } }; break;
        }
        case 'projects_list': { const list = await work.list(); result = { ...list, projects: list.projects.filter(row => !this.grant.projectIds || this.grant.projectIds.includes(row.projectId)) }; break; }
        case 'project_read': case 'coordinator_read': result = await work.view(projectId!); break;
        case 'project_settings_read': result = await work.settingsView(projectId!); break;
        case 'coordinator_send': result = { schema: 'coordinator-message-receipt-v1', ...await work.postMessage(projectId!, C.CoordinatorMessageRequestSchema.parse({ schema: 'coordinator-message-request-v1', ...pick(input, ['clientMessageId', 'text']) })) }; break;
        case 'coordinator_stop': await work.stopCoordinator(projectId!); result = await work.view(projectId!); break;
        case 'coordinator_fresh': await work.freshCoordinator(projectId!); result = await work.view(projectId!); break;
        case 'coordinator_move': await work.moveCoordinatorHere(projectId!); result = await work.view(projectId!); break;
        case 'coordinator_override': {
          const view = await work.settingsView(projectId!); const choices = { ...view.settings.coordinator };
          for (const key of ['runtimeId', 'accountId', 'modelId'] as const) if (parsed[key] !== undefined || key === 'runtimeId' && parsed.providerId !== undefined) choices[key] = input[key] as string | undefined ?? null;
          if (parsed.effort !== undefined) choices.effort = input.effort as C.Effort | undefined ?? 'medium';
          const settings = pick(view.settings, ['defaultIsolation', 'placement', 'coordinator', 'setupCommand', 'maxRunningThreads', 'maxRunningPerDevice', 'threadTurnCap']);
          result = await work.putSettings(projectId!, C.ProjectWorkSettingsRequestSchema.parse({ schema: 'project-work-settings-request-v1', revision: input.revision, clientRequestId: input.clientRequestId, settings: { ...settings, coordinator: choices } })); break;
        }
        case 'threads_list': result = { schema: 'agent-threads-v1', projectId, threads: (await work.view(projectId!)).threads }; break;
        case 'thread_start': result = await work.createThread(projectId!, C.ThreadCreateRequestSchema.parse({ schema: 'thread-create-request-v1', ...pick(input, ['clientRequestId', 'title', 'task', ...selections]) })); break;
        case 'thread_read': result = await work.threadView(projectId!, threadId!); break;
        case 'thread_send': result = { schema: 'thread-message-receipt-v1', ...await work.threadMessage(projectId!, threadId!, C.ThreadMessageRequestSchema.parse({ schema: 'thread-message-request-v1', ...pick(input, ['clientMessageId', 'text', 'interrupt']) })) }; break;
        case 'thread_stop': await work.stopThread(projectId!, threadId!, C.ThreadStopRequestSchema.parse({ schema: 'thread-stop-request-v1', ...pick(input, ['reason']) })); result = await work.threadView(projectId!, threadId!); break;
        case 'thread_discard': await work.discardThread(projectId!, threadId!); result = await work.threadView(projectId!, threadId!); break;
        case 'thread_allow_turns': await work.allowTurns(projectId!, threadId!); result = await work.threadView(projectId!, threadId!); break;
        case 'thread_override': case 'thread_restart': {
          const choices = pick(input, ['clientRequestId', ...selections]);
          if (operation === 'thread_override') for (const key of ['runtimeId', 'accountId', 'modelId', 'effort']) if (parsed[key] === 'auto' || key === 'runtimeId' && parsed.providerId === 'auto') choices[key] = null;
          result = await work.overrideThread(projectId!, threadId!, C.ThreadOverrideRequestSchema.parse({ schema: 'thread-override-request-v1', mode: operation === 'thread_restart' ? 'restart' : 'next-turn', ...choices }), async (id, deviceId, request) => C.ThreadCreatedViewSchema.parse(await this.#forward(deviceId, { schema: 'agent-peer-request-v1', kind: 'call', operation: 'thread_start', arguments: { projectId: id, ...pick(request as unknown as Record<string, unknown>, ['clientRequestId', 'title', 'task', ...selections]) } }, signal))); break;
        }
        case 'jobs_list': { const list = await this.app.conversations.list(); result = { ...list, conversations: list.conversations.filter(row => !this.grant.projectIds || this.grant.projectIds.includes(row.projectId)) }; break; }
        case 'job_start': {
          const once = pick(input, ['runtimeId', 'accountId', 'modelId', 'effort']); if (input.action && input.action !== 'auto') once.action = input.action;
          result = await this.app.conversations.create(C.StartConversationSchema.parse({ schema: 'start-conversation-v1', id: conversationId, projectId, title: input.title, message: input.message, clientMessageId: input.clientRequestId,
            ...(Object.keys(once).length ? { choices: { schema: 'composer-initial-v1', once, pins: {} } } : {}) })); break;
        }
        case 'job_read': result = await this.app.conversations.view(conversationId!); break;
        case 'job_send': result = await this.app.conversations.message(conversationId!, C.ConversationMessageSchema.parse({ schema: 'conversation-message-v1', ...pick(input, ['clientMessageId', 'text', 'kind']) })); break;
        case 'job_cancel': result = await this.app.conversations.cancel(conversationId!); break;
        case 'job_override': result = await this.app.conversations.composerChoice(conversationId!, C.ComposerChoiceSchema.parse({ schema: 'composer-choice-v1', ...pick(input, ['clientRequestId', 'generation', 'field', 'mode']), value: input.value === 'auto' ? null : input.value })); break;
        case 'job_manual': result = await this.app.conversations.manual(conversationId!, C.ManualStepSchema.parse({ schema: 'manual-step-v1', ...pick(input, ['generation', 'action', 'runtimeId', 'accountId', 'modelId', 'effort', 'remember']) })); break;
        case 'job_resume': result = await this.app.conversations.resumeDecision(conversationId!, C.ResumeDecisionSchema.parse({ schema: 'resume-decision-v1', generation: input.generation })); break;
        case 'job_approve_plan': result = await this.app.conversations.approvePlan(conversationId!, C.PlanApprovalSchema.parse({ schema: 'plan-approval-v1', ...pick(input, ['generation', 'ref']) })); break;
        case 'job_close_work': result = await this.app.conversations.settle(conversationId!, C.SettleWorkSchema.parse({ schema: 'settle-work-v1', ...pick(input, ['clientRequestId', 'generation', 'workId', 'choice']) })); break;
        case 'job_changes': result = await this.app.conversations.changes(conversationId!, Number(input.stretch)); break;
        case 'job_read_pointer': result = C.ConversationReadSchema.parse({ schema: 'conversation-read-v1', pointer: input.pointer, content: this.app.conversations.ledger(conversationId!).read(String(input.pointer)) }); break;
        case 'decisions_list': result = { schema: 'agent-decisions-v1', projectId, decisions: await this.app.projectHub.decisions(projectId!) }; break;
        case 'decision_answer': result = { schema: 'decision-answered-view-v1', ...await work.answerDecision(projectId!, String(input.decisionId), C.DecisionAnswerRequestSchema.parse({ schema: 'decision-answer-request-v1', ...pick(input, ['clientRequestId', 'optionLabel', 'text']) })) }; break;
        case 'notebook_read': result = await work.notebookView(projectId!); break;
        case 'notebook_write': result = await work.putNotebook(projectId!, C.NotebookRequestSchema.parse({ schema: 'notebook-request-v1', ...pick(input, ['expectedRevision', 'content']) })); break;
        case 'mail_list': result = await this.app.agentAccess.mailList(projectId!, typeof input.after === 'string' ? input.after : undefined, this.authorization); break;
        case 'mail_send': {
          const sent = await this.app.agentAccess.sendMail(C.AgentMailSendSchema.parse({ schema: 'agent-mail-send-v1', ...pick(input, ['projectId', 'clientRequestId', 'to', 'subject', 'body']) }), this.authorization);
          await work.mail.deliverExternal(sent.mail); result = sent; break;
        }
        case 'reservations_list': result = { schema: 'agent-reservations-v1', projectId, reservations: await this.app.projectHub.reservations(projectId!) }; break;
        case 'apps_list': result = { schema: 'project-apps-v1', apps: work.apps.list(projectId!) }; break;
        case 'app_start': {
          const project = await this.#project(projectId!); const local = work.store.get(threadId!); const directory = project.paths[this.app.device.deviceId];
          if (!local || local.projectId !== projectId || !local.cwd || !directory) throw failure('This app thread has no registered local checkout.', 409);
          result = await work.apps.start({ projectId: projectId!, threadId: threadId!, cwd: local.cwd, projectDirectory: directory }, C.ProjectAppInputSchema.parse(pick(input, ['kind', 'directory'])), signal); break;
        }
        case 'app_stop': result = await work.apps.stop(projectId!, String(input.appId)); break;
        case 'pull_requests_list': result = { schema: 'agent-pull-requests-v1', projectId, threads: (await work.view(projectId!)).threads.filter(thread => thread.pr) }; break;
        case 'pull_request_refresh': await work.refreshPullRequest(projectId!, threadId!); result = await work.threadView(projectId!, threadId!); break;
        case 'pull_request_merge': result = await work.mergePullRequest(projectId!, threadId!); break;
        case 'memory_search': result = await (await this.app.conversations.memory(projectId!)).search(String(input.query), signal); break;
        case 'memory_read': result = await (await this.app.conversations.memory(projectId!)).read(String(input.permalink), signal); break;
        default: throw failure('This agent operation is not available.', 404);
      }
      await this.#authorized(signal); return publicAgentOutputData(this.app, result);
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      const candidate = error as { status?: unknown; message?: unknown };
      throw failure(this.app.redactor.text(typeof candidate.message === 'string' ? candidate.message : 'The agent operation could not complete.'), typeof candidate.status === 'number' ? candidate.status : 400);
    } finally { release?.(); }
  }
  async events(rawTarget: AgentTarget, after: number, limit: number, signal: AbortSignal): Promise<AgentEventPage> {
    await this.#authorized(signal); const target = AgentTargetSchema.parse(rawTarget);
    let owner: string | null; let key: string;
    if (target.kind === 'conversation') { owner = (await this.#job(target.conversationId)).ownerDeviceId; key = `conversation_${target.conversationId}`; }
    else {
      await this.#project(target.projectId);
      owner = target.kind === 'thread' ? await this.app.projectWork.threadOwner(target.projectId, target.threadId) : await this.app.projectWork.coordinatorDevice(target.projectId);
      if (target.kind === 'thread' && !owner) throw failure('Thread not found.', 404);
      key = target.kind === 'thread' ? `thread_${target.projectId}_${target.threadId}` : `project_${target.projectId}`;
    }
    if (owner && owner !== this.app.device.deviceId) return AgentEventPageSchema.parse(await this.#forward(owner, { schema: 'agent-peer-request-v1', kind: 'events', target, after, limit }, signal));
    let queues = journalQueues.get(this.app); if (!queues) { queues = new Map(); journalQueues.set(this.app, queues); }
    const file = join(this.app.homes.ensure('agent-output'), `${createHash('sha256').update(key).digest('hex')}.json`);
    const previous = queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      await this.#authorized(signal);
      const stored = existsSync(file) ? C.readDocument(file, AgentOutputJournalDocumentSchema) : emptyAgentJournal();
      if (stored.schema === 'agent-output-journal-v1' && after > 0) throw failure('The output history was upgraded. Start watching again without the previous cursor.', 409);
      const journal = stored.schema === 'agent-output-journal-v2' ? stored : emptyAgentJournal();
      let state: string; let updated;
      if (target.kind === 'conversation') {
        const view = await this.app.conversations.view(target.conversationId); state = view.conversation.state;
        const ledger = this.app.conversations.ledger(target.conversationId);
        updated = reconcileAgentJournal(journal, { ledger: ledger.events().map(event => ({ id: event.id, type: event.type, t: event.t, ...(event.stretch ? { turn: event.stretch } : {}), data: agentDataWithoutPrivateFields(ledger.data(event)) })), redactor: this.app.redactor });
      } else if (target.kind === 'project') {
        const view = await this.app.projectWork.view(target.projectId); state = view.coordinator.state;
        const ledger = await this.app.projectWork.coordinatorEvents(target.projectId);
        updated = reconcileAgentJournal(journal, { ledger: ledger.events().map(event => ({ id: event.id, type: event.type, t: event.t, ...(event.turn ? { turn: event.turn } : {}), data: agentDataWithoutPrivateFields(ledger.payload(event)) })), redactor: this.app.redactor });
      } else {
        const view = await this.app.projectWork.threadView(target.projectId, target.threadId); state = view.thread.state;
        const ledger = this.app.projectWork.ledgers.thread(target.projectId, target.threadId);
        updated = reconcileAgentJournal(journal, { ledger: ledger.events().map(event => ({ id: event.id, type: event.type, t: event.t, ...(event.turn ? { turn: event.turn } : {}), data: agentDataWithoutPrivateFields(ledger.payload(event)) })), transcript: view.transcript, redactor: this.app.redactor });
      }
      await this.#authorized(signal);
      const safe = AgentOutputJournalSchema.parse(publicAgentData(this.app, updated));
      if (C.stableJson(journal) !== C.stableJson(safe)) C.writeDocument(file, AgentOutputJournalSchema, safe);
      return agentJournalPage(safe, after, limit, state);
    });
    queues.set(key, task);
    try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
  }
}
