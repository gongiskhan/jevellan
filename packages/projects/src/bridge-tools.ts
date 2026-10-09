import { z } from 'zod';
import {
  BridgeResultSchema, BridgeToolSchemas, IdSchema, MemoryNoteSchema, MemorySearchSchema, ProjectNotebookSchema, ProjectToolResultSchemas, ThreadReportSchema, bridgeTools,
  projectToolNames, stableJson,
  type BridgeTool, type BridgeToolsSchema, type MemoryNote, type ProjectHub, type ProjectLedgerEvent, type ProjectToolName, type SecretRedactor, type ThreadIndex, type ThreadReport,
} from '@jevellan/core';
import type { BridgeScopeTools } from '@jevellan/conversations';
import {
  REPORT_ALREADY_SENT, THREAD_NOT_FOUND, TOOL_NOT_IN_TURN, TURN_ENDED, coordinatorToolSummary, notebookConflict, toolInputError, transcriptStaysOn,
} from './copy.js';
import { derivedId, type DecisionItems } from './decision-items.js';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import type { MailService } from './mail.js';
import type { DeviceRoster } from './placement.js';
import type { PullRequestTracker } from './pull-requests.js';
import type { ThreadStore } from './stores.js';
import type { ThreadService } from './threads.js';

export type ProjectScope = { kind: 'coordinator'; projectId: string; turn: number }
  | { kind: 'thread'; projectId: string; threadId: string; turn: number; isolation: 'worktree' | 'main' };
/** Read-only project memory: the project checkout's notes on the device that runs the turn. */
export type ProjectMemoryReader = {
  search(query: string, signal: AbortSignal): Promise<z.infer<typeof MemorySearchSchema>>;
  read(permalink: string, signal: AbortSignal): Promise<MemoryNote>;
};
/** One coordinator tool line in the coordinator ledger (brief 8.1, 2.6.5). */
export type ToolLine = { summary: string; threadId?: string | undefined; decisionId?: string | undefined; reason?: string | undefined };
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };
export type ProjectToolHandlers = {
  /** The scope's turn is the running turn of its owner. */
  isCurrent(scope: ProjectScope): boolean;
  /** Every tool except the thread report and memory; returns the tool's versioned result document. */
  call(scope: ProjectScope, name: ProjectToolName, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** Resolved on first use, so a project without a checkout here fails the call with its own sentence. */
  memory(scope: ProjectScope): ProjectMemoryReader | Promise<ProjectMemoryReader>;
  /** Coordinator one-liners (phase 2): when given with a ledger, each call after the scope checks is recorded. */
  line?(name: ProjectToolName, input: unknown, outcome: ToolOutcome, scope: ProjectScope): ToolLine | Promise<ToolLine>;
};
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const message = (error: unknown) => error instanceof Error ? error.message : 'The tool request failed.';

/**
 * The tools of one coordinator or thread turn (brief 7, D11). A token lives only while its turn runs: closed scopes and
 * turns that are no longer current answer 401, tools outside the scope list 403. Calls are serialized like stretch tools;
 * arguments are redacted before parsing, and invalid input becomes one field sentence the model can act on.
 */
export class ProjectTools implements BridgeScopeTools {
  #active = true;
  #pending: Promise<unknown> = Promise.resolve();
  readonly #abort = new AbortController();
  #report: ThreadReport | undefined;
  constructor(readonly scope: ProjectScope, private readonly handlers: ProjectToolHandlers, private readonly redactor: SecretRedactor, private readonly ledger?: ProjectLedger) {}
  #check(): void {
    if (!this.#active || !this.handlers.isCurrent(this.scope)) throw failure(TURN_ENDED, 401);
  }
  #names(): BridgeTool[] { return projectToolNames(this.scope); }
  list(): z.infer<typeof BridgeToolsSchema> { this.#check(); return bridgeTools(this.#names()); }
  /** Thread scopes: the report accepted in this turn. */
  get report(): ThreadReport | undefined { return this.#report && structuredClone(this.#report); }
  /** The project memory hook fires in account homes during turns too; project scopes queue nothing. */
  async capture(): Promise<z.infer<typeof BridgeResultSchema>> { return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result: { queued: false, reason: 'disabled' } }); }
  async close(): Promise<void> { this.#active = false; this.#abort.abort(); await this.#pending; }
  call(name: BridgeTool, args: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    const result = this.#pending.then(() => this.#call(name, args));
    // Failed tool calls do not prevent a later corrected call or the end of the turn.
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async #call(name: BridgeTool, raw: unknown): Promise<z.infer<typeof BridgeResultSchema>> {
    this.#check();
    if (!this.#names().includes(name)) throw failure(TOOL_NOT_IN_TURN, 403);
    const tool = name as ProjectToolName;
    const args: unknown = this.redactor.document(raw); let input: unknown = args;
    try {
      const parsed = BridgeToolSchemas[tool].safeParse(args);
      if (!parsed.success) { const issue = parsed.error.issues[0]; throw failure(toolInputError(issue?.path ?? [], issue?.message ?? 'Invalid input'), 400); }
      input = parsed.data;
      const result = this.redactor.document(ProjectToolResultSchemas[tool].parse(await this.#handle(tool, input)));
      await this.#line(tool, input, { ok: true, result });
      return BridgeResultSchema.parse({ schema: 'bridge-result-v1', result });
    } catch (error) {
      await this.#line(tool, input, { ok: false, error: this.redactor.text(message(error)) });
      throw error;
    }
  }
  async #handle(name: ProjectToolName, input: unknown): Promise<unknown> {
    const signal = this.#abort.signal;
    if (name === 'jevellan_thread_report') return this.#accept(input as z.infer<typeof BridgeToolSchemas.jevellan_thread_report>);
    if (name === 'memory_search') return MemorySearchSchema.parse(await (await this.handlers.memory(this.scope)).search((input as { query: string }).query, signal));
    if (name === 'memory_read') return MemoryNoteSchema.parse(await (await this.handlers.memory(this.scope)).read((input as { permalink: string }).permalink, signal));
    return this.handlers.call(this.scope, name, input, signal);
  }
  /**
   * Exactly one report per turn (brief 7.2). An identical retry returns the original receipt with `repeated: true`, because
   * MCP transports retry calls whose reply was lost (D19); a different second report is refused.
   */
  #accept(input: z.infer<typeof BridgeToolSchemas.jevellan_thread_report>): unknown {
    if (this.scope.kind !== 'thread') throw failure(TOOL_NOT_IN_TURN, 403);
    const report = ThreadReportSchema.parse({ ...input, schema: 'thread-report-v1', turn: this.scope.turn, synthesized: false });
    const receipt = (repeated: boolean) => ({ schema: 'thread-report-result-v1', turn: report.turn, status: report.status, accepted: true, repeated });
    if (!this.#report) { this.#report = report; return receipt(false); }
    if (stableJson(this.#report) === stableJson(report)) return receipt(true);
    throw failure(REPORT_ALREADY_SENT, 409);
  }
  async #line(name: ProjectToolName, input: unknown, outcome: ToolOutcome): Promise<void> {
    if (!this.ledger || !this.handlers.line || this.scope.kind !== 'coordinator') return;
    // The action already happened: a chat line that cannot be written must not turn it into an error the model retries.
    try {
      const line = await this.handlers.line(name, input, outcome, this.scope);
      this.ledger.append({ type: 'coordinator-tool', turn: this.scope.turn, data: { schema: 'coordinator-tool-v1', tool: name, ok: outcome.ok, ...line } });
    } catch { /* The tool result stands without its one-liner. */ }
  }
}

/** What the coordinator's tools act on (brief 7.1). */
export type CoordinatorToolsOptions = {
  deviceId: string; deviceName: string;
  threads: Pick<ThreadService, 'start' | 'message' | 'stop' | 'list' | 'read'>;
  store: Pick<ThreadStore, 'get'>;
  decisions: Pick<DecisionItems, 'ask' | 'withdraw'>;
  pullRequests: Pick<PullRequestTracker, 'fresh'>;
  hub: Pick<ProjectHub, 'thread' | 'notebook' | 'putNotebook'>;
  ledgers: Pick<ProjectLedgers, 'coordinator'>;
  /** Mail to the threads that work on main (brief 7.1). */
  mail: Pick<MailService, 'coordinatorSend'>;
  roster(): Promise<DeviceRoster>;
  /** Read-only project memory on this device. */
  memory(projectId: string): Promise<ProjectMemoryReader>;
  now(): number;
};
type Input<T extends ProjectToolName> = z.output<(typeof BridgeToolSchemas)[T]>;
const statusOf = (error: unknown) => (error as { status?: unknown } | undefined)?.status;
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
const idField = (value: unknown, key: string): string | undefined => { const found = field(value, key); return IdSchema.safeParse(found).success ? found as string : undefined; };

/**
 * The coordinator's tools (brief 7.1, design 3.2 g). Starts return after placement, so worktree preparation never holds a
 * call past the bridge budget; a retried start or message of the same turn (an MCP transport retry) is recognized by an id
 * derived from the turn and the input. Every call leaves one line in the coordinator chat (D200).
 */
export function coordinatorToolHandlers(o: CoordinatorToolsOptions): Required<Omit<ProjectToolHandlers, 'isCurrent'>> {
  const deviceNames = async () => {
    const names = new Map(((await o.roster().catch(() => null))?.devices ?? []).map((view) => [view.device.id, view.device.name]));
    return (deviceId: string) => names.get(deviceId) ?? (deviceId === o.deviceId ? o.deviceName : deviceId);
  };
  /** A thread of this project: this device's thread, else its hub index (a thread owned by another device). */
  const known = async (projectId: string, threadId: string): Promise<{ title: string; index?: ThreadIndex } | undefined> => {
    const local = o.store.get(threadId); if (local) return local.projectId === projectId ? { title: local.title } : undefined;
    const index = (await o.hub.thread(threadId))?.document;
    return index && index.projectId === projectId ? { title: index.title, index } : undefined;
  };
  // The turn number is this device's (coordinator-local), so the coordinator device is part of every id: after a move the new device counts
  // from 1 again, and its deliveries never repeat the former device's ids (P8 review C-3).
  const turnId = (prefix: string, projectId: string, turn: number, input: unknown) => derivedId(prefix, 'coordinator', projectId, o.deviceId, String(turn), stableJson(input));
  async function call(projectId: string, turn: number, name: ProjectToolName, raw: unknown): Promise<unknown> {
    switch (name) {
      case 'jevellan_threads_list': {
        const input = raw as Input<typeof name>;
        const [threads, deviceName] = await Promise.all([o.threads.list(projectId, input.include), deviceNames()]);
        return { schema: 'threads-list-result-v1', threads: threads.map((thread) => ({ id: thread.id, title: thread.title, state: thread.state, isolation: thread.isolation,
          device: deviceName(thread.ownerDeviceId), runtime: thread.runtime, modelLabel: thread.modelLabel, effort: thread.effort, ...(thread.branch ? { branch: thread.branch } : {}),
          ...(thread.pr ? { pr: { number: thread.pr.number, state: thread.pr.state, checks: thread.pr.checks } } : {}),
          ...(thread.lastSummary ? { lastSummary: thread.lastSummary } : {}), turns: thread.turns })) };
      }
      case 'jevellan_thread_start': {
        const input = raw as Input<typeof name>;
        // Only the fields the coordinator gave are fixed; Jevellan places the rest (brief 7.1, 10).
        const started = await o.threads.start({ projectId, title: input.title, task: input.task, createdBy: 'coordinator', coordinatorDeviceId: o.deviceId, note: input.note,
          clientRequestId: turnId('treq', projectId, turn, input), fixed: { ...(input.isolation ? { isolation: input.isolation } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
            ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}), ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.effort ? { effort: input.effort } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}) } });
        return { schema: 'thread-start-result-v1', threadId: started.threadId, state: started.state, ...(started.stateReason === undefined ? {} : { stateReason: started.stateReason }),
          placement: started.placement.slice(0, 400) };
      }
      case 'jevellan_thread_message': {
        const input = raw as Input<typeof name>;
        const sent = await o.threads.message(projectId, input.threadId, 'coordinator', input.message, input.interrupt, turnId('tmsg', projectId, turn, input));
        return { schema: 'thread-message-result-v1', threadId: input.threadId, state: sent.state, delivery: sent.delivery };
      }
      case 'jevellan_thread_read': {
        const input = raw as Input<typeof name>;
        if (o.store.get(input.threadId)) return o.threads.read(projectId, input.threadId, input.detail);
        // Another device's thread (D42): its index and the reports this coordinator received; the transcript stays there.
        const remote = (await known(projectId, input.threadId))?.index; if (!remote) throw failure(THREAD_NOT_FOUND, 404);
        const ledger = o.ledgers.coordinator(projectId);
        const reports = ledger.events().filter((event) => event.type === 'coordinator-event')
          .flatMap((event) => { const data = ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }); return data.kind === 'thread-report' && data.threadId === remote.id ? [data.report] : []; })
          .slice(-3);
        return { schema: 'thread-read-result-v1', threadId: remote.id, state: remote.state, ...(remote.stateReason === undefined ? {} : { stateReason: remote.stateReason }), reports,
          ...(remote.pr ? { pr: remote.pr } : {}), ...(input.detail === 'transcript' ? { transcript: null, transcriptNote: transcriptStaysOn((await deviceNames())(remote.ownerDeviceId)) } : {}) };
      }
      case 'jevellan_thread_stop': {
        const input = raw as Input<typeof name>;
        // A stop by the coordinator sends it no event (D28); a thread on another device gets one command per call (D265).
        await o.threads.stop(projectId, input.threadId, input.reason, false, turnId('tcmd', projectId, turn, input));
        return { schema: 'thread-stop-result-v1', threadId: input.threadId, state: o.store.get(input.threadId)?.state ?? 'stopped' };
      }
      case 'jevellan_ask_user': {
        const input = raw as Input<typeof name>;
        if (input.threadId !== undefined && !(await known(projectId, input.threadId))) throw failure(THREAD_NOT_FOUND, 404);
        // One question per call: a transport retry of the call returns the question it created (P8 review C-4, as D201 for starts).
        return { schema: 'ask-user-result-v1', decisionId: await o.decisions.ask(projectId, input, 'coordinator', turnId('pdec', projectId, turn, input)) };
      }
      case 'jevellan_withdraw_question': {
        const input = raw as Input<typeof name>;
        return { schema: 'withdraw-question-result-v1', decisionId: input.decisionId, withdrawn: await o.decisions.withdraw(projectId, input.decisionId) };
      }
      case 'jevellan_notebook_read': {
        const stored = await o.hub.notebook(projectId);
        return { schema: 'notebook-read-result-v1', content: stored?.document.content ?? '', revision: stored?.revision ?? 0 };
      }
      case 'jevellan_notebook_write': {
        const input = raw as Input<typeof name>;
        const notebook = ProjectNotebookSchema.parse({ schema: 'project-notebook-v1', projectId, revision: input.expectedRevision, content: input.content,
          updatedAt: new Date(o.now()).toISOString(), updatedBy: 'coordinator' });
        try { return { schema: 'notebook-write-result-v1', revision: (await o.hub.putNotebook(notebook, input.expectedRevision)).revision }; }
        catch (error) {
          if (statusOf(error) !== 409) throw error;
          // The model gets the current content in the error, so it can merge and write again (D59).
          const current = await o.hub.notebook(projectId);
          throw failure(notebookConflict(current?.revision ?? 0, current?.document.content ?? ''), 409);
        }
      }
      case 'jevellan_pr_status': {
        const input = raw as Input<typeof name>;
        const read = await o.pullRequests.fresh(projectId, input.threadId);
        return { schema: 'pr-status-result-v1', threadId: input.threadId, pr: read.pr, ...(read.reason ? { reason: read.reason.slice(0, 400) } : {}) };
      }
      case 'jevellan_mail_send': return o.mail.coordinatorSend(projectId, turn, raw as Input<typeof name>, o.deviceId);
      // The thread tools (report, inbox and reservations) are not the coordinator's.
      default: throw failure(TOOL_NOT_IN_TURN, 403);
    }
  }
  return {
    call: (scope, name, input) => call(scope.projectId, scope.turn, name, input),
    memory: (scope) => o.memory(scope.projectId),
    line: async (name, input, outcome, scope) => {
      // Mail names its thread in `to` (`all` and `coordinator` are id-shaped but no thread).
      const recipient = name === 'jevellan_mail_send' ? idField(input, 'to') : undefined;
      const threadId = idField(input, 'threadId') ?? (recipient === 'all' || recipient === 'coordinator' ? undefined : recipient)
        ?? (outcome.ok ? idField(outcome.result, 'threadId') : undefined);
      const thread = threadId === undefined ? undefined : await known(scope.projectId, threadId).catch(() => undefined);
      const decisionId = outcome.ok ? idField(input, 'decisionId') ?? idField(outcome.result, 'decisionId') : undefined;
      // The withdrawn-question toast reads `reason` (D84): only a question this call withdrew carries one.
      const withdrawn = outcome.ok && name === 'jevellan_withdraw_question' && field(outcome.result, 'withdrawn') === true;
      return { summary: coordinatorToolSummary(name, input, outcome, thread?.title), ...(thread ? { threadId } : {}), ...(decisionId ? { decisionId } : {}),
        ...(withdrawn ? { reason: (input as Input<'jevellan_withdraw_question'>).reason } : {}) };
    },
  };
}
