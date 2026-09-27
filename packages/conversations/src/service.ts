import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ActionSchema, AdoptChangesSchema, CheckpointAdoptionSchema, CheckpointBlockSchema, CheckpointReceiptSchema, CheckoutOwnership, ComposerChoiceSchema, ComposerInitialSchema, ConversationChangesSchema, ConversationListSchema, ConversationMessageSchema, ConversationNoticeSchema, ConversationOperationSchema, ConversationProgressSchema, ConversationPublicSchema, CorrectStepSchema,
  ContextContinueSchema, ContextOperationSchema, ContextPanelSchema, ContextRequestSchema, ContextReviewSchema, DecisionRecordSchema, DecisionWaitSchema, FinishOutsideOperationSchema, FinishOutsideSchema, GitWorkspace, IdSchema, JevCallSchema, ManualStepSchema, PlanApprovalSchema, ProjectsListSchema, ProjectViewSchema, ProjectWriteSchema, RenameConversationSchema,
  OverrideRecordSchema, PROJECT_MEMORY_ID, PublicationEventSchema, RedoOperationSchema, ResumeDecisionSchema, RetryRedoSchema, SettleWorkSchema, StartComposerChoicesSchema, StartConversationSchema, StretchSchema, UndoAppliedSchema, VerificationSchema, WorkSettlementSchema, mapEffort, newId, resolveProjectPath, stableJson,
  type Action, type CheckpointAdoption, type Configuration, type ContextOperation, type CoordinationStore, type DecisionRecord, type DecisionWait, type GitSnapshot, type Homes, type HubWait, type JevCall, type ManualStep, type Project, type PublicationLease, type PublicationLeaseService, type RedoOperation, type RiggingItem, type SecretRedactor,
} from '@jevellan/core';
import { applicationRoot, conversationIndex, decisionIndex, type IndexDocument, type SharedIndexes, type SharedProjects } from '@jevellan/core';
import { IndexDelivery } from './indexes.js';
import { CheckoutHistoryError, recordedCheckoutHead } from './checkout-history.js';
import type { ContextOperations } from './context-operations.js';
import { ProjectSaves } from './project-saves.js';
import { rankAccounts, type AccountService } from '@jevellan/accounts';
import { BasicMemory, ProjectContext } from '@jevellan/memory';
import { buildDecisionState, decideNext, JevError, jevMetadata, manualFallback, modelCandidates, selectMemory, type DecisionClient } from '@jevellan/decisions';
import type { RuntimeAdapter, StretchInput } from '@jevellan/runtime-contract';
import { actionContract, actionPermissions } from './actions.js';
import { StretchBridges } from './bridge.js';
import type { IntegrationRunner } from '@jevellan/core';
import { buildBrief, changeUnderReview } from './brief.js';
import { StretchExecution } from './execution.js';
import { allowedActions, allowedInitialActions, checkGuards } from './guards.js';
import { ConversationLedger } from './ledger.js';
import { MemoryQueue, searchMemoryCandidates } from './memory.js';
import { publishWorkspace, recoverIntegrationHistory } from './publication.js';
import { RESTART_NOTICE, recoverRunningWork } from './recovery.js';
import { externalVerificationCounts, verifyWorkspace } from './verification.js';
import { ConversationWork } from './work.js';
import { correctionContext, overrides, redoOperations, undoRange } from './corrections.js';
import { bindComposerChoices, composerOverrides, planComposerBindings, saveComposerChoice } from './choices.js';
import { checkpointAdoptions, checkpointBlocks, reviewCheckpoint } from './checkpoints.js';
import { ConversationFileRequestSchema } from '@jevellan/core';
import { readProjectFile } from './file-evidence.js';
import { ExternalActivityError, ExternalActivityGuard, type ExternalActivityOptions } from './external-activity.js';
import { ExternalActivityWaitSchema, RetryExternalActivitySchema } from '@jevellan/core';
import { HubWaits, recoverHubWaits } from './hub-waits.js';
import { HubUnavailable } from '@jevellan/mesh';

type Settings = Configuration['x-jevellan'];
type Operation = { progress?: ReturnType<typeof ConversationProgressSchema.parse>; promise: Promise<void>; abort: AbortController; cancelled: boolean; shutdown?: boolean; cancellationCleanup?: boolean; redoId?: string; execution?: StretchExecution; decisionAbort?: AbortController; outside?: ReturnType<ExternalActivityGuard['watch']> };
type PreparedDecision = { record: DecisionRecord; state: string; client: DecisionClient; calls: JevCall[] };
class StaleDecision extends Error { readonly status = 409; constructor() { super('The conversation changed before this action could proceed. Pick the next step again.'); } }
export type ConversationServiceOptions = {
  homes: Homes; contexts: ContextOperations; projects: SharedProjects; deviceId: string; accounts: AccountService; runtimes: ReadonlyMap<string, RuntimeAdapter>;
  bridges: StretchBridges; memory: BasicMemory; redactor: SecretRedactor; settings(): Settings | Promise<Settings>;
  riggingItems(runtime: string): RiggingItem[] | Promise<RiggingItem[]>;
  coordination: CoordinationStore; leases: PublicationLeaseService; indexes: SharedIndexes;
  decisionClient?(): DecisionClient | Promise<DecisionClient>; jevAvailable?(): boolean | Promise<boolean>; deviceLabel?: string;
  externalSessions?: ExternalActivityOptions['read'];
  enterOperation?: (id: string, title: string) => () => void;
  accountRuns?: Set<string>;
};
const MANUAL_NOTICE = 'Pick the next step, model and effort.';
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

/** The sole scheduling authority on an owner device. Reading history never schedules work. */
export class ConversationService {
  readonly ready: Promise<void>;
  readonly ownership: CheckoutOwnership;
  readonly leases: PublicationLeaseService;
  readonly indexes: IndexDelivery;
  readonly outside: ExternalActivityGuard;
  readonly hubWaits = new HubWaits();
  readonly #works = new Map<string, ConversationWork>();
  readonly #operations = new Map<string, Operation>();
  readonly #accountRuns: Set<string>;
  readonly #correcting = new Set<string>();
  #closed = false;
  daemonUrl = '';
  constructor(readonly options: ConversationServiceOptions) {
    this.#accountRuns = options.accountRuns ?? new Set<string>();
    this.ownership = new CheckoutOwnership(options.coordination, options.homes, options.deviceId, process.pid, options.deviceLabel ?? options.deviceId); this.leases = options.leases;
    this.indexes = new IndexDelivery(options.indexes);
    this.outside = new ExternalActivityGuard({ deviceId: options.deviceId, deviceName: options.deviceLabel ?? options.deviceId, ...(options.externalSessions ? { read: options.externalSessions } : {}) });
    this.ready = this.#recover(); void this.ready.catch(() => undefined);
  }
  async #recover(): Promise<void> {
    const folder = this.options.homes.at('conversations'); if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !IdSchema.safeParse(entry.name).success) continue;
      const work = this.#load(entry.name); const view = work.load();
      if (view.conversation.ownerDeviceId !== this.options.deviceId) throw new Error('A conversation directory belongs to another device.');
      for (const n of (await recoverRunningWork(work)).recovered) await this.#blockInterrupted(work, n);
      recoverHubWaits(work); this.#index(work);
      this.#indexComposer(work);
      for (const adoption of checkpointAdoptions(work).filter((entry) => entry.status !== 'completed')) {
        if (!checkpointBlocks(work).some((block) => adoption.blocks.includes(block.eventId))) continue;
        try {
          const workspace = (await this.#adoptionWorkspace(work, adoption));
          if (adoption.plan && await workspace.checkpointApplied(adoption.plan)) { await this.#finishAdoption(work, workspace, adoption); continue; }
          adoption.reason = 'Jevellan restarted before the reviewed changes were accepted. Open Changes and review them again.';
        } catch { adoption.reason = 'The recorded checkpoint could not be reconciled. Inspect the checkout before continuing.'; }
        adoption.status = 'blocked'; this.#saveAdoption(work, adoption);
      }
      for (const correction of overrides(work)) {
        this.#queueIndex(work, correction);
        if (correction.request.mode === 'redo' && !redoOperations(work).some((entry) => entry.id === correction.id)) work.ledger.append({ type: 'git', data: RedoOperationSchema.parse({ schema: 'redo-operation-v1', id: correction.id, workId: correction.workId, fromStretch: correction.request.stretch, generation: work.load().conversation.generation, status: 'blocked', reason: 'Jevellan restarted after accepting this correction. Undo did not start.' }) });
      }
      for (const pending of redoOperations(work)) {
        if (pending.status === 'completed') continue;
        try { await this.#recoverUndo(work, pending); }
        catch (error) { pending.reason = error instanceof Error ? error.message : 'Undo recovery could not inspect the checkout.'; }
        if (this.#wasRedone(work, pending)) { pending.status = 'completed'; delete pending.reason; this.#saveRedo(work, pending); continue; }
        if (['completed', 'blocked'].includes(pending.status)) continue;
        const reason = 'Jevellan restarted during undo and redo. Inspect the saved recovery ref and checkout before continuing; no step was relaunched.';
        work.ledger.append({ type: 'git', data: RedoOperationSchema.parse({ ...pending, status: 'blocked', reason }) });
        if (work.load().conversation.work && work.load().conversation.state !== 'running') work.pause(reason, 'blocked');
        this.#notice(work, reason, 'error');
      }
      for (const settlement of this.#settlements(work).filter((entry) => entry.status === 'requested')) {
        const current = work.load().conversation;
        if (settlement.reclose && current.work?.id === settlement.workId && current.state !== 'running') work.close(settlement.closedAs);
        work.ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse({ ...settlement, status: 'blocked', reason: 'Jevellan restarted during settlement. Inspect the checkout and choose how to settle it again.' }) });
        this.#notice(work, 'Jevellan restarted during settlement. Inspect the checkout and choose how to settle it again.', 'error');
      }
      for (const decision of this.decisions(entry.name)) { bindComposerChoices(work, decision); this.#materialiseDecision(work, decision); }
      for (const finish of work.load().finishes.filter((entry) => entry.status === 'requested')) await this.#finishOutside(work, finish.request.clientRequestId);
      if (work.load().conversation.outcome) this.#finishContext(work, 'cancelled');
    }
    // Context conversations created before `origin` existed get it as a new ledger event, never by
    // rewriting the index already published for an earlier event.
    const contextConversations = new Set(this.options.contexts.list().map((record) => record.conversationId));
    for (const work of this.#works.values()) if (contextConversations.has(work.ledger.id) && !work.load().conversation.origin) work.recordOrigin('context-operation');
    for (const record of this.options.contexts.list()) {
      if (['completed', 'cancelled', 'draft-ready'].includes(record.status)) continue;
      record.status = 'blocked'; record.reason = 'Jevellan restarted during this context change. Inspect the files and retry; no operation was resumed automatically.';
      this.#saveContextOperation(record);
    }
  }
  #load(id: string, create = false): ConversationWork {
    IdSchema.parse(id); let work = this.#works.get(id);
    if (!work) {
      const ledger = new ConversationLedger(this.options.homes, id, { redactor: this.options.redactor });
      if (!create && !ledger.events().length) throw Object.assign(new Error('Conversation not found on this device.'), { status: 404 });
      work = new ConversationWork(ledger); this.#works.set(id, work);
      const current = work;
      ledger.subscribe((event) => { if (['state', 'user-message', 'note', 'stretch-start', 'stretch-end', 'undo', 'override', 'conversation-control'].includes(event.type)) this.#index(current); });
    }
    return work;
  }
  #index(work: ConversationWork): void {
    if (this.#closed) return;
    this.#queueIndex(work, conversationIndex(work.load().conversation));
  }
  #queueIndex(work: ConversationWork, document: IndexDocument): void {
    const eventId = work.ledger.events().at(-1)!.id;
    const conversation = conversationIndex(work.load().conversation);
    this.indexes.enqueue({ schema: 'index-update-v1', eventId, document: conversation });
    if (document.schema !== 'conversation-index-v1') this.indexes.enqueue({ schema: 'index-update-v1', eventId, document });
  }
  #notice(work: ConversationWork, text: string, kind: 'info' | 'error' | 'closing' | 'steer' = 'info'): void {
    work.ledger.append({ type: kind === 'steer' ? 'steer' : 'notice', data: ConversationNoticeSchema.parse({ schema: 'conversation-notice-v1', text, kind }) });
  }
  async #project(id: string): Promise<Project> {
    const row = await this.options.projects.get(IdSchema.parse(id));
    if (!row) throw Object.assign(new Error('Project not found.'), { status: 404 }); return row.project;
  }
  async projects() { return ProjectsListSchema.parse({ schema: 'projects-list-v1', projects: await this.options.projects.list() }); }
  async context(id: string) { return new ProjectContext((await this.#project(id)), this.options.deviceId, () => { throw new Error('Context inspection cannot change files.'); }).inspect(); }
  #saveContextOperation(record: ContextOperation) {
    this.options.contexts.put(this.options.redactor.document(record));
  }
  #finishContext(work: ConversationWork, status: 'completed' | 'cancelled') {
    for (const record of this.options.contexts.list()) {
      if (record.conversationId !== work.ledger.id || ['completed', 'cancelled'].includes(record.status)) continue;
      record.status = status; delete record.reason; this.#saveContextOperation(record);
    }
  }
  async contextPanel(id: string) {
    const row = await this.options.projects.get(id); if (!row) throw new Error('Project not found.');
    const operations = this.options.contexts.list().filter((entry) => entry.projectId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ContextPanelSchema.parse({ schema: 'context-panel-v1', context: (await this.context(id)), revision: row.revision,
      operations: operations.map((entry) => ({ ...entry, generation: this.#load(entry.conversationId).load().conversation.generation })), busy: operations.some((entry) => this.#operations.has(entry.conversationId)) });
  }
  async #contextWorkspace(record: ContextOperation) {
    const conversation = this.#load(record.conversationId).load().conversation;
    return new GitWorkspace(await this.#project(record.projectId), this.options.deviceId, this.ownership, { conversationId: conversation.id, conversationTitle: conversation.title, workId: record.workId }, this.options.redactor);
  }
  async #contextReview(record: ContextOperation) {
    const work = this.#load(record.conversationId); const view = work.load(); const target = view.conversation.work ?? view.closedWorks.at(-1);
    if (view.conversation.outcome || !target || target.id !== record.workId || target.closedAs === 'done') throw conflict('This context review no longer belongs to the current or kept work.');
    const workspace = await this.#contextWorkspace(record);
    if (!record.applied || record.commit || !record.activityReason || !record.beforeGit || workspace.project.branchPolicy !== 'main') throw conflict('This context operation has no outside changes to review.');
    if (this.#operations.has(work.ledger.id)) throw conflict('Wait for the context operation to settle before reviewing it.');
    await workspace.checkpointBoundary(record.beforeGit);
    const generation = work.load().conversation.generation; const before = await workspace.snapshot();
    const digest = await workspace.workingTreeDigest(); const diff = await workspace.uncommittedDiff();
    if (generation !== work.load().conversation.generation || stableJson(before) !== stableJson(await workspace.snapshot()) || digest !== await workspace.workingTreeDigest()) throw conflict('The checkout changed while loading this review. Review changes again.');
    const fingerprint = createHash('sha256').update(stableJson({ operationId: record.id, workId: record.workId, project: workspace.project, path: workspace.path, generation, before, digest })).digest('hex');
    return { workspace, before, digest, review: ContextReviewSchema.parse({ schema: 'context-review-v1', operationId: record.id, generation, fingerprint, diff }) };
  }
  async reviewContext(id: string, operationId: string) {
    await this.ready; const record = this.options.contexts.get(IdSchema.parse(operationId));
    if (!record || record.projectId !== id) throw conflict('Context operation not found.');
    return (await this.#contextReview(record)).review;
  }
  async #contextModel(modelId?: string): Promise<string> {
    const config = (await this.options.settings()); const accounts = await this.options.accounts.list();
    const model = config.menu.find((entry) => (!modelId || entry.id === modelId) && entry.enabled && config.runtimes[entry.runtime]?.enabled
      && this.options.runtimes.get(entry.runtime)?.capabilities.readOnlyEnforced && this.options.runtimes.get(entry.runtime)?.capabilities.mcp
      && rankAccounts({ accounts: accounts.map((row) => row.account), statuses: accounts.flatMap((row) => row.statuses), runtime: entry.runtime, model: entry.model, deviceId: this.options.deviceId }).some((row) => row.eligible));
    if (!model) throw conflict('No model can draft this merge right now. Add or enable an eligible account in Runtimes.');
    return model.id;
  }
  async configureContext(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = ContextRequestSchema.parse(raw); const previous = this.options.contexts.get(input.clientRequestId);
    if (previous) { if (previous.projectId !== id || stableJson(previous.request) !== stableJson(input)) throw conflict('This context request id was already used for another choice.'); return (await this.contextPanel(id)); }
    const settings = await this.options.settings();
    const panel = (await this.contextPanel(id)); const project = (await this.#project(id));
    if (panel.busy || panel.operations.some((entry) => !['completed', 'cancelled'].includes(entry.status))) throw conflict('Finish or cancel the existing context operation first.');
    if (input.revision !== panel.revision || input.fingerprint !== panel.context.fingerprint) throw conflict('Context files or project settings changed. Reload before choosing.');
    const files = panel.context.files;
    if (input.choice === 'create' ? !files.every((file) => file.kind === 'missing' && !file.tracked)
      : input.choice === 'link' ? !panel.context.primary || panel.context.state !== 'none' || files.some((file) => file.kind === 'missing' && file.tracked)
      : !files.every((file) => file.kind === 'file')) throw conflict('This choice does not match the current instruction files. Reload the context panel.');
    if (project.branchPolicy === 'external' && (input.choice === 'merge' || input.choice.startsWith('keep-') && files.some((file) => file.name === (input.choice === 'keep-claude' ? 'AGENTS.md' : 'CLAUDE.md') && file.tracked))) throw conflict('This project follows its own git rules. Jevellan can only create local context links here.');
    const modelId = input.choice === 'merge' ? await this.#contextModel(input.modelId) : input.modelId;
    if (this.#closed) throw new Error('Conversations are closed.');
    const concurrent = this.options.contexts.get(input.clientRequestId);
    if (concurrent) { if (concurrent.projectId !== id || stableJson(concurrent.request) !== stableJson(input)) throw conflict('This context request id was already used for another choice.'); return (await this.contextPanel(id)); }
    const currentPanel = (await this.contextPanel(id));
    if (currentPanel.revision !== panel.revision || currentPanel.context.fingerprint !== panel.context.fingerprint || currentPanel.busy || currentPanel.operations.some(entry => !['completed', 'cancelled'].includes(entry.status))) throw conflict('Context files or project settings changed. Reload before choosing.');
    // Persist the operation before any shared mutation. Its owned execution records the resulting context.
    const projectRevision = panel.revision;
    if (this.#closed) throw new Error('Conversations are closed.');
    const latest = this.options.contexts.get(input.clientRequestId);
    if (latest) { if (latest.projectId !== id || stableJson(latest.request) !== stableJson(input)) throw conflict('This context request id was already used for another choice.'); return this.contextPanel(id); }
    if (this.options.contexts.list().some(entry => entry.projectId === id && !['completed', 'cancelled'].includes(entry.status))) throw conflict('Finish or cancel the existing context operation first.');
    const work = this.#load(newId('conversation'), true); work.create({ title: `Context · ${project.name}`, projectId: id, origin: 'context-operation', ownerDeviceId: this.options.deviceId });
    work.message(input.choice === 'merge' ? 'Merge AGENTS.md and CLAUDE.md into one complete AGENTS.md, preserving both files’ instructions and resolving duplicate wording. Read both files. Do not edit any files. Return the complete merged Markdown as a handoff result of type merge-draft. The user will inspect the diff and apply it separately.' : `Configure project instructions: ${input.choice}.`, input.clientRequestId, 'user-message', settings.guards.maxStretchesPerWork);
    const record = ContextOperationSchema.parse({ schema: 'context-operation-v1', id: input.clientRequestId, projectId: id, conversationId: work.ledger.id, workId: work.load().conversation.work!.id, request: input, before: panel.context,
      generation: work.load().conversation.generation, projectRevision, createdAt: new Date().toISOString(), status: 'requested', ...(modelId ? { modelId } : {}) });
    this.#saveContextOperation(record); await this.#operate(work, (operation) => this.#runContext(work, record, operation)); return (await this.contextPanel(id));
  }
  async continueContext(id: string, raw: unknown) {
    await this.ready; const input = ContextContinueSchema.parse(raw); const record = this.options.contexts.get(input.operationId);
    if (!record || record.projectId !== id) throw conflict('Context operation not found.');
    const previous = record.continuations.find((entry) => entry.clientRequestId === input.clientRequestId);
    if (previous) { if (stableJson(previous) !== stableJson(input)) throw conflict('This context continuation id was already used.'); return (await this.contextPanel(id)); }
    const work = this.#load(record.conversationId); const current = work.load().conversation;
    if (this.#operations.has(work.ledger.id) || current.state === 'running') throw conflict('Wait for this context operation to finish.');
    const target = current.work ?? work.load().closedWorks.at(-1);
    if (current.outcome || !target || target.id !== record.workId || target.closedAs === 'done' && !(input.action === 'retry' && record.applied && record.status === 'blocked') || !current.work && !['retry', 'accept-changes'].includes(input.action) || current.generation !== input.generation) throw conflict('This context choice is stale. Reload the operation.');
    if (input.action === 'apply' && record.status !== 'draft-ready') throw conflict('The merge draft is not ready to apply.');
    if (input.action === 'retry' && record.status !== 'blocked') throw conflict('Only a blocked context operation can be retried.');
    if (input.action === 'cancel' && record.applied) throw conflict('The context changes were already applied. Settle them from their conversation.');
    const reviewed = input.action === 'accept-changes' ? await this.#contextReview(record) : undefined;
    if (input.action === 'accept-changes') {
      if (input.fingerprint !== reviewed!.review.fingerprint || input.generation !== reviewed!.review.generation) throw conflict('These files changed since your review. Review changes again.');
      await this.#outsideIdle(reviewed!.workspace);
    } else if (input.action === 'retry' && record.activityReason && (!record.checkpointPlan || !await (await this.#contextWorkspace(record)).checkpointApplied(record.checkpointPlan))) throw conflict('Review the current changes before accepting this context checkpoint.');
    if (input.action === 'apply') record.approved = true;
    if (!current.work) work.reopen(record.workId);
    record.continuations.push(input); work.invalidate('override'); record.generation = work.load().conversation.generation; delete record.reason;
    if (input.action === 'cancel') { await this.cancel(work.ledger.id); record.status = 'cancelled'; this.#saveContextOperation(record); }
    else {
      record.status = 'requested'; this.#saveContextOperation(record);
      await this.#operate(work, async operation => {
        if (reviewed) {
          const { workspace, before, digest } = reviewed;
          try {
            await this.#contextWait(work, record, operation, () => this.ownership.acquire(workspace.project, workspace.owner));
            await this.#contextCheckpoint(work, record, operation, workspace, input.clientRequestId, before, digest, true);
          } catch (error) { record.status = 'blocked'; record.reason = error instanceof Error ? error.message : 'The reviewed checkpoint could not be accepted.'; this.#saveContextOperation(record); throw error; }
        }
        await this.#runContext(work, record, operation);
      });
    }
    return (await this.contextPanel(id));
  }
  #contextWait<T>(work: ConversationWork, record: ContextOperation, operation: Operation, run: () => Promise<T>, shouldRetry?: () => boolean): Promise<T> {
    return this.hubWaits.retry(work, operation.abort.signal, 'context', async () => {
      this.#current(work, record.generation, operation); return run();
    }, { owner: { workId: record.workId, generation: record.generation }, ...(shouldRetry ? { shouldRetry } : {}) });
  }
  #contextContent(context: ProjectContext): string {
    return createHash('sha256').update(stableJson(context.inspect().files.map(({ name, kind, hash, target }) => ({ name, kind, hash, target })))).digest('hex');
  }
  #contextUnchanged(record: ContextOperation, context: ProjectContext): void {
    if (record.afterContentFingerprint ? this.#contextContent(context) !== record.afterContentFingerprint : context.inspect().fingerprint !== record.afterFingerprint) throw conflict('Applied context files changed. Inspect this work before retrying.');
  }
  async #contextCheckpoint(work: ConversationWork, record: ContextOperation, operation: Operation, workspace: GitWorkspace, id: string, before: GitSnapshot, digest: string, reviewed = false): Promise<void> {
    const context = new ProjectContext(workspace.project, this.options.deviceId, () => undefined);
    const current = async () => { await this.#outsideIdle(workspace); this.#current(work, record.generation, operation); if (!reviewed) this.#contextUnchanged(record, context); };
    if (!record.checkpointPlan || record.checkpointPlan.id !== id) {
      record.checkpointPlan = await this.#contextWait(work, record, operation, () => workspace.planCheckpoint(id, before, digest, current));
      record.status = 'applying'; this.#saveContextOperation(record);
    }
    const plan = record.checkpointPlan;
    await this.#contextWait(work, record, operation, async () => {
      if (!await workspace.checkpointApplied(plan)) await workspace.applyCheckpoint(plan, current);
    });
    record.commit = plan.after;
    if (!reviewed) this.#contextUnchanged(record, context);
    delete record.activityReason;
    record.afterFingerprint = context.inspect().fingerprint; record.afterContentFingerprint = this.#contextContent(context);
    this.#saveContextOperation(record);
  }
  async #runContext(work: ConversationWork, record: ContextOperation, operation: Operation) {
    let cleanupWorkspace: GitWorkspace | undefined;
    try {
      const workspace = await this.#contextWait(work, record, operation, () => this.#workspace(work)); cleanupWorkspace = workspace; const project = workspace.project;
      const context = new ProjectContext(project, this.options.deviceId, async () => { this.#current(work, record.generation, operation); await this.ownership.assert(project, workspace.owner); await this.#outsideIdle(workspace); this.#current(work, record.generation, operation); });
      if (record.checkpointPlan && !record.commit && await workspace.checkpointApplied(record.checkpointPlan)) { record.commit = record.checkpointPlan.after; if (record.checkpointPlan.id === record.id) this.#contextUnchanged(record, context); record.afterFingerprint = context.inspect().fingerprint; record.afterContentFingerprint = this.#contextContent(context); delete record.activityReason; this.#saveContextOperation(record); }
      this.#current(work, record.generation, operation); this.#checkpointAllowed(work, record.workId);
      if (record.draft && !record.approved) { record.status = 'draft-ready'; this.#saveContextOperation(record); work.pause('Review the context merge in Settings → Projects, then Apply or Cancel.'); return; }
      if (record.request.choice === 'merge' && !record.draft) {
        if (context.inspect().fingerprint !== record.request.fingerprint) throw conflict('Context files changed. Request a new merge draft.');
        const stop = checkGuards(work.load().conversation.work!, (await this.#contextWait(work, record, operation, () => Promise.resolve(this.options.settings()))).guards); if (stop) throw new Error(stop.notice);
        record.status = 'drafting'; this.#saveContextOperation(record);
        const before = work.load().conversation.stretchCount;
        await this.#contextWait(work, record, operation, async () => {
          if (context.inspect().fingerprint !== record.request.fingerprint) throw conflict('Context files changed. Request a new merge draft.');
          await this.#stretch(work, workspace, { schema: 'manual-step-v1', generation: record.generation, action: 'reply', modelId: record.modelId!, effort: 'high', remember: false }, operation, 'reply');
        }, () => work.load().conversation.stretchCount === before);
        this.#current(work, record.generation, operation);
        const handoff = this.#lastHandoff(work); const result = handoff?.result;
        if (work.load().stretches.at(-1)?.status !== 'completed' || handoff?.status !== 'done' || result?.type !== 'merge-draft') throw new Error('The step did not return a completed merge draft. No context files were changed.');
        const draft = work.ledger.read(result.ref); if (typeof draft !== 'string' || !draft.trim() || draft.length > 256_000) throw new Error('The merge draft must be complete Markdown text.');
        if (context.inspect().fingerprint !== record.request.fingerprint) throw conflict('Context files changed while drafting. Request a new merge draft.');
        record.draft = draft; record.draftRef = result.ref; record.draftStretch = work.load().stretches.at(-1)!.n; record.status = 'draft-ready'; this.#saveContextOperation(record); work.pause('Review the context merge in Settings → Projects, then Apply or Cancel.'); return;
      }
      await this.#contextWait(work, record, operation, async () => { await this.#outsideIdle(workspace); await this.ownership.acquire(project, workspace.owner); this.#current(work, record.generation, operation); });
      if (record.activityReason && !record.commit) throw conflict(record.activityReason);
      await this.#contextWait(work, record, operation, async () => { if (!record.applied) {
        const row = (await this.options.projects.get(project.id))!;
        if (row.revision !== (record.projectRevision ?? record.request.revision) || context.inspect().fingerprint !== record.request.fingerprint) throw conflict('Context files or project settings changed. Cancel this operation and reload.');
        const before = context.inspect(); const choice = record.request.choice;
        const secondary = choice === 'keep-claude' ? 'AGENTS.md' : 'CLAUDE.md';
        const tracked = project.branchPolicy === 'main' && (choice === 'create' || choice === 'merge' || ['keep-agents', 'keep-claude'].includes(choice) && before.files.some((file) => file.name === secondary && file.tracked));
        if (tracked && !work.load().conversation.work!.baseCommit) work.baseCommit(await workspace.prepare());
        if (context.inspect().fingerprint !== record.request.fingerprint) throw conflict('Context files changed while preparing the checkout. Cancel and reload.');
        record.beforeGit = await workspace.snapshot(); record.beforeHead = record.beforeGit.head; record.status = 'applying'; this.#saveContextOperation(record);
        const after = choice === 'create' || choice === 'link' ? await context.ensure(choice === 'create') : await context.choose(choice === 'merge'
          ? { schema: 'context-choice-v1', choice, fingerprint: record.request.fingerprint, content: record.draft! }
          : { schema: 'context-choice-v1', choice, fingerprint: record.request.fingerprint });
        record.applied = true; record.afterFingerprint = after.fingerprint; record.afterContentFingerprint = this.#contextContent(context); record.status = 'applied'; this.#saveContextOperation(record);
        record.appliedDigest = await workspace.workingTreeDigest(); this.#saveContextOperation(record);
      } else this.#contextUnchanged(record, context); });
      const digest = record.appliedDigest ?? await workspace.workingTreeDigest();
      await this.#contextWait(work, record, operation, async () => {
        const after = context.inspect(); const latest = (await this.options.projects.get(project.id))!;
        this.#contextUnchanged(record, context);
        if (stableJson({ ...latest.project, context: project.context }) !== stableJson(project)) throw conflict('Project settings changed while applying context. Inspect this work before retrying.');
        const nextContext = { state: after.state, ...(after.primary ? { primary: after.primary } : {}) };
        const saved = stableJson(latest.project.context) === stableJson(nextContext) ? latest : await this.options.projects.context(project.id, nextContext, latest.revision);
        record.projectRevision = saved.revision; this.#saveContextOperation(record);
      });
      if (work.load().conversation.work!.baseCommit) {
        if (!record.commit) {
          if (await workspace.head() !== record.beforeHead) throw conflict('Git changed before the context checkpoint was recorded. Inspect this work before continuing.');
          await this.#contextCheckpoint(work, record, operation, workspace, record.checkpointPlan?.id ?? record.id, record.beforeGit!, digest);
        }
        const draftedBy = work.load().stretches.find((step) => step.workId === record.workId && step.n === record.draftStretch && step.status !== 'undone');
        if (draftedBy) {
          const receipt = CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId: record.workId, stretch: draftedBy.n, kind: 'context', before: record.beforeHead, after: record.commit });
          if (!work.ledger.events().some((event) => event.type === 'git' && stableJson(work.ledger.data(event)) === stableJson(receipt))) work.ledger.append({ type: 'git', stretch: draftedBy.n, data: receipt });
        }
        await this.#done(work, workspace, { schema: 'manual-step-v1', generation: record.generation, action: 'done', ...(record.modelId ? { modelId: record.modelId } : {}), remember: false }, operation);
        if (work.load().conversation.work) throw new Error(work.load().pause?.reason ?? 'Context is checkpointed locally; publication has not completed.');
      } else {
        work.close('done');
        await this.hubWaits.retry(work, operation.abort.signal, 'checkout-release', () => this.ownership.release(project, workspace.owner, { processesGone: true, commits: 'unchanged' }), { owner: { workId: record.workId, generation: record.generation } });
      }
      record.status = 'completed'; delete record.reason; this.#saveContextOperation(record);
    } catch (error) {
      const workspace = cleanupWorkspace;
      if (record.applied && !record.commit && workspace?.project.branchPolicy === 'main' && work.load().conversation.work?.baseCommit && (error instanceof ExternalActivityError || record.appliedDigest && await workspace.workingTreeDigest() !== record.appliedDigest)) record.activityReason = `${error instanceof Error ? error.message : 'The applied files changed.'} Review the current changes before accepting a context checkpoint.`;
      record.status = 'blocked'; record.reason = record.activityReason ?? (error instanceof Error ? error.message : 'The context change could not finish.'); this.#saveContextOperation(record);
      if (workspace && !record.applied) {
        const cleanup = async () => {
          const claim = await this.ownership.current(workspace.project);
          if (claim?.workId === record.workId && claim.conversationId === work.ledger.id && (!claim.held || !record.beforeHead || await workspace.clean() && await workspace.head() === record.beforeHead && new ProjectContext(workspace.project, this.options.deviceId, () => undefined).inspect().fingerprint === record.request.fingerprint)) await this.ownership.release(workspace.project, workspace.owner, { processesGone: true, commits: 'unchanged' });
        };
        if (operation.abort.signal.aborted || this.#closed) await cleanup().catch(() => undefined);
        else await this.hubWaits.retry(work, operation.abort.signal, 'checkout-release', cleanup, { owner: { workId: record.workId, generation: record.generation } });
      }
      throw error;
    }
  }
  async memory(id: string) { return this.options.memory.project((await this.#project(id)), this.options.deviceId, () => { throw new Error('The memory viewer cannot change files.'); }); }
  async saveProject(raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = ProjectWriteSchema.parse(raw); const id = input.clientRequestId ?? newId('projectsave');
    if (this.options.redactor.text(JSON.stringify(input.project)) !== JSON.stringify(input.project)) throw new Error('Project settings cannot contain credentials.');
    const saves = new ProjectSaves(this.options.homes); let prepared = saves.get(id, input);
    if (!prepared) {
      const project = structuredClone(input.project); const previous = await this.options.projects.get(project.id);
      if (previous?.project.paths[this.options.deviceId] && (await this.ownership.current(previous.project))?.held) throw conflict('This project is in use. Finish its open work before changing its settings.');
      let context;
      if (project.paths[this.options.deviceId]) {
        const local = { ...project, allowedDevices: undefined }; resolveProjectPath(local, this.options.deviceId);
        context = new ProjectContext(local, this.options.deviceId, () => { throw new Error('Project inspection cannot change context files.'); }).inspect();
        project.context = { state: context.state, ...(context.primary ? { primary: context.primary } : {}) };
      }
      const configure = context?.state === 'none' && (!project.allowedDevices || project.allowedDevices.includes(this.options.deviceId)) && (context.primary || input.createContext);
      prepared = saves.prepare({ schema: 'project-save-v1', id, request: input, project,
        ...(configure ? { context: ContextRequestSchema.parse({ schema: 'context-request-v1', clientRequestId: `context_${createHash('sha256').update(id).digest('hex')}`, revision: input.revision + 1, fingerprint: context!.fingerprint, choice: context!.primary ? 'link' : 'create' }) } : {}),
      });
    }
    const saved = await this.options.projects.put(prepared.project, input.revision, id);
    if (prepared.context) {
      const existing = this.options.contexts.get(prepared.context.clientRequestId);
      const current = await this.options.projects.get(saved.project.id);
      // A replay can reconcile existing context work, but must not start work for settings superseded elsewhere.
      if (existing || current?.revision === saved.revision) await this.configureContext(saved.project.id, prepared.context);
    }
    const current = await this.options.projects.get(saved.project.id);
    if (!current) throw conflict('This project was removed after saving. Refresh the list.');
    return ProjectViewSchema.parse(current);
  }
  async create(raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = StartConversationSchema.parse(raw); const project = (await this.#project(input.projectId)); resolveProjectPath(project, this.options.deviceId);
    const settings = await this.options.settings();
    if (this.#closed) throw new Error('Conversations are closed.');
    const existing = this.#works.get(input.id);
    if (existing?.ledger.events().length) {
      const work = existing;
      const first = work.load().messages[0];
      if (work.load().conversation.projectId !== input.projectId || first?.clientMessageId !== input.clientMessageId || first.text !== work.ledger.redact(input.message)) throw conflict('This conversation id was already used for a different request.');
      const saved = work.ledger.events().flatMap((event) => { const value = StartComposerChoicesSchema.safeParse(work.ledger.data(event)); return value.success ? [value.data.choices] : []; })[0];
      if (stableJson(saved) !== stableJson(input.choices)) throw conflict('This conversation id was already used with different composer choices.');
      if (input.choices) this.#initialChoices(work, input.clientMessageId, input.choices, false);
      return (await this.view(input.id));
    }
    if (input.choices) {
      for (const modelId of [input.choices.once.modelId, input.choices.pins.modelId]) if (modelId && !settings.menu.some((model) => model.id === modelId)) throw conflict('Choose a model from the configuration.');
      if (input.choices.once.action && !allowedInitialActions(settings.guards, !!project.testCommand).includes(input.choices.once.action)) throw conflict('This next step is not allowed for the first decision.');
    }
    const work = this.#load(input.id, true);
    work.create({ title: input.title, projectId: project.id, ownerDeviceId: this.options.deviceId });
    if (input.choices) work.ledger.append({ type: 'notice', data: StartComposerChoicesSchema.parse({ schema: 'start-composer-choices-v1', choices: input.choices }) });
    work.message(input.message, input.clientMessageId, 'user-message', settings.guards.maxStretchesPerWork);
    if (input.choices) this.#initialChoices(work, input.clientMessageId, input.choices, true);
    if (project.branchPolicy === 'external') this.#notice(work, "This project follows its own git rules. Jevellan won't commit or push here.");
    this.#index(work); return this.#schedule(work, 'user-message');
  }
  async list() { await this.indexes.flush(); return ConversationListSchema.parse({ schema: 'conversations-list-v2', conversations: (await this.options.indexes.conversations()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }); }
  hasLocalConversation(id: string): boolean { return this.#works.has(IdSchema.parse(id)); }
  /** Summaries of this device's latest finished steps in one project, newest first, for improver judgments. */
  recentHandoffSummaries(projectId: string, limit = 10): string[] {
    IdSchema.parse(projectId);
    return [...this.#works.values()].flatMap((work) => {
      const view = work.load(); if (view.conversation.projectId !== projectId) return [];
      return view.handoffs.flatMap((handoff) => {
        const step = view.stretches.find((entry) => entry.n === handoff.stretch);
        return step?.endedAt && step.status !== 'undone' ? [{ at: step.endedAt, summary: handoff.summary }] : [];
      });
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map((entry) => entry.summary);
  }
  async ownerDevice(id: string): Promise<string> {
    await this.ready; IdSchema.parse(id);
    const local = this.#works.get(id); if (local) return local.load().conversation.ownerDeviceId;
    const entry = (await this.options.indexes.conversations()).find(conversation => conversation.id === id);
    if (!entry) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    return entry.ownerDeviceId;
  }
  async corrections(ids?: string[]) { await this.indexes.flush(); const records = await this.options.indexes.corrections(); return ids ? records.filter(record => ids.includes(record.id)) : records; }
  async rename(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = RenameConversationSchema.parse(raw); const work = this.#load(id);
    try { work.rename(input); } catch (error) { throw conflict(error instanceof Error ? error.message : 'The title could not be changed.'); }
    this.#index(work); return (await this.view(id));
  }
  #notFinishing(work: ConversationWork): void {
    if (work.load().finishes.some((entry) => entry.status !== 'completed')) throw conflict('Finish the pending outside outcome before continuing this conversation.');
  }
  async finishOutside(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = FinishOutsideSchema.parse(raw); const work = this.#load(id);
    if (this.#correcting.has(id) && !work.load().finishes.some((entry) => entry.request.clientRequestId === input.clientRequestId)) throw conflict('Wait for the current correction to settle.');
    let record;
    try { record = work.requestFinishOutside(input); } catch (error) { throw conflict(error instanceof Error ? error.message : 'The outside outcome could not be recorded.'); }
    if (record.status === 'completed' || this.#correcting.has(id)) return (await this.view(id));
    this.#correcting.add(id);
    try { await this.#finishOutside(work, input.clientRequestId); }
    finally { this.#correcting.delete(id); this.#index(work); }
    return (await this.view(id));
  }
  async #finishOutside(work: ConversationWork, requestId: string): Promise<void> {
    const id = work.ledger.id; const record = work.load().finishes.find((entry) => entry.request.clientRequestId === requestId)!;
    try {
      if (record.status === 'completed') return;
      record.status = 'requested'; delete record.reason; work.finishOutsideStatus(record);
      await this.#stop(work);
      const view = work.load(); const target = view.conversation.work ?? view.closedWorks.at(-1);
      const project = (await this.#project(view.conversation.projectId)); const claim = await this.ownership.current(project);
      if (claim?.held && claim.conversationId === id && claim.workId === target?.id) {
        const owner = { conversationId: id, conversationTitle: view.conversation.title, workId: target.id };
        const workspace = new GitWorkspace(project, this.options.deviceId, this.ownership, owner, this.options.redactor);
        const pendingUndo = redoOperations(work).some((entry) => [entry.workId, entry.followingWorkId].includes(target.id) && entry.plan && !this.#undoReceipt(work, entry.id));
        const blocked = checkpointBlocks(work).some((entry) => entry.workId === target.id);
        if (!pendingUndo && !blocked && (project.branchPolicy === 'external' || await workspace.clean() && (!target.baseCommit || await workspace.head() === target.baseCommit))) {
          await this.ownership.acquire(project, owner);
          await this.ownership.release(project, owner, { processesGone: true, commits: 'unchanged' });
        }
      }
      const remaining = await this.ownership.current(project);
      work.finishOutsideStatus({ ...record, workId: target?.id ?? null, status: 'completed', retained: remaining?.held === true && remaining.conversationId === id });
      this.#finishContext(work, 'cancelled');
    } catch (error) {
      if (work.load().finishes.find((entry) => entry.request.clientRequestId === requestId)?.status !== 'completed') work.finishOutsideStatus({ ...record, status: 'blocked', reason: error instanceof Error ? error.message : 'Process cleanup could not be confirmed.' });
    }
  }
  ledger(id: string): ConversationLedger { return this.#load(id).ledger; }
  async file(id: string, raw: unknown) {
    const input = ConversationFileRequestSchema.parse(raw); const work = this.#load(id); const view = work.load();
    const step = view.stretches.find((entry) => entry.n === input.stretch);
    if (!step) throw Object.assign(new Error('Step not found.'), { status: 404 });
    const project = (await this.#project(view.conversation.projectId));
    const receipts = work.ledger.events().filter((event) => event.type === 'git').flatMap((event) => { const entry = CheckpointReceiptSchema.safeParse(work.ledger.data(event)); return entry.success && entry.data.workId === step.workId && entry.data.stretch === step.n ? [entry.data] : []; });
    const commit = input.source === 'step' && project.branchPolicy === 'main' ? receipts.at(-1)?.after ?? step.gitAfter : undefined;
    return readProjectFile({ root: resolveProjectPath(project, this.options.deviceId), ref: input.ref, ...(commit ? { commit, ...(step.gitBefore ? { before: step.gitBefore } : {}) } : {}), redactor: this.options.redactor });
  }
  async changes(id: string, n: number) {
    const work = this.#load(id); const view = work.load(); const stretch = view.stretches.find((entry) => entry.n === n);
    if (!stretch) throw Object.assign(new Error('Step not found.'), { status: 404 });
    const workspace = new GitWorkspace((await this.#project(view.conversation.projectId)), this.options.deviceId, this.ownership, { conversationId: id, conversationTitle: view.conversation.title, workId: stretch.workId }, this.options.redactor);
    const receipts = work.ledger.events().filter((event) => event.type === 'git').flatMap((event) => { const receipt = CheckpointReceiptSchema.safeParse(work.ledger.data(event)); return receipt.success && receipt.data.workId === stretch.workId && receipt.data.stretch === n ? [receipt.data] : []; });
    const after = receipts.at(-1)?.after ?? stretch.gitAfter;
    let uncommitted = await workspace.uncommittedDiff(); let recovery;
    if (checkpointBlocks(work).some((entry) => entry.workId === stretch.workId && entry.stretch === n)) {
      try {
        const reviewed = await reviewCheckpoint(work, workspace, n); uncommitted = reviewed.diff;
        recovery = { schema: 'checkpoint-review-v1', generation: view.conversation.generation, fingerprint: reviewed.fingerprint, mode: workspace.project.branchPolicy === 'external' ? 'acknowledge' : 'checkpoint' };
      } catch (error) { recovery = { schema: 'checkpoint-review-v1', generation: view.conversation.generation, reason: error instanceof Error ? error.message : 'These changes cannot be accepted yet.' }; }
    }
    return ConversationChangesSchema.parse({ schema: 'conversation-changes-v1', stretch: n,
      diff: stretch.gitBefore && after ? await workspace.diff(stretch.gitBefore, after) : '', uncommitted, ...(recovery ? { recovery } : {}),
      files: [...(stretch.gitBefore && after ? (await workspace.changedFiles(stretch.gitBefore, after)).map((path) => ({ path, source: 'step' })) : []), ...(await workspace.changedFiles()).map((path) => ({ path, source: 'working-tree' }))],
      evidence: view.handoffs.find((entry) => entry.stretch === n)?.evidence ?? [], verifications: work.ledger.events().filter((event) => event.type === 'verification').map((event) => VerificationSchema.parse(work.ledger.data(event))).filter((entry) => entry.workId === stretch.workId) });
  }
  decisions(id: string): DecisionRecord[] {
    const ledger = this.#load(id).ledger; const decisions = new Map<string, DecisionRecord>();
    for (const event of ledger.events().filter((entry) => entry.type === 'decision')) { const decision = DecisionRecordSchema.parse(ledger.data(event)); decisions.set(decision.id, decision); }
    return [...decisions.values()];
  }
  async view(id: string) {
    const work = this.#load(id); const view = work.load();
    // Closed history has no next actions and needs no shared configuration.
    const allowed = view.conversation.work ? allowedActions(view.conversation.work, (await this.options.settings()).guards, !!(await this.#project(view.conversation.projectId)).testCommand, this.decisions(id).filter((decision) => decision.workId === view.conversation.work!.id).length) : [];
    return ConversationPublicSchema.parse({ schema: 'conversation-view-v1', ...view, progress: this.#operations.get(id)?.progress,
      stretches: view.stretches.map((step) => { const result = { ...step }; delete result.native; return result; }),
      ...(this.#decisionWait(work) ? { decisionWait: this.#decisionWait(work) } : {}),
      ...(this.#externalWait(work) ? { externalWait: this.#externalWait(work) } : {}),
      settlements: this.#settlements(work), overrides: overrides(work), composerOverrides: composerOverrides(work), redos: redoOperations(work), checkpointBlocks: checkpointBlocks(work), decisions: this.decisions(id), busy: this.#operations.has(id) || this.#correcting.has(id), allowed });
  }
  #settlements(work: ConversationWork) {
    const results = new Map<string, ReturnType<typeof WorkSettlementSchema.parse>>();
    for (const event of work.ledger.events().filter((entry) => ['ownership', 'conversation-control'].includes(entry.type))) {
      const data = work.ledger.data(event); const result = WorkSettlementSchema.safeParse(data);
      if (result.success) results.set(result.data.id, result.data);
      const finish = FinishOutsideOperationSchema.safeParse(data);
      if (finish.success && finish.data.status === 'completed' && finish.data.workId) results.set(finish.data.request.clientRequestId, WorkSettlementSchema.parse({ schema: 'work-settlement-v1', id: finish.data.request.clientRequestId, workId: finish.data.workId, choice: 'keep', status: 'completed', closedAs: 'closed-by-you', reclose: false, retained: finish.data.retained }));
    }
    return [...results.values()];
  }
  async message(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = ConversationMessageSchema.parse(raw); const settings = await this.options.settings();
    if (this.#closed) throw new Error('Conversations are closed.');
    const work = this.#load(id); this.#notFinishing(work);
    const before = work.load();
    if (!before.conversation.work && !before.messages.some((message) => message.clientMessageId === input.clientMessageId)) {
      const claim = await this.ownership.current((await this.#project(before.conversation.projectId)));
      if (this.#operations.has(id) || claim?.held && claim.conversationId === id) throw conflict('Settle this conversation’s kept changes before starting another request.');
    }
    this.#notFinishing(work);
    const result = work.message(input.text, input.clientMessageId, input.kind === 'note' ? 'note' : 'user-message', settings.guards.maxStretchesPerWork);
    if (!result.repeated && result.correction) { this.#notice(work, 'The user corrected this step.', 'steer'); await this.#operations.get(id)?.execution?.steer(); }
    if (!result.repeated) this.#operations.get(id)?.decisionAbort?.abort();
    if (!result.repeated && !this.#operations.has(id) && work.load().conversation.state !== 'running') return this.#schedule(work, 'user-message');
    this.#index(work); return (await this.view(id));
  }
  async approvePlan(id: string, raw: unknown) {
    await this.ready; const input = PlanApprovalSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work);
    if (this.#operations.has(id)) throw conflict('Wait for the current step to finish.');
    work.approvePlan(input.ref, input.generation); this.#index(work); return this.#schedule(work, 'resume');
  }
  #indexComposer(work: ConversationWork): void { for (const record of composerOverrides(work)) this.#queueIndex(work, record); }
  #initialChoices(work: ConversationWork, clientId: string, choices: ReturnType<typeof ComposerInitialSchema.parse>, fresh: boolean): void {
    for (const mode of ['pin', 'once'] as const) {
      const values = mode === 'pin' ? choices.pins : choices.once;
      for (const [key, value] of Object.entries(values)) {
        const field = key === 'modelId' ? 'model' : key;
        const clientRequestId = `initial_${createHash('sha256').update(`${clientId}/${mode}/${field}`).digest('hex')}`;
        if (composerOverrides(work).some((entry) => entry.request.clientRequestId === clientRequestId)) continue;
        if (!fresh) throw conflict('This initial composer choice was interrupted before the first decision. Open the conversation and set it again in the composer.');
        // Admission already validated these choices against one settings/project read.
        // Save them without hub reads before the first scheduling boundary.
        saveComposerChoice(work, { schema: 'composer-choice-v1', clientRequestId, generation: work.load().conversation.generation, field, mode, value });
      }
    }
    if (fresh) this.#indexComposer(work);
  }
  async #saveComposer(work: ConversationWork, raw: unknown): Promise<void> {
    const input = ComposerChoiceSchema.parse(raw); const view = work.load(); let previous = composerOverrides(work).find((entry) => entry.request.clientRequestId === input.clientRequestId);
    if (!previous) {
      if (view.conversation.generation !== input.generation) throw conflict('This composer choice is stale. Reload the conversation.');
      if (input.field === 'model' && input.value && !(await this.options.settings()).menu.some((model) => model.id === input.value)) throw conflict('Choose a model from the configuration.');
      const project = await this.#project(view.conversation.projectId);
      const allowed = view.conversation.work ? (await this.view(work.ledger.id)).allowed : ActionSchema.options.filter((action) => action !== 'integrate' && action !== 'done' && (action !== 'test' || project.testCommand));
      if (input.field === 'action' && input.value && !allowed.includes(input.value)) throw conflict('This next step is not allowed at the current boundary.');
      previous = composerOverrides(work).find((entry) => entry.request.clientRequestId === input.clientRequestId);
      if (!previous && work.load().conversation.generation !== input.generation) throw conflict('This composer choice is stale. Reload the conversation.');
    }
    const waiting = this.#decisionWait(work);
    try { saveComposerChoice(work, input); } catch (error) { throw conflict(error instanceof Error ? error.message : 'The composer choice could not be saved.'); }
    this.#indexComposer(work);
    if (!previous) {
      this.#operations.get(work.ledger.id)?.decisionAbort?.abort();
      if (waiting && view.conversation.state !== 'running') this.#waitDecision(work, { kind: waiting.kind, text: waiting.text, calls: waiting.calls, reasons: waiting.reasons });
    }
    this.#index(work);
  }
  async composerChoice(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const work = this.#load(id); this.#notFinishing(work);
    if (this.#correcting.has(id)) throw conflict('Wait for the current undo to settle before changing the next choice.');
    if (this.options.contexts.list().some((document) => document.conversationId === id && !document.applied && !['completed', 'cancelled'].includes(document.status))) throw conflict('Finish this context operation in Settings → Projects before setting the next choice.');
    (await this.#saveComposer(work, raw)); return (await this.view(id));
  }
  async manual(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const choice = ManualStepSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    if (this.options.contexts.list().some((document) => document.conversationId === id && !document.applied && !['completed', 'cancelled'].includes(document.status))) throw conflict('Review or cancel this context operation in Settings → Projects.');
    if (this.#correcting.has(id) || this.#operations.has(id) || view.conversation.state === 'running') throw conflict('A step is already running or settling.');
    if (!view.conversation.work || view.conversation.generation !== choice.generation) throw conflict('This choice is stale. Reload the conversation.');
    this.#checkpointAllowed(work, view.conversation.work.id);
    if (view.pause?.guard) throw conflict('This guard stopped the work. Reply with how to continue before choosing another step.');
    if (!(await this.view(id)).allowed.includes(choice.action)) throw new Error('This action is not allowed at this boundary.');
    const plan = view.conversation.work.latestPlanRef;
    if ((await this.options.settings()).guards.pauseAfterPlan && plan && view.conversation.work.approvedPlanRef !== plan && choice.action !== 'plan') throw new Error('Approve the current plan or choose Change the plan before continuing.');
    if (work.load().conversation.generation !== choice.generation) throw conflict('This choice is stale. Reload the conversation.');
    return this.#operate(work, async (operation) => {
      try { if (await this.#manual(work, choice, operation)) await this.#automatic(work, operation, 'stretch-end'); }
      catch (error) { if (error instanceof StaleDecision && !operation.cancelled) await this.#automatic(work, operation, 'user-message'); else throw error; }
    });
  }
  async resumeDecision(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = ResumeDecisionSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    if (this.#operations.has(id) || this.#correcting.has(id) || view.conversation.state === 'running') throw conflict('A step is already running or settling.');
    if (!view.conversation.work || view.conversation.generation !== input.generation || !this.#decisionWait(work)) throw conflict('This decision retry is stale. Reload the conversation.');
    this.#checkpointAllowed(work, view.conversation.work.id);
    if (view.pause?.guard) throw conflict('This guard stopped the work. Reply with how to continue.');
    if ((await this.options.settings()).guards.pauseAfterPlan && view.conversation.work.latestPlanRef && view.conversation.work.approvedPlanRef !== view.conversation.work.latestPlanRef) throw conflict('Approve the current plan before continuing.');
    if (work.load().conversation.generation !== input.generation) throw conflict('This decision retry is stale. Reload the conversation.');
    return this.#schedule(work, 'resume');
  }
  #externalWait(work: ConversationWork) {
    const current = work.load().conversation;
    for (const event of work.ledger.events().reverse()) {
      if (event.type === 'stretch-start') return undefined;
      if (event.type !== 'notice') continue;
      const wait = ExternalActivityWaitSchema.safeParse(work.ledger.data(event));
      if (wait.success) return wait.data.workId === current.work?.id && wait.data.generation === current.generation ? wait.data : undefined;
    }
    return undefined;
  }
  async retryExternalActivity(id: string, raw: unknown) {
    await this.ready; const input = RetryExternalActivitySchema.parse(raw); const work = this.#load(id); const wait = this.#externalWait(work);
    if (!wait || wait.id !== input.waitId || wait.generation !== input.generation) throw conflict('This activity retry is stale. Reload the conversation.');
    if (this.#operations.has(id) || this.#correcting.has(id)) throw conflict('A step is already running or settling.');
    this.#notFinishing(work); this.#checkpointAllowed(work, wait.workId);
    if (work.load().pause?.guard) throw conflict('This guard stopped the work. Reply with how to continue.');
    return wait.source === 'manual' ? this.manual(id, wait.choice) : this.#schedule(work, 'resume');
  }
  #decisionWait(work: ConversationWork): DecisionWait | undefined {
    const current = work.load().conversation;
    for (const event of work.ledger.events().filter((entry) => entry.type === 'notice').reverse()) {
      const parsed = DecisionWaitSchema.safeParse(work.ledger.data(event));
      if (parsed.success && parsed.data.workId === current.work?.id && parsed.data.generation === current.generation) return parsed.data;
    }
    return undefined;
  }
  #waitDecision(work: ConversationWork, value: Pick<DecisionWait, 'kind' | 'text'> & Partial<Pick<DecisionWait, 'calls' | 'reasons'>>): void {
    const current = work.load().conversation;
    work.ledger.append({ type: 'notice', data: DecisionWaitSchema.parse({ schema: 'decision-wait-v1', workId: current.work!.id, generation: current.generation, calls: [], ...value }) });
    work.pause(value.text);
  }
  async #schedule(work: ConversationWork, trigger: DecisionRecord['trigger']) {
    const generation = work.load().conversation.generation; let available: boolean | undefined;
    try { available = this.options.decisionClient ? await this.options.jevAvailable?.() : false; }
    catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
    if (this.#closed || !work.load().conversation.work || work.load().conversation.generation !== generation || this.#operations.has(work.ledger.id)) return this.view(work.ledger.id);
    if (!this.options.decisionClient) work.pause(MANUAL_NOTICE);
    else if (available === false) this.#waitDecision(work, { kind: 'jev-unavailable', text: manualFallback(new JevError('no-key')).text });
    else return this.#operate(work, (operation) => this.#automatic(work, operation, trigger));
    this.#index(work); return (await this.view(work.ledger.id));
  }
  #latestMessage(work: ConversationWork) {
    const view = work.load(); const target = view.conversation.work!;
    const ids = new Set([target.requestEventId, ...target.messageEventIds]);
    return view.messages.filter((message) => ids.has(String(message.id))).at(-1)!;
  }
  async #decisionState(work: ConversationWork, workspace: GitWorkspace, publicationConflict = false) {
    const view = work.load(); const target = view.conversation.work!; const settings = (await this.options.settings());
    const latest = this.#latestMessage(work); const head = await workspace.head(); const base = target.baseCommit ?? head;
    const changes = await workspace.changeFacts(base); const paths = await workspace.changedPaths(base, head);
    const memoryDir = workspace.project.memory.dir.replace(/\/$/, '') + '/';
    const active = new Set(view.stretches.filter((step) => step.workId === target.id && step.status !== 'undone').map((step) => step.n));
    const receipt = work.ledger.events().filter((event) => event.type === 'verification').map((event) => VerificationSchema.parse(work.ledger.data(event))).filter((entry) => entry.workId === target.id).at(-1);
    const current = settings.menu.find((model) => model.id === view.conversation.current?.modelId);
    const facts = { stretchesThisWork: target.counters.stretches, reviewsThisWork: target.counters.reviews, codeChangedThisWork: paths.some((path) => !path.startsWith(memoryDir)), changedFiles: paths.length,
      ...changes, lastVerification: receipt ? receipt.passed && receipt.headStable && (receipt.treeClean || receipt.worktreeBefore !== undefined && receipt.worktreeBefore === receipt.worktreeAfter) ? 'passed' as const : 'failed' as const : 'none' as const,
      publicationConflict, projectHasTestCommand: !!workspace.project.testCommand };
    return { ...buildDecisionState({ settings, projectId: workspace.project.id, corrections: await this.corrections(),
      request: target.request, latestUserMessage: latest.text, summary: view.summary, handoffs: view.handoffs.filter((handoff) => active.has(handoff.stretch)), facts, redactor: this.options.redactor,
      ...(current && view.conversation.current ? { current: { model: current, effort: view.conversation.current.effort } } : {}) }), latestMessageEventId: latest.id, facts };
  }
  async #choose(work: ConversationWork, workspace: GitWorkspace, operation: Operation, trigger: DecisionRecord['trigger'], forcedAction?: 'integrate'): Promise<PreparedDecision | undefined> {
    const generation = work.load().conversation.generation; const started = Date.now(); const config = (await this.options.settings()); this.#current(work, generation, operation);
    const calls: JevCall[] = []; const client = (await this.options.decisionClient!()); this.#current(work, generation, operation);
    operation.decisionAbort = new AbortController(); const signal = AbortSignal.any([operation.abort.signal, operation.decisionAbort.signal]);
    try {
      const packet = await this.#decisionState(work, workspace, !!forcedAction); this.#current(work, generation, operation);
      const view = work.load(); const latestDecision = this.decisions(work.ledger.id).filter((entry) => entry.workId === workspace.owner.workId).at(-1);
      const last = this.#lastHandoff(work);
      const allowed = (await this.view(work.ledger.id)).allowed; this.#current(work, generation, operation);
      if (!forcedAction && view.conversation.once.action && !allowed.includes(view.conversation.once.action)) {
        this.#waitDecision(work, { kind: 'choice-unavailable', text: 'The selected next step is no longer allowed. Change Next step in the composer, then try again.' }); return undefined;
      }
      this.#progress(work, 'deciding');
      const result = await decideNext(client, { model: config.decisions.model, state: packet.state, allowed,
        ...(!forcedAction && view.conversation.once.action ? { actionOverride: view.conversation.once.action } : {}), once: view.conversation.once,
        newMessage: packet.latestMessageEventId !== latestDecision?.latestMessageEventId, candidates: async (action) => {
          const accounts = await this.options.accounts.list();
          return modelCandidates({ settings: config, action, runtimes: new Map([...this.options.runtimes].map(([id, adapter]) => [id, adapter.capabilities])), accounts: accounts.map((entry) => entry.account), statuses: accounts.flatMap((entry) => entry.statuses), deviceId: this.options.deviceId });
        }, effortGuide: config.effortGuide, ...(view.conversation.current ? { currentId: view.conversation.current.modelId } : {}), pins: view.conversation.pins,
        keepCurrentThreshold: config.decisions.keepCurrentThreshold, deviceLabel: this.options.deviceLabel ?? this.options.deviceId,
        questionAvailable: !!(last?.question || last?.blockers.length), assertCurrent: () => this.#current(work, generation, operation), calls, ...(forcedAction ? { forcedAction } : {}) }, signal);
      this.#current(work, generation, operation);
      if (result.kind === 'waiting') { this.#waitDecision(work, { kind: 'no-eligible-model', text: result.message, reasons: result.reasons, calls }); return undefined; }
      const { remember, action, model, effort, account, notices } = result.selection; const jev = jevMetadata(calls);
      const record = DecisionRecordSchema.parse({ schema: 'decision-v2', id: newId('decision'), conversationId: work.ledger.id, workId: workspace.owner.workId,
        n: this.decisions(work.ledger.id).length + 1, generation, trigger, at: new Date().toISOString(), latencyMs: Date.now() - started,
        latestMessageEventId: packet.latestMessageEventId, questionSet: 'q-v2', remember, action, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(account ? { account } : {}), notices, ...(jev ? { jev } : {}), correctionsShown: packet.correctionsShown,
        context: { project: workspace.project.name, action: action.chosen, changeSize: packet.facts.changeSize, riskyAreasTouched: packet.facts.riskyAreasTouched }, device: { chosen: this.options.deviceId, source: 'here' } });
      return { record, state: packet.state, client, calls };
    } catch (error) {
      if (operation.cancelled || operation.abort.signal.aborted) return undefined;
      if (work.load().conversation.generation !== generation) throw new StaleDecision();
      if (!(error instanceof JevError)) throw error;
      if (error.kind === 'cancelled') throw error;
      this.#waitDecision(work, { kind: 'jev-unavailable', text: manualFallback(error).text, calls }); return undefined;
    }
  }
  async #automatic(work: ConversationWork, operation: Operation, initialTrigger: DecisionRecord['trigger']): Promise<void> {
    let trigger = initialTrigger; let checkGuard = trigger === 'stretch-end';
    while (work.load().conversation.work && !operation.cancelled && !this.#closed) {
      try {
        const prepared = await this.hubWaits.retry(work, operation.abort.signal, 'decision', async () => {
          const generation = work.load().conversation.generation;
          if (!this.options.decisionClient) { work.pause(MANUAL_NOTICE); return undefined; }
          const available = await this.options.jevAvailable?.(); this.#current(work, generation, operation);
          if (available === false) { this.#waitDecision(work, { kind: 'jev-unavailable', text: manualFallback(new JevError('no-key')).text }); return undefined; }
          const workspace = (await this.#workspace(work)); this.#current(work, generation, operation); this.#checkpointAllowed(work, workspace.owner.workId);
          if (checkGuard) { const settings = await this.options.settings(); this.#current(work, generation, operation); const stop = checkGuards(work.load().conversation.work!, settings.guards); if (stop) { work.pause(stop.notice, 'waiting-for-you', stop.kind); return undefined; } }
          return this.#choose(work, workspace, operation, trigger);
        });
        if (!prepared) return;
        this.#current(work, prepared.record.generation, operation);
        const action = prepared.record.action.chosen;
        if (action === 'integrate') throw new Error('Integration is only started by publication.');
        const choice = ManualStepSchema.parse({ schema: 'manual-step-v1', generation: prepared.record.generation, action, modelId: prepared.record.model?.chosen, effort: prepared.record.effort?.requested, remember: prepared.record.remember ?? false });
        if (!await this.#manual(work, choice, operation, 'manual', prepared)) return;
        trigger = 'stretch-end'; checkGuard = true;
      } catch (error) {
        if (error instanceof StaleDecision && !operation.cancelled) { trigger = 'steer'; continue; }
        throw error;
      } finally { delete operation.decisionAbort; }
    }
  }
  #progress(work: ConversationWork, phase: ReturnType<typeof ConversationProgressSchema.parse>['phase']): void {
    const operation = this.#operations.get(work.ledger.id); if (!operation || operation.cancelled || operation.progress?.phase === phase) return;
    operation.progress = ConversationProgressSchema.parse({ schema: 'conversation-progress-v1', phase, since: new Date().toISOString() });
    work.ledger.append({ type: 'notice', data: operation.progress });
  }
  async #operate(work: ConversationWork, run: (operation: Operation) => Promise<void>, options: Pick<Operation, 'cancellationCleanup'> = {}) {
    this.#notFinishing(work);
    const id = work.ledger.id;
    if (this.#closed) throw new Error('Conversations are closed.');
    if (this.#operations.has(id)) throw conflict('A step is already running or settling.');
    const release = this.options.enterOperation?.(id, work.load().conversation.title);
    const operation: Operation = { promise: Promise.resolve(), abort: new AbortController(), cancelled: false, ...options };
    this.#operations.set(id, operation);
    try { work.ledger.append({ type: 'notice', data: ConversationOperationSchema.parse({ schema: 'conversation-operation-v1', busy: true }) }); this.#progress(work, 'preparing'); }
    catch (error) { this.#operations.delete(id); release?.(); throw error; }
    operation.promise = Promise.resolve().then(() => run(operation)).catch((error: unknown) => {
      if (operation.shutdown) return; // Shutdown records its own restart notice once the operation has drained.
      const current = work.load(); this.#notice(work, error instanceof Error ? error.message : 'This step could not finish.', 'error');
      if (current.conversation.work && current.conversation.state !== 'running' && !operation.cancelled) work.pause(error instanceof Error ? error.message : 'This step could not finish.', 'blocked');
    }).finally(() => {
      try {
        this.#operations.delete(id); this.#index(work);
        work.ledger.append({ type: 'notice', data: ConversationOperationSchema.parse({ schema: 'conversation-operation-v1', busy: false }) });
      } finally { release?.(); }
    });
    return (await this.view(id));
  }
  #saveAdoption(work: ConversationWork, record: CheckpointAdoption): void {
    work.ledger.append({ type: 'git', stretch: record.request.stretch, data: CheckpointAdoptionSchema.parse(record) });
  }
  async #adoptionWorkspace(work: ConversationWork, record: CheckpointAdoption): Promise<GitWorkspace> {
    const conversation = work.load().conversation;
    return new GitWorkspace((await this.#project(conversation.projectId)), this.options.deviceId, this.ownership,
      { conversationId: conversation.id, conversationTitle: conversation.title, workId: record.request.workId }, this.options.redactor);
  }
  async #finishAdoption(work: ConversationWork, workspace: GitWorkspace, record: CheckpointAdoption): Promise<void> {
    const plan = record.plan; if (!plan || !await workspace.checkpointApplied(plan)) throw new Error('The prepared checkpoint is not the current checkout. Its original block remains.');
    const target = work.load().conversation.work ?? work.load().closedWorks.at(-1);
    if (!target || target.id !== record.request.workId) throw new Error('The work changed before its checkpoint could be recorded.');
    if (!target.baseCommit) {
      const closedAs = target.closedAs;
      if (closedAs) work.reopen(target.id);
      work.baseCommit(plan.before.head);
      if (closedAs) work.close(closedAs);
    }
    const exists = work.ledger.events().some((event) => {
      const receipt = event.type === 'git' && CheckpointReceiptSchema.safeParse(work.ledger.data(event));
      return receipt && receipt.success && receipt.data.adoptionId === record.request.clientRequestId;
    });
    if (!exists) work.ledger.append({ type: 'git', stretch: record.request.stretch, data: CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId: record.request.workId, stretch: record.request.stretch, kind: 'stretch', before: plan.before.head, after: plan.after, adoptionId: record.request.clientRequestId }) });
    new MemoryQueue(work).captureHandoff(record.request.stretch);
    const after = await workspace.snapshot();
    if (!after.clean && !checkpointBlocks(work).some((block) => block.before?.head === after.head && !record.blocks.includes(block.eventId))) {
      work.ledger.append({ type: 'git', stretch: record.request.stretch, data: CheckpointBlockSchema.parse({ schema: 'checkpoint-block-v1', workId: record.request.workId, stretch: record.request.stretch, before: after, reason: 'The checkout changed after the reviewed checkpoint. Open Changes and review the newer files before continuing.' }) });
    }
    record.status = 'completed'; delete record.reason; this.#saveAdoption(work, record);
    if (work.load().conversation.work?.id === target.id) {
      const block = checkpointBlocks(work).find((entry) => entry.workId === target.id);
      work.pause(block?.reason ?? MANUAL_NOTICE, block ? 'blocked' : 'waiting-for-you');
    }
  }
  async adoptChanges(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = AdoptChangesSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    const previous = checkpointAdoptions(work).find((entry) => entry.request.clientRequestId === input.clientRequestId);
    if (previous) {
      if (stableJson(previous.request) !== stableJson(input)) throw conflict('This acceptance id was already used for another review.');
      return (await this.view(id));
    }
    if (this.#operations.has(id) || this.#correcting.has(id) || view.conversation.state === 'running') throw conflict('Wait for the current step to finish before accepting its changes.');
    if (view.conversation.generation !== input.generation) throw conflict('This review is stale. Open Changes again.');
    if ((view.conversation.work ?? view.closedWorks.at(-1))?.id !== input.workId) throw conflict('This review belongs to another work.');
    const blocks = checkpointBlocks(work).filter((entry) => entry.workId === input.workId);
    if (!blocks.some((entry) => entry.stretch === input.stretch)) throw conflict('This step has no blocked changes to accept.');
    if (redoOperations(work).some((entry) => entry.workId === input.workId && entry.status === 'blocked' && (entry.needsReconciliation || entry.plan && !this.#undoReceipt(work, entry.id)))) throw conflict('Reconcile the interrupted undo before accepting files.');
    const record = CheckpointAdoptionSchema.parse({ schema: 'checkpoint-adoption-v1', request: input, blocks: blocks.map((entry) => entry.eventId), status: 'requested' });
    this.#saveAdoption(work, record);
    return this.#operate(work, async (operation) => {
      const workspace = (await this.#adoptionWorkspace(work, record)); const current = () => this.#current(work, input.generation, operation);
      try {
        current(); await this.ownership.acquire(workspace.project, workspace.owner); current();
        const reviewed = await reviewCheckpoint(work, workspace, input.stretch); current();
        if (reviewed.fingerprint !== input.fingerprint) throw new Error('The files or conversation changed since you reviewed them. Open Changes again before continuing.');
        if (workspace.project.branchPolicy === 'external') {
          new MemoryQueue(work).captureHandoff(input.stretch);
          record.mode = 'acknowledge'; record.status = 'completed'; this.#saveAdoption(work, record);
          if (work.load().conversation.work?.id === input.workId) work.pause(MANUAL_NOTICE, 'waiting-for-you');
        } else {
          record.plan = await workspace.planCheckpoint(input.clientRequestId, reviewed.before, reviewed.worktreeDigest, current);
          record.status = 'prepared'; this.#saveAdoption(work, record);
          await workspace.applyCheckpoint(record.plan, current); await this.#finishAdoption(work, workspace, record);
        }
      } catch (error) {
        record.status = 'blocked'; record.reason = error instanceof Error ? error.message : 'The reviewed changes could not be accepted.'; this.#saveAdoption(work, record); throw error;
      }
      await this.options.memory.project(workspace.project, this.options.deviceId, async () => { await this.ownership.assert(workspace.project, workspace.owner); await this.#outsideIdle(workspace); }).sync();
      if (work.load().conversation.work?.id === input.workId) { current(); await this.#applyMemory(work, workspace, operation); }
    });
  }
  async settle(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = SettleWorkSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    const previous = this.#settlements(work).find((entry) => entry.id === input.clientRequestId);
    if (previous) {
      if (previous.workId !== input.workId || previous.choice !== input.choice) throw conflict('This settlement id was already used for a different choice.');
      return (await this.view(id));
    }
    if (this.#correcting.has(id) || this.#operations.has(id) || view.conversation.state === 'running') throw conflict('Wait for the current step to finish before closing this work.');
    if (view.conversation.generation !== input.generation) throw conflict('This settlement choice is stale. Reload the conversation.');
    const target = view.conversation.work ?? view.closedWorks.at(-1);
    if (!target || target.id !== input.workId || target.closedAs === 'done') throw conflict('Choose the open work or the last cancelled or closed work.');
    if (view.conversation.work && !['waiting-for-you', 'blocked'].includes(view.conversation.state)) throw conflict('Work must be waiting or blocked before closing it.');
    const latest = this.#settlements(work).filter((entry) => entry.workId === target.id).at(-1);
    if (!view.conversation.work && latest?.status === 'completed' && !latest.retained) throw conflict('This work has already been settled.');
    const project = (await this.#project(view.conversation.projectId));
    if (project.branchPolicy === 'external' && input.choice !== 'keep') throw conflict('This project follows its own git rules. Close it keeping its changes.');
    const record = WorkSettlementSchema.parse({ schema: 'work-settlement-v1', id: input.clientRequestId, workId: target.id, choice: input.choice, status: 'requested', closedAs: target.closedAs ?? 'closed-by-you', reclose: !view.conversation.work });
    const intent = work.ledger.append({ type: 'ownership', data: record });
    return this.#operate(work, async (operation) => {
      const workspace = new GitWorkspace(project, this.options.deviceId, this.ownership, { conversationId: id, conversationTitle: view.conversation.title, workId: target.id }, this.options.redactor);
      let retained = false; let savedRef: string | undefined;
      const owner = { workId: target.id, generation: input.generation };
      const wait = <T>(run: () => Promise<T>) => this.hubWaits.retry(work, operation.abort.signal, 'settlement', async () => {
        this.#current(work, input.generation, operation); return run();
      }, { owner });
      try {
        await wait(async () => {
          const claim = await this.ownership.current(project);
          if (claim?.held && (claim.conversationId !== id || claim.workId !== target.id)) throw conflict('Another work owns this checkout. Its changes cannot be settled here.');
          if (claim?.held) await this.ownership.acquire(project, workspace.owner);
        });
        if (input.choice === 'publish') {
          if (!view.conversation.work) work.reopen(target.id);
          const generation = work.load().conversation.generation;
          await this.#done(work, workspace, { schema: 'manual-step-v1', action: 'done', generation, remember: false }, operation, record.closedAs);
          if (work.load().conversation.work) throw new Error(work.load().pause?.reason ?? 'Publication did not finish. The work remains unsettled.');
        } else {
          const before = await workspace.head(); record.before = before;
          work.ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse(record) });
          await wait(async () => {
            const clean = await workspace.clean();
            if (project.branchPolicy === 'main' && input.choice === 'discard') {
              await this.#outsideIdle(workspace); this.#current(work, input.generation, operation);
              if (!clean) throw new Error('Uncommitted changes cannot be discarded by this control. Inspect and checkpoint them first; checkout ownership stays held.');
              if (await workspace.head() !== before) throw new Error('The checkout changed while waiting to discard. Inspect its changes before continuing.');
              const expected = recordedCheckoutHead(work, target.id, this.options.contexts.list());
              let recovered = false;
              if (expected && before !== expected && target.baseCommit === before) {
                for (const pending of this.#settlements(work).filter(entry => entry.id !== record.id && entry.workId === target.id && entry.choice === 'discard' && entry.before === expected && entry.savedRef)) {
                  if (await workspace.discardApplied(target.baseCommit, expected, pending.savedRef!)) { recovered = true; break; }
                }
              }
              if (!recovered) await this.#recordedHead(work, workspace);
              if (target.baseCommit && before !== target.baseCommit) {
                await this.ownership.acquire(project, workspace.owner);
                savedRef = await workspace.discard(target.baseCommit, before, intent.id, async () => { await this.#outsideIdle(workspace); await this.#recordedHead(work, workspace); this.#current(work, input.generation, operation); }, (ref) => {
                  record.savedRef = ref; work.ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse(record) });
                }, record.savedRef);
              }
            }
            retained = project.branchPolicy === 'main' && input.choice === 'keep' && (!clean || !!target.baseCommit && await workspace.head() !== target.baseCommit);
            if (retained) await this.ownership.acquire(project, workspace.owner);
          });
          this.#current(work, input.generation, operation);
          if (work.load().conversation.work) work.close(record.closedAs);
          if (!retained) await this.hubWaits.retry(work, operation.abort.signal, 'checkout-release', async () => {
            const claim = await this.ownership.current(project);
            if (claim && claim.conversationId === id && claim.workId === target.id) await this.ownership.release(project, workspace.owner, { processesGone: true, commits: input.choice === 'discard' ? 'discarded' : 'unchanged' });
          }, { owner });
        }
        work.ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse({ ...record, status: 'completed', retained, ...(savedRef ? { savedRef } : {}) }) });
        if (!retained) this.#finishContext(work, input.choice === 'publish' ? 'completed' : 'cancelled');
        this.#notice(work, retained ? 'Work closed. Its changes are kept, and this checkout stays reserved for this conversation.' : input.choice === 'publish' ? 'Work closed and published.' : savedRef ? `Work discarded. Its checkpoints are saved at ${savedRef}.` : 'Work closed.');
      } catch (error) {
        work.ledger.append({ type: 'ownership', data: WorkSettlementSchema.parse({ ...record, status: 'blocked', ...(savedRef ? { savedRef } : {}), reason: error instanceof Error ? error.message : 'Settlement could not finish.' }) });
        throw error;
      } finally {
        const current = work.load().conversation;
        if (record.reclose && current.work?.id === target.id && current.state !== 'running') work.close(record.closedAs);
      }
    });
  }
  async correct(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = CorrectStepSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    const previous = overrides(work).find((entry) => entry.request.clientRequestId === input.clientRequestId);
    if (previous) {
      if (stableJson(previous.request) !== stableJson(input)) throw conflict('This correction id was already used for a different choice.');
      this.#queueIndex(work, previous); return (await this.view(id));
    }
    if (this.#correcting.has(id)) throw conflict('Another correction is being applied.');
    if (view.conversation.generation !== input.generation) throw conflict('This correction is stale. Reload the conversation.');
    const step = view.stretches.find((entry) => entry.n === input.stretch);
    if (!step || step.status === 'undone' || ![view.conversation.work?.id, view.closedWorks.at(-1)?.id].includes(step.workId)) throw conflict('Choose an active step of the open work or last closed work.');
    const decision = this.decisions(id).find((entry) => entry.id === step.decisionId);
    if (!decision) throw conflict('The original decision record is unavailable.');
    const action = input.choices.action ?? step.action;
    if (input.mode === 'redo' && action === 'integrate') throw conflict('Integration steps can run only during publication. Choose another action.');
    const modelId = input.choices.modelId ?? step.modelId;
    if (input.choices.modelId && !(await this.options.settings()).menu.some((model) => model.id === modelId)) throw new Error('Choose a model from the configuration.');
    const changes: ReturnType<typeof OverrideRecordSchema.parse>['changes'] = [];
    if (input.choices.action !== undefined && input.choices.action !== step.action) changes.push({ field: 'action', from: step.action, to: input.choices.action });
    if (input.choices.modelId !== undefined && input.choices.modelId !== step.modelId) changes.push({ field: 'model', from: step.modelId, to: input.choices.modelId });
    if (input.choices.effort !== undefined && input.choices.effort !== step.effortRequested) changes.push({ field: 'effort', from: step.effortRequested, to: input.choices.effort });
    if (!changes.length) throw new Error('Choose at least one different action, model or effort.');
    const correction = OverrideRecordSchema.parse({ schema: 'override-v1', id: newId('override'), request: input, conversationId: id, workId: step.workId, projectId: view.conversation.projectId,
      decisionId: decision.id, at: new Date().toISOString(), action: step.action, context: correctionContext(decision), changes });
    work.override(correction); this.#queueIndex(work, correction);
    this.#operations.get(id)?.decisionAbort?.abort();
    if (input.mode === 'noted') return (await this.view(id));
    const record = RedoOperationSchema.parse({ schema: 'redo-operation-v1', id: correction.id, workId: step.workId, status: 'requested', generation: work.load().conversation.generation, fromStretch: step.n,
      ...(view.conversation.work && view.conversation.work.id !== step.workId ? { followingWorkId: view.conversation.work.id } : {}) });
    const save = () => work.ledger.append({ type: 'git', data: RedoOperationSchema.parse(record) }); save();
    this.#correcting.add(id);
    try {
      const running = this.#operations.get(id);
      if (running) { running.cancelled = true; running.abort.abort(); await running.execution?.cancel(); await running.promise; }
      if (work.load().conversation.state === 'running') {
        const recovered = await recoverRunningWork(work); if (recovered.blocked.length) throw new Error(recovered.blocked[0]!.reason);
      }
      if (work.load().conversation.generation !== record.generation) throw conflict('The conversation changed while the step stopped. Undo has not run.');
      if (work.load().stretches.some((entry) => entry.status === 'running')) throw new Error('Process cleanup could not be confirmed. Undo has not run.');
      return this.#operate(work, (operation) => this.#redo(work, record, operation));
    } catch (error) { record.status = 'blocked'; record.reason = error instanceof Error ? error.message : 'The current step could not stop.'; save(); throw error; }
    finally { this.#correcting.delete(id); }
  }
  #undoReceipt(work: ConversationWork, id: string) {
    return work.ledger.events().filter((event) => event.type === 'undo').map((event) => UndoAppliedSchema.parse(work.ledger.data(event))).find((entry) => entry.id === id);
  }
  #wasRedone(work: ConversationWork, record: RedoOperation): boolean {
    const receipt = this.#undoReceipt(work, record.id); const view = work.load();
    return this.decisions(work.ledger.id).some((decision) => (decision.redoOf === record.id || !decision.redoOf && receipt && decision.trigger === 'redo' && decision.generation === receipt.generation + 1)
      && (view.stretches.some((step) => step.decisionId === decision.id) || decision.action.chosen === 'done' && view.closedWorks.some((entry) => entry.id === record.workId)));
  }
  #saveRedo(work: ConversationWork, record: RedoOperation): void { work.ledger.append({ type: 'git', data: RedoOperationSchema.parse(record) }); }
  async #redoWorkspace(work: ConversationWork, record: RedoOperation): Promise<GitWorkspace> {
    const conversation = work.load().conversation;
    return new GitWorkspace((await this.#project(conversation.projectId)), this.options.deviceId, this.ownership, { conversationId: conversation.id, conversationTitle: conversation.title, workId: record.workId }, this.options.redactor);
  }
  async #recoverUndo(work: ConversationWork, record: RedoOperation): Promise<void> {
    if (!record.result && record.plan && record.throughStretch) {
      const recovered = await (await this.#redoWorkspace(work, record)).inspectUndo(record.plan);
      if (recovered.result) { record.result = recovered.result; record.status = 'git-applied'; this.#saveRedo(work, record); }
    }
    if (record.result && record.throughStretch && !this.#undoReceipt(work, record.id)) {
      const view = work.load(); const closed = !view.conversation.work && view.closedWorks.at(-1);
      const intent = work.ledger.events().find((event) => event.type === 'override' && (work.ledger.data(event) as { id?: string }).id === record.id);
      const closedAfterIntent = closed && intent && work.ledger.events().some((event) => event.id > intent.id && (event.type === 'state' && (work.ledger.data(event) as { kind?: string }).kind === 'close' || event.type === 'conversation-control' && FinishOutsideOperationSchema.safeParse(work.ledger.data(event)).data?.status === 'completed'));
      work.undo({ schema: 'undo-applied-v1', id: record.id, workId: record.workId, fromStretch: record.fromStretch, throughStretch: record.throughStretch,
        ...(record.followingWorkId ? { followingWorkId: record.followingWorkId } : {}),
        generation: view.conversation.generation, mode: record.result.plan.mode, before: record.result.plan.before, after: record.result.after, savedRef: record.result.plan.savedRef,
        ...(closedAfterIntent ? { keepClosed: { as: closed.closedAs!, at: closed.closedAt! } } : {}) });
    }
  }
  async retryRedo(id: string, raw: unknown) {
    await this.ready; if (this.#closed) throw new Error('Conversations are closed.');
    const input = RetryRedoSchema.parse(raw); const work = this.#load(id); this.#notFinishing(work); const view = work.load();
    const records = redoOperations(work); const previous = records.flatMap((entry) => entry.retries).find((entry) => entry.clientRequestId === input.clientRequestId);
    if (previous) {
      if (stableJson(previous) !== stableJson(input)) throw conflict('This retry id was already used for another request.');
      return (await this.view(id));
    }
    if (this.#operations.has(id) || this.#correcting.has(id) || view.conversation.state === 'running') throw conflict('Wait for the current step to settle before retrying undo.');
    if (view.conversation.generation !== input.generation) throw conflict('This retry is stale. Reload the conversation.');
    const record = records.find((entry) => entry.id === input.id);
    if (!record || !overrides(work).some((entry) => entry.id === record.id && entry.request.mode === 'redo')) throw conflict('This undo request is unavailable.');
    if ((view.conversation.work ?? view.closedWorks.at(-1))?.id !== record.workId && !(view.conversation.work?.id === record.followingWorkId && view.closedWorks.at(-1)?.id === record.workId)) throw conflict('The open work no longer matches this correction.');
    if (record.status === 'completed') return (await this.view(id));
    record.retries.push(input); record.generation = input.generation; record.status = 'requested'; delete record.reason; this.#saveRedo(work, record);
    return this.#operate(work, (operation) => this.#redo(work, record, operation));
  }
  async #redo(work: ConversationWork, record: RedoOperation, operation: Operation): Promise<void> {
    let completionSaved = false;
    const wait = <T>(run: () => Promise<T>, generation = record.generation) => this.hubWaits.retry(work, operation.abort.signal, 'undo', async () => {
      this.#current(work, generation, operation); return run();
    }, { owner: { workId: record.workId, generation } });
    try {
      operation.redoId = record.id;
      const correction = overrides(work).find((entry) => entry.id === record.id)!;
      const input = correction.request; const initial = work.load(); const step = initial.stretches.find((entry) => entry.n === record.fromStretch)!;
      const workspace = await wait(() => this.#redoWorkspace(work, record)); const project = workspace.project;
      this.#current(work, record.generation, operation);
      if (this.#wasRedone(work, record)) { record.status = 'completed'; this.#saveRedo(work, record); this.#notice(work, 'This correction already started its redo step. It has not been run again.'); return; }
      await wait(async () => {
        this.#checkpointAllowed(work, record.workId, record.id);
        if (record.followingWorkId) {
          this.#checkpointAllowed(work, record.followingWorkId, record.id);
          const claim = await this.ownership.current(project);
          if (claim?.held) {
            const followingOwner = { ...workspace.owner, workId: record.followingWorkId };
            if (project.branchPolicy === 'main' && claim.workId === record.followingWorkId && claim.conversationId === workspace.owner.conversationId) await recoverIntegrationHistory(new GitWorkspace(project, this.options.deviceId, this.ownership, followingOwner, this.options.redactor), work.ledger, this.options.homes);
            await this.ownership.transfer(project, followingOwner, workspace.owner, !work.load().stretches.some((entry) => entry.status === 'running'));
          } else await this.ownership.acquire(project, workspace.owner);
        } else await this.ownership.acquire(project, workspace.owner);
      });
      this.#current(work, record.generation, operation);
      const applied = this.#undoReceipt(work, record.id);
      if (!applied) {
        const last = initial.stretches.filter((entry) => [record.workId, record.followingWorkId].includes(entry.workId) && entry.status !== 'undone').at(-1)?.n;
        if (!last || record.throughStretch && record.throughStretch !== last) throw conflict('Work continued after this undo was requested. Inspect the newer steps before making another correction.');
        record.throughStretch = last;
        if (project.branchPolicy === 'main' && !record.result) {
          await wait(async () => {
            await this.#outsideIdle(workspace); this.#current(work, record.generation, operation);
            await recoverIntegrationHistory(workspace, work.ledger, this.options.homes);
          });
          if (record.plan) {
            const recovered = await workspace.inspectUndo(record.plan);
            if (recovered.status === 'blocked') throw new Error(recovered.reason);
            if (recovered.result) record.result = recovered.result;
          }
          if (!record.result) {
            const range = record.plan ? { target: record.plan.target, sourceTip: record.plan.sourceTip, published: record.plan.mode === 'revert', ...(record.plan.ranges ? { ranges: record.plan.ranges } : {}) } : undoRange(work, step.n, record.followingWorkId);
            record.plan = await wait(async () => { await this.#outsideIdle(workspace); this.#current(work, record.generation, operation); return workspace.planUndo({ ...range, step: step.n }); });
            record.status = 'prepared'; this.#saveRedo(work, record);
            const plan = record.plan;
            record.result = await wait(() => workspace.applyUndo(plan, async () => { await this.#outsideIdle(workspace); this.#current(work, record.generation, operation); }, () => this.#saveRedo(work, record)));
          }
          record.status = 'git-applied'; this.#saveRedo(work, record);
        }
        const generation = work.load().conversation.generation;
        work.undo({ schema: 'undo-applied-v1', id: record.id, workId: record.workId, fromStretch: step.n, throughStretch: record.throughStretch, generation,
          ...(record.followingWorkId ? { followingWorkId: record.followingWorkId } : {}),
          mode: record.result?.plan.mode ?? 'external', ...(record.result ? { before: record.result.plan.before, after: record.result.after, savedRef: record.result.plan.savedRef } : {}) });
        record.status = 'applied'; this.#saveRedo(work, record);
        if (generation !== record.generation) throw conflict('Undo finished, but a newer message arrived. Retry using the updated conversation.');
      } else if (initial.stretches.some((entry) => entry.workId === record.workId && entry.n > applied.throughStretch && entry.status !== 'undone')) throw conflict('Work already continued after this undo. Correct its latest step instead.');
      if (!work.load().conversation.work) work.reopen(record.workId);
      const generation = work.load().conversation.generation;
      this.#current(work, generation, operation);
      if (project.branchPolicy === 'main') {
        if (!await workspace.clean()) throw new Error('Undo is recorded, but uncommitted changes remain. Inspect them before retrying the next step.');
        let expected = record.result?.after; const receiptId = work.ledger.events().find((event) => event.type === 'undo' && UndoAppliedSchema.parse(work.ledger.data(event)).id === record.id)?.id ?? 0;
        for (const event of work.ledger.events().filter((entry) => entry.id > receiptId && ['publication', 'git'].includes(entry.type))) {
          const publication = PublicationEventSchema.safeParse(work.ledger.data(event)); const checkpoint = CheckpointReceiptSchema.safeParse(work.ledger.data(event));
          if (publication.success && publication.data.workId === record.workId) expected = publication.data.commit;
          if (checkpoint.success && checkpoint.data.workId === record.workId) expected = checkpoint.data.after;
        }
        record.needsReconciliation = !!expected && await workspace.head() !== expected;
        if (record.needsReconciliation) throw new Error('The checkout changed after undo. Its newer commits are preserved; reconcile them before retrying this correction.');
        await this.options.memory.project(project, this.options.deviceId, async () => { await this.ownership.assert(project, workspace.owner); await this.#outsideIdle(workspace); }).sync();
      }
      this.#current(work, generation, operation);
      const action = input.choices.action ?? step.action; const modelId = input.choices.modelId ?? step.modelId;
      const choice = { schema: 'manual-step-v1' as const, generation, action: action === 'integrate' ? 'implement' as const : action, modelId, effort: input.choices.effort ?? step.effortRequested, remember: action === 'reply' && this.decisions(work.ledger.id).find((entry) => entry.id === step.decisionId)?.remember === true };
      if (record.plan?.mode === 'revert') {
        const publication = await this.#publish(work, workspace, operation, { assertHistory: () => this.#recordedHead(work, workspace), signal: operation.abort.signal, baseCommit: record.plan.before,
          nextStretch: () => work.load().conversation.stretchCount + 1, assertCurrent: async () => { this.#checkpointAllowed(work, record.workId, record.id); await this.#outsideIdle(workspace); this.#current(work, generation, operation); }, integrate: async ({ run }) => {
            // An integration is preparation for redo, not the requested redo itself.
            delete operation.redoId; try { await this.#stretch(work, workspace, choice, operation, 'integrate', 'manual', run); }
            finally { operation.redoId = record.id; }
            await this.#applyMemory(work, workspace, operation); return this.#lastHandoff(work)?.status === 'done';
          } });
        if (publication.status !== 'published') throw new Error(publication.notice ?? 'Undo is local; its revert commits have not been published.');
        await this.options.memory.project(project, this.options.deviceId, async () => { await this.ownership.assert(project, workspace.owner); await this.#outsideIdle(workspace); }).sync();
      }
      if (action === 'integrate' || !(await wait(() => this.view(work.ledger.id), generation)).allowed.includes(action)) throw new Error('Undo finished. A guard prevents the requested action; reply with how to continue.');
      this.#current(work, generation, operation); const carryOn = await this.#manual(work, choice, operation, 'redo');
      record.status = 'completed'; this.#saveRedo(work, record); completionSaved = true;
      delete operation.redoId;
      if (carryOn) await this.#automatic(work, operation, 'stretch-end');
    } catch (error) { if (!completionSaved) { record.status = 'blocked'; record.reason = error instanceof Error ? error.message : 'Undo and redo could not finish.'; this.#saveRedo(work, record); } throw error; }
  }
  async wait(id: string): Promise<void> { await this.#operations.get(id)?.promise; await this.indexes.flush(); }
  localRunning(): string[] { return [...this.#works].filter(([, work]) => work.load().conversation.state === 'running').map(([id]) => id); }
  async checkExternalActivity(): Promise<void> { await Promise.all([...this.#operations.values()].map(operation => operation.outside?.check())); }
  async #workspace(work: ConversationWork): Promise<GitWorkspace> {
    const conversation = work.load().conversation;
    if (!conversation.work) throw new Error('There is no open work.');
    return new GitWorkspace((await this.#project(conversation.projectId)), this.options.deviceId, this.ownership, { conversationId: conversation.id, conversationTitle: conversation.title, workId: conversation.work.id }, this.options.redactor);
  }
  #current(work: ConversationWork, generation: number, operation: Operation): void {
    if (this.#closed || operation.cancelled || operation.abort.signal.aborted || work.load().conversation.generation !== generation) throw new StaleDecision();
  }
  async #admit(work: ConversationWork, workspace: GitWorkspace): Promise<void> {
    this.#checkpointAllowed(work, workspace.owner.workId);
    await this.#outsideIdle(workspace);
    await this.ownership.acquire(workspace.project, workspace.owner);
    if (!work.load().conversation.work!.baseCommit) work.baseCommit(await workspace.prepare());
    await this.#recordedHead(work, workspace);
  }
  async #recordedHead(work: ConversationWork, workspace: GitWorkspace): Promise<void> {
    if (workspace.project.branchPolicy !== 'main') return;
    const expected = recordedCheckoutHead(work, workspace.owner.workId, this.options.contexts.list());
    if (expected && await workspace.head() !== expected) throw new CheckoutHistoryError(`Git history changed outside this work. Jevellan expected checkpoint ${expected.slice(0, 12)} and left the checkout untouched. Reconcile those changes or finish this work outside Jevellan before continuing.`);
  }
  async #outsideIdle(workspace: GitWorkspace) { await this.outside.assertIdle(workspace.project, workspace.path, (await this.options.settings()).guards.externalActivityWindowMin); }
  #checkpointAllowed(work: ConversationWork, workId: string, redoId?: string): void {
    const context = this.options.contexts.list().find(entry => entry.workId === workId && entry.activityReason && !entry.commit);
    if (context) throw conflict('Review the outside changes in Settings → Projects → Context before continuing this work.');
    const unresolved = redoOperations(work).find((entry) => entry.id !== redoId && [entry.workId, entry.followingWorkId].includes(workId) && entry.status === 'blocked' && (entry.needsReconciliation || entry.plan && !this.#undoReceipt(work, entry.id)));
    if (unresolved) throw conflict('An interrupted undo needs reconciliation before this checkout can change again. Inspect its saved recovery ref.');
    const block = checkpointBlocks(work).find((entry) => entry.workId === workId);
    if (block) throw conflict(`Automatic checkpointing and publication are blocked until these changes are settled: ${block.reason}`);
  }
  #record(work: ConversationWork, decision: DecisionRecord): void {
    const previous = this.decisions(work.ledger.id).find((entry) => entry.id === decision.id);
    const composer = previous ? previous.composer : planComposerBindings(work, decision);
    const value = DecisionRecordSchema.parse({ ...decision, ...(composer ? { composer } : {}) }); work.ledger.append({ type: 'decision', data: value });
    bindComposerChoices(work, value); this.#indexComposer(work);
    this.#materialiseDecision(work, value);
  }
  #materialiseDecision(work: ConversationWork, value: DecisionRecord): void {
    work.ledger.writeProjection(`decisions/${String(value.n).padStart(4, '0')}.json`, DecisionRecordSchema, value);
    this.#queueIndex(work, decisionIndex(value));
  }
  async #boundaryDecision(work: ConversationWork, choice: ManualStep, source: 'manual' | 'redo', redoOf?: string, prepared?: PreparedDecision): Promise<void> {
    if (prepared) { this.#record(work, prepared.record); return; }
    const allowed = (await this.view(work.ledger.id)).allowed;
    const view = work.load();
    if (this.#closed || !view.conversation.work || view.conversation.generation !== choice.generation) throw new StaleDecision();
    const waiting = this.#decisionWait(work); const jev = jevMetadata(waiting?.calls ?? []);
    this.#record(work, DecisionRecordSchema.parse({ schema: 'decision-v2', id: newId('decision'), conversationId: work.ledger.id,
      workId: view.conversation.work!.id, n: this.decisions(work.ledger.id).length + 1, generation: choice.generation, ...(redoOf ? { redoOf } : {}), trigger: source === 'redo' ? 'redo' : 'resume', at: new Date().toISOString(), latencyMs: 0,
      latestMessageEventId: this.#latestMessage(work).id, remember: choice.remember, ...(jev ? { jev } : {}),
      action: { chosen: choice.action, source, allowed }, correctionsShown: [], notices: waiting?.kind === 'jev-unavailable' ? [{ kind: waiting.kind, text: waiting.text }] : [] }));
  }
  #lastHandoff(work: ConversationWork) {
    const view = work.load(); const step = view.stretches.filter((entry) => entry.workId === view.conversation.work?.id && entry.status !== 'undone').at(-1);
    return view.handoffs.find((entry) => entry.stretch === step?.n);
  }
  async #manual(work: ConversationWork, choice: ManualStep, operation: Operation, source: 'manual' | 'redo' = 'manual', prepared?: PreparedDecision): Promise<boolean> {
    const before = work.load().conversation.stretchCount;
    try { return await this.hubWaits.retry(work, operation.abort.signal, 'launch', () => this.#manualStep(work, choice, operation, source, prepared), {
      shouldRetry: () => choice.action !== 'done' && work.load().conversation.stretchCount === before,
      beforeRetry: () => { this.#current(work, choice.generation, operation); if (prepared) throw new StaleDecision(); },
    }); }
    catch (error) {
      const current = work.load().conversation;
      if (error instanceof ExternalActivityError && source !== 'redo' && current.work && current.generation === choice.generation && current.stretchCount === before) {
        work.ledger.append({ type: 'notice', data: ExternalActivityWaitSchema.parse({ schema: 'external-activity-wait-v1', id: newId('wait'), workId: current.work.id, generation: current.generation, choice, source: prepared ? 'automatic' : 'manual' }) });
      }
      throw error;
    }
  }
  async #manualStep(work: ConversationWork, choice: ManualStep, operation: Operation, source: 'manual' | 'redo' = 'manual', prepared?: PreparedDecision): Promise<boolean> {
    this.#progress(work, 'preparing');
    const workspace = await this.hubWaits.retry(work, operation.abort.signal, 'launch', () => this.#workspace(work), {
      beforeRetry: () => { this.#current(work, choice.generation, operation); if (prepared) throw new StaleDecision(); },
    }); this.#current(work, choice.generation, operation);
    if (choice.action === 'done') {
      await this.hubWaits.retry(work, operation.abort.signal, 'decision', () => this.#boundaryDecision(work, choice, source, operation.redoId, prepared));
      return await this.#done(work, workspace, choice, operation) === 'retry' && !!this.options.decisionClient && await this.hubWaits.retry(work, operation.abort.signal, 'decision', () => Promise.resolve(this.options.jevAvailable?.())) !== false;
    }
    const last = this.#lastHandoff(work);
    if (choice.action === 'ask-you' && (last?.question || last?.blockers.length)) {
      (await this.#boundaryDecision(work, choice, source, operation.redoId, prepared));
      const question = last.question ?? last.blockers.join('\n'); this.#notice(work, question); work.pause(question); return false;
    }
    await this.#stretch(work, workspace, choice, operation, choice.action === 'ask-you' ? 'reply' : choice.action, source, undefined, prepared);
    if (operation.cancelled || operation.shutdown) return false;
    await this.#applyMemory(work, workspace, operation);
    const generation = work.load().conversation.generation;
    const settings = await this.hubWaits.retry(work, operation.abort.signal, 'settings', () => Promise.resolve(this.options.settings())); this.#current(work, generation, operation);
    const view = work.load(); if (!view.conversation.work) return false;
    const stop = checkGuards(view.conversation.work, settings.guards);
    if (stop) work.pause(stop.notice, 'waiting-for-you', stop.kind);
    else if (!prepared && this.#lastHandoff(work)?.status === 'blocked') work.pause(this.#lastHandoff(work)!.blockers.join('\n') || this.#lastHandoff(work)!.summary, 'blocked');
    else if (choice.action === 'ask-you') { const answer = view.handoffs.at(-1)!; work.pause(answer.question ?? answer.summary); }
    else if (settings.guards.pauseAfterPlan && view.conversation.work.latestPlanRef && view.conversation.work.approvedPlanRef !== view.conversation.work.latestPlanRef) work.pause('Read the full plan, then choose Go ahead or Change the plan.');
    else return true;
    return false;
  }
  async #stretch(work: ConversationWork, workspace: GitWorkspace, choice: ManualStep, operation: Operation, action: Action, source: 'manual' | 'redo' = 'manual', integration?: IntegrationRunner, prepared?: PreparedDecision): Promise<void> {
    const generation = choice.generation; const config = await this.options.settings(); this.#current(work, generation, operation);
    const modelId = choice.modelId ?? work.load().conversation.current?.modelId; const model = config.menu.find((entry) => entry.id === modelId);
    if (!model?.enabled || !config.runtimes[model.runtime]?.enabled) throw new Error('Choose an enabled model for this step.');
    const adapter = this.options.runtimes.get(model.runtime); const permissions = actionPermissions(action);
    if (!adapter || !adapter.capabilities.mcp || (permissions === 'read-only' ? !adapter.capabilities.readOnlyEnforced : !adapter.capabilities.edit || !adapter.capabilities.shell)) throw new Error('This runtime cannot enforce the capabilities required by this action.');
    const accounts = await this.options.accounts.list(); const ranking = rankAccounts({ accounts: accounts.map((entry) => entry.account), statuses: accounts.flatMap((entry) => entry.statuses), runtime: model.runtime, model: model.model, deviceId: this.options.deviceId });
    this.#current(work, generation, operation);
    const selected = ranking.find((entry) => entry.eligible); if (!selected) throw new Error(`No model can run this step right now: ${ranking.filter((entry) => entry.account.runtime === model.runtime).map((entry) => entry.reason).join(', ') || 'no account'}.`);
    const serial = !adapter.capabilities.perLaunchConfig;
    if (serial && this.#accountRuns.has(selected.account.id)) throw conflict('This account is running another step and its runtime cannot isolate concurrent launches.');
    if (serial) this.#accountRuns.add(selected.account.id);
    try {
      const account = await this.options.accounts.resolve(selected.account.id); this.#current(work, generation, operation);
      const rigging = await this.options.riggingItems(model.runtime); this.#current(work, generation, operation);
      const delivered = await adapter.materialiseRigging(account.home, rigging); this.#current(work, generation, operation);
      if (adapter.riggingKinds.includes('hook') && rigging.some((item) => item.id === PROJECT_MEMORY_ID && item.enabled && item.state !== 'parked') && !delivered.some((item) => item.itemId === PROJECT_MEMORY_ID && item.applied)) throw new Error('Project memory hooks could not be delivered to this account.');
      const memoryWrite = permissions === 'write' || (action === 'reply' && choice.remember);
      if (memoryWrite) await this.#admit(work, workspace);
      const memory = this.options.memory.project(workspace.project, this.options.deviceId, async () => { await this.ownership.assert(workspace.project, workspace.owner); await this.#outsideIdle(workspace); });
      const context = new ProjectContext(workspace.project, this.options.deviceId, async () => { await this.ownership.assert(workspace.project, workspace.owner); await this.#outsideIdle(workspace); });
      const contextDraft = this.options.contexts.list().some(record => record.conversationId === work.ledger.id && record.workId === work.load().conversation.work?.id && record.request.choice === 'merge' && !record.applied);
      let state = context.inspect();
      if (!contextDraft && state.primary && state.state === 'none') {
        if (state.files.some((file) => file.kind === 'missing' && file.tracked)) throw new Error('Restore the missing tracked instruction file before continuing.');
        await this.ownership.acquire(workspace.project, workspace.owner); state = await context.ensure();
      }
      // A merge draft must preserve the revision its eventual Apply will compare.
      // The context operation records the resulting shared context only after Apply.
      if (!contextDraft) {
        const projectRow = (await this.options.projects.get(workspace.project.id))!;
        const observedContext = { state: state.state, ...(state.primary ? { primary: state.primary } : {}) };
        if (stableJson(projectRow.project.context) !== stableJson(observedContext)) await this.options.projects.context(workspace.project.id, observedContext, projectRow.revision);
      }
      if (memoryWrite) await memory.sync();
      this.#current(work, generation, operation);
      const view = work.load(); const latestMessage = this.#latestMessage(work);
      const notes = await searchMemoryCandidates(memory, { request: view.conversation.work!.request, latestMessage: latestMessage.text, action }, operation.abort.signal);
      const calls = prepared?.calls ?? [...(this.#decisionWait(work)?.calls ?? [])]; const memoryStarted = Date.now();
      let packet = prepared?.state;
      if (!packet && this.options.decisionClient && (await this.options.jevAvailable?.()) !== false) {
        try { packet = (await this.#decisionState(work, workspace, action === 'integrate')).state; }
        catch (error) { if (!(error instanceof JevError)) throw error; }
      }
      const client = prepared?.client ?? (packet ? (await this.options.decisionClient?.()) : undefined);
      this.#progress(work, 'memory');
      const recalled = await selectMemory(client ?? { decide: async () => { throw new JevError('no-key'); } }, { notes, action, state: packet ?? '{}', model: config.decisions.model }, operation.decisionAbort ? AbortSignal.any([operation.abort.signal, operation.decisionAbort.signal]) : operation.abort.signal);
      this.#current(work, generation, operation); const recall = recalled.selection;
      if (recalled.response) calls.push(JevCallSchema.parse({ schema: 'jev-call-v1', kind: 'memory', requestedModel: config.decisions.model, returnedModel: recalled.response.model, usage: recalled.response.usage, latencyMs: Date.now() - memoryStarted }));
      const effort = choice.effort ?? view.conversation.current?.effort ?? 'high'; const effective = mapEffort(effort, model.efforts);
      const before = await workspace.snapshot(); const digest = await workspace.workingTreeDigest();
      const facts = await workspace.changeFacts(view.conversation.work!.baseCommit ?? before.head);
      const waiting = this.#decisionWait(work);
      const jev = jevMetadata(calls);
      const decision = DecisionRecordSchema.parse({ schema: 'decision-v2', id: newId('decision'), conversationId: work.ledger.id, workId: workspace.owner.workId, n: this.decisions(work.ledger.id).length + 1, generation, ...(operation.redoId ? { redoOf: operation.redoId } : {}), trigger: source === 'redo' ? 'redo' : 'resume', at: new Date().toISOString(), latencyMs: 0,
        action: { chosen: action === 'integrate' ? action : choice.action, source: action === 'integrate' ? 'guard' : source, allowed: action === 'integrate' ? ['integrate'] : (await this.view(work.ledger.id)).allowed, ...(action === 'integrate' ? { guardReason: 'Resolve the publication conflict before verifying and publishing.' } : {}) }, model: { chosen: model.id, source, eligible: [{ modelId: model.id }], excluded: [] },
        effort: { requested: effort, effective, source },
        context: { project: workspace.project.name, action, ...facts }, device: { chosen: this.options.deviceId, source: 'here' }, correctionsShown: [],
        notices: [...(effective === effort ? [] : [{ kind: 'effort-adjusted', text: 'nearest effort this model supports' }]), ...(waiting?.kind === 'jev-unavailable' ? [{ kind: waiting.kind, text: waiting.text }] : [])],
        ...prepared?.record, latestMessageEventId: latestMessage.id, remember: choice.remember, ...(jev ? { jev } : {}),
        account: { chosen: selected.account.id, ranking: ranking.map((entry) => ({ accountId: entry.account.id, eligible: entry.eligible, reason: entry.reason })) },
        memory: { candidates: recall.candidates, chosen: recall.chosen, source: recall.source, ...(recall.scores ? { scores: recall.scores } : {}) } });
      // Read-only reviewers have no shell, so the change they must review is computed here with read-only Git.
      const change = action === 'review' || action === 'adversarial-review' ? await changeUnderReview(workspace, view.conversation.work!.baseCommit) : undefined;
      const brief = buildBrief(view, work.ledger, { action, project: workspace.project, cwd: workspace.path, memoryWrite, memory: recall.excerpts, ...(change ? { change } : {}) });
      await this.options.accounts.markUsed(selected.account.id);
      if (memoryWrite) {
        await this.outside.assertIdle(workspace.project, workspace.path, config.guards.externalActivityWindowMin);
        if (action !== 'integrate') await this.#recordedHead(work, workspace);
        if (workspace.project.branchPolicy === 'main' && action !== 'integrate' && !await workspace.clean()) throw new Error('This checkout has uncommitted changes before the writing step. Settle those files before retrying; Jevellan has not started the step.');
      }
      this.#current(work, generation, operation); this.#record(work, decision);
      this.#progress(work, 'starting');
      const n = view.conversation.stretchCount + 1;
      work.start(StretchSchema.parse({ schema: 'stretch-v2', n, workId: workspace.owner.workId, action, modelId: model.id, runtime: model.runtime, model: model.model, effortRequested: effort, effortEffective: effective, accountId: selected.account.id, deviceId: this.options.deviceId, decisionId: decision.id, startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' }, gitBefore: before.head }), generation);
      delete operation.decisionAbort;
      const grant = this.options.bridges.issue({ work, stretch: n, memoryWrite, memory, ...(integration ? { integration } : {}), memoryCapture: () => {
        return rigging.some(item => item.id === PROJECT_MEMORY_ID && item.enabled && item.state === 'owned');
      } });
      const launchEnv = { JEVELLAN_STRETCH_TOKEN: grant.token, JEVELLAN_DAEMON_URL: this.daemonUrl };
      const input: StretchInput = { schema: 'stretch-input-v1', conversationId: work.ledger.id, stretch: n, action, cwd: workspace.path, permissions, memoryWrite, account,
        model: model.model, effort: effective, systemAppend: actionContract(action) + (choice.action === 'ask-you' ? '\nWrite the one question needed to unblock this work, and include it in the handoff question field.' : ''), brief: brief.text,
        timeoutMs: config.guards.stretchTimeoutMin * 60_000, launch: { env: launchEnv, mcpServers: { jevellan: { command: process.execPath, args: [join(applicationRoot(), 'bin', 'jevellan.mjs'), 'mcp-bridge'], env: launchEnv } } } };
      const outside = this.outside.watch(workspace.project, workspace.path, config.guards.externalActivityWindowMin, reason => {
        work.ledger.append({ type: 'git', stretch: n, data: CheckpointBlockSchema.parse({ schema: 'checkpoint-block-v1', workId: workspace.owner.workId, stretch: n, before, reason }) });
        this.#notice(work, reason, 'error');
      });
      operation.outside = outside;
      let outcome; let usageUpdates = Promise.resolve(); let accountFailure: unknown;
      let streamUsage = accounts.find(entry => entry.account.id === selected.account.id)?.statuses.find(status => status.deviceId === this.options.deviceId)?.usage;
      try {
        const execution = new StretchExecution({ work, input, adapter, enterRepair: () => grant.tools.repair(), onEvent: (event) => {
          if (event.type === 'text' || event.type === 'tool-start') this.#progress(work, 'running');
          if (event.type === 'rate-limit') {
            streamUsage = { ...streamUsage, fiveHourPct: event.fiveHourPct ?? streamUsage?.fiveHourPct, weeklyPct: event.weeklyPct ?? streamUsage?.weeklyPct,
              fiveHourResetsAt: event.fiveHourResetsAt ?? streamUsage?.fiveHourResetsAt, weeklyResetsAt: event.weeklyResetsAt ?? streamUsage?.weeklyResetsAt, source: 'stream', observedAt: new Date().toISOString() };
            const snapshot = streamUsage;
            // Reporting to the hub must not stall a runtime already in progress.
            usageUpdates = usageUpdates.then(async () => {
              try { await this.options.accounts.recordUsage(selected.account.id, snapshot, account.account.secretRef ?? null); accountFailure = undefined; }
              catch (error) { accountFailure = error; }
            });
          }
        } });
        operation.execution = execution; outcome = await execution.done;
      } finally { delete operation.execution; await outside.close(); delete operation.outside; await grant.close(); }
      if (operation.shutdown) {
        // Restart semantics (7.5): the processes are gone and the token revoked; nothing is checkpointed, the work stays open and owned.
        work.finish(n, { status: 'interrupted', usage: outcome.usage }, false, false, { schema: 'work-control-v1', kind: 'pause', state: 'waiting-for-you', reason: RESTART_NOTICE });
        this.#record(work, { ...decision, outcome: { stretch: n, status: 'interrupted', handoffStatus: outcome.handoff.status } });
        await this.#blockInterrupted(work, n, before);
        return;
      }
      this.#progress(work, 'saving');
      const completedDigest = await workspace.workingTreeDigest();
      const changed = completedDigest !== digest;
      let gitAfter: string | undefined; let failure: unknown;
      try {
        if (outside.reason()) throw new ExternalActivityError(outside.reason()!);
        await workspace.checkAfterStretch(before, action);
        if (permissions === 'read-only' && !memoryWrite && changed) throw new Error('A read-only step changed project files. Check the changes before continuing.');
        if (memoryWrite && workspace.project.branchPolicy === 'main') {
          gitAfter = (await this.#withCheckoutWait(work, workspace, operation, 'checkpoint', assertUnchanged => workspace.checkpoint(permissions === 'write' ? action : 'memory', outcome.handoff.summary, before, assertUnchanged), { stretch: n, before })).head;
          work.ledger.append({ type: 'git', stretch: n, data: CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId: workspace.owner.workId, stretch: n, kind: 'stretch', before: before.head, after: gitAfter }) });
        }
        new MemoryQueue(work).captureHandoff(n);
      } catch (error) {
        failure = error;
        if (!checkpointBlocks(work).some(block => block.workId === workspace.owner.workId && block.stretch === n)) work.ledger.append({ type: 'git', stretch: n, data: CheckpointBlockSchema.parse({ schema: 'checkpoint-block-v1', workId: workspace.owner.workId, stretch: n, before, reason: error instanceof Error ? error.message : 'Checkpoint validation failed.' }) });
      }
      const status = failure ? operation.cancelled || operation.shutdown ? 'interrupted' : 'failed' : outcome.status;
      work.finish(n, { status, usage: outcome.usage, ...(gitAfter ? { gitAfter } : {}) }, changed, outcome.correction);
      this.#record(work, { ...decision, outcome: { stretch: n, status, handoffStatus: outcome.handoff.status } });
      await usageUpdates;
      // A limit on one model cools only that model on this account; any other limit cools the account.
      const limit = outcome.error?.scope === 'model' ? { model: model.model, ...(outcome.error.resetsAt ? { resetsAt: outcome.error.resetsAt } : {}) } : {};
      if (outcome.error) {
        try { await this.options.accounts.recordError(selected.account.id, outcome.error.kind, account.account.secretRef ?? null, limit); }
        catch (error) { accountFailure = error; }
      }
      if (failure) throw failure;
      if (accountFailure && !(accountFailure instanceof HubUnavailable)) throw accountFailure;
      if (accountFailure) await this.hubWaits.retry(work, operation.abort.signal, 'account-report', async () => {
        if (streamUsage) await this.options.accounts.recordUsage(selected.account.id, streamUsage, account.account.secretRef ?? null);
        if (outcome.error) await this.options.accounts.recordError(selected.account.id, outcome.error.kind, account.account.secretRef ?? null, limit);
      });
    } finally { if (serial) this.#accountRuns.delete(selected.account.id); }
  }
  async #applyMemory(work: ConversationWork, workspace: GitWorkspace, operation: Operation): Promise<void> {
    const queue = new MemoryQueue(work); const pending = queue.pending(workspace.owner.workId); if (!pending.length) return;
    await this.hubWaits.retry(work, operation.abort.signal, 'memory', () => this.#admit(work, workspace));
    const before = await workspace.snapshot(); const digest = await workspace.workingTreeDigest(); const stretch = pending.at(-1)!.stretch;
    const block = (reason: string) => {
      if (!checkpointBlocks(work).some(entry => entry.workId === workspace.owner.workId)) work.ledger.append({ type: 'git', stretch, data: CheckpointBlockSchema.parse({ schema: 'checkpoint-block-v1', workId: workspace.owner.workId, stretch, before, reason }) });
    };
    const settings = await this.hubWaits.retry(work, operation.abort.signal, 'memory', () => Promise.resolve(this.options.settings()));
    const outside = this.outside.watch(workspace.project, workspace.path, settings.guards.externalActivityWindowMin, reason => block(reason));
    const memory = this.options.memory.project(workspace.project, this.options.deviceId, () => this.#withCheckoutWait(work, workspace, operation, 'memory', async assertUnchanged => {
      await this.ownership.assert(workspace.project, workspace.owner); await this.#outsideIdle(workspace); this.#checkpointAllowed(work, workspace.owner.workId); await assertUnchanged();
    }, { stretch, before }));
    try {
      await queue.apply(workspace.owner.workId, memory, async summary => {
        await outside.close();
        if (outside.reason()) throw new ExternalActivityError(outside.reason()!);
        if (workspace.project.branchPolicy !== 'main') return null;
        const after = (await this.#withCheckoutWait(work, workspace, operation, 'memory', assertUnchanged => workspace.checkpoint('memory', summary, before, async () => {
          await this.#outsideIdle(workspace); this.#checkpointAllowed(work, workspace.owner.workId); await assertUnchanged();
        }), { stretch, before })).head;
        work.ledger.append({ type: 'git', stretch, data: CheckpointReceiptSchema.parse({ schema: 'checkpoint-receipt-v1', workId: workspace.owner.workId, stretch, kind: 'memory', before: before.head, after }) });
        return after;
      }, operation.abort.signal);
    } catch (error) {
      if (error instanceof ExternalActivityError || await workspace.workingTreeDigest() !== digest || await workspace.head() !== before.head) block(error instanceof Error ? error.message : 'Memory capture was interrupted before its checkpoint settled.');
      throw error;
    } finally { await outside.close(); }
  }
  async #withCheckoutWait<T>(work: ConversationWork, workspace: GitWorkspace, operation: Operation, boundary: 'memory' | 'checkpoint', run: (assertUnchanged: () => Promise<void>) => Promise<T>, checkpoint: NonNullable<HubWait['checkpoint']>): Promise<T> {
    const before = await workspace.snapshot(); const digest = await workspace.workingTreeDigest(); let waited = false;
    const assertUnchanged = async () => {
      if (!waited) return;
      if (stableJson(await workspace.snapshot()) !== stableJson(before) || await workspace.workingTreeDigest() !== digest) throw new Error('The checkout changed while waiting for the hub. Open Changes and review it before continuing.');
      await this.#outsideIdle(workspace); this.#checkpointAllowed(work, workspace.owner.workId);
    };
    // A stopped runtime still settles its finished files once. Do not leave
    // cancellation waiting for an offline hub or start any further work.
    if (boundary === 'checkpoint' && operation.cancelled) { waited = true; await assertUnchanged(); return run(assertUnchanged); }
    return this.hubWaits.retry(work, operation.abort.signal, boundary, async () => { await assertUnchanged(); return run(assertUnchanged); }, { checkpoint, beforeRetry: () => { waited = true; } });
  }
  async #publish(work: ConversationWork, workspace: GitWorkspace, operation: Operation, options: Parameters<typeof publishWorkspace>[4]) {
    this.#progress(work, 'publishing');
    let held: PublicationLease | undefined;
    const release = async (lease: PublicationLease) => {
      await this.hubWaits.retry(work, operation.abort.signal, 'publication-release', () => this.leases.release(lease));
      if (held?.token === lease.token) held = undefined;
    };
    const leases: PublicationLeaseService = {
      acquire: async (remote, owner) => { held = await this.leases.acquire(remote, owner); return held; },
      renew: async lease => { const renewed = await this.leases.renew(lease); held = renewed; return renewed; },
      assert: lease => this.leases.assert(lease), release,
    };
    const abortRebase = async () => {
      const fingerprint = await workspace.rebaseFingerprint();
      await this.hubWaits.retry(work, operation.abort.signal, 'integration-abort', () => workspace.abortRebase(async () => {
        operation.abort.signal.throwIfAborted();
        await this.#outsideIdle(workspace); this.#checkpointAllowed(work, workspace.owner.workId, operation.redoId);
        if (await workspace.rebaseFingerprint() !== fingerprint) throw new Error('The checkout changed while waiting for the hub. Inspect the unfinished integration before continuing.');
      }));
    };
    return this.hubWaits.retry(work, operation.abort.signal, 'publication', async () => {
      // A failed authority check ends its lease attempt. Settle that exact token
      // before obtaining fresh publication authority; never reuse its timer.
      if (held) await release(held);
      return publishWorkspace(workspace, work.ledger, this.options.homes, leases, { ...options, abortRebase });
    });
  }
  async #done(work: ConversationWork, workspace: GitWorkspace, choice: ManualStep, operation: Operation, closedAs: 'done' | 'cancelled' | 'closed-by-you' = 'done'): Promise<'closed' | 'retry' | 'waiting'> {
    this.#progress(work, 'verifying');
    this.#checkpointAllowed(work, workspace.owner.workId);
    await this.#applyMemory(work, workspace, operation); this.#current(work, choice.generation, operation);
    const base = work.load().conversation.work!.baseCommit;
    if (workspace.project.branchPolicy === 'main' && !await workspace.clean()) throw new Error('Uncommitted changes remain. This work cannot finish before its changes are checkpointed.');
    let published = false;
    if (base) {
      await this.hubWaits.retry(work, operation.abort.signal, 'publication', async () => {
        await this.#outsideIdle(workspace); this.#current(work, choice.generation, operation);
        await this.ownership.acquire(workspace.project, workspace.owner); await this.#recordedHead(work, workspace);
      });
      if (workspace.project.branchPolicy === 'external') {
        if (workspace.project.testCommand) {
          const receipt = await verifyWorkspace(workspace, work.ledger, this.options.homes, 'done-gate', { redactor: this.options.redactor, signal: operation.abort.signal });
          if (!externalVerificationCounts(receipt, await workspace.head(), await workspace.workingTreeDigest())) { work.pause('Verification failed or the tested files changed. This work remains open.'); return 'retry'; }
        } else this.#notice(work, 'Finished without tests: this project has no test command.');
      } else if (await workspace.head() !== base) {
        let decisionWaiting = false;
        const publication = await this.#publish(work, workspace, operation, { assertHistory: () => this.#recordedHead(work, workspace), baseCommit: base, signal: operation.abort.signal, nextStretch: () => work.load().conversation.stretchCount + 1, assertCurrent: async () => { this.#current(work, choice.generation, operation); this.#checkpointAllowed(work, workspace.owner.workId); await this.#outsideIdle(workspace); this.#current(work, choice.generation, operation); }, integrate: async ({ run }) => {
          const contextWork = this.options.contexts.list().some((document) => document.conversationId === work.ledger.id);
          let prepared: PreparedDecision | undefined;
          if (!contextWork && this.options.decisionClient && (await this.options.jevAvailable?.()) !== false) {
            prepared = await this.#choose(work, workspace, operation, 'stretch-end', 'integrate');
            if (!prepared) { decisionWaiting = true; return false; }
          }
          const integrationChoice = prepared ? { ...choice, modelId: prepared.record.model!.chosen, effort: prepared.record.effort!.requested, remember: false } : contextWork && !choice.modelId && !work.load().conversation.current?.modelId ? { ...choice, modelId: await this.#contextModel() } : choice;
          await this.#stretch(work, workspace, integrationChoice, operation, 'integrate', 'manual', run, prepared);
          const last = work.load().stretches.at(-1)!;
          if (last.status !== 'completed' || work.load().handoffs.at(-1)?.status !== 'done') return false;
          await this.#applyMemory(work, workspace, operation); return true;
        } });
        if (publication.status === 'blocked') {
          if (decisionWaiting) return 'waiting';
          const settings = await this.hubWaits.retry(work, operation.abort.signal, 'settings', () => Promise.resolve(this.options.settings()));
          const stop = checkGuards(work.load().conversation.work!, settings.guards); work.pause(stop?.notice ?? publication.notice!, 'waiting-for-you', stop?.kind);
          return !stop && publication.verificationId ? 'retry' : 'waiting';
        }
        await this.options.memory.project(workspace.project, this.options.deviceId, async () => { await this.ownership.assert(workspace.project, workspace.owner); await this.#outsideIdle(workspace); }).sync();
        published = true;
      }
    }
    this.#current(work, choice.generation, operation);
    const handoff = this.#lastHandoff(work); if (handoff && handoff.action !== 'reply') this.#notice(work, handoff.summary, 'closing');
    work.close(closedAs);
    await this.hubWaits.retry(work, operation.abort.signal, 'checkout-release', async () => {
      const claim = await this.ownership.current(workspace.project);
      if (claim?.workId === workspace.owner.workId && claim.conversationId === workspace.owner.conversationId) await this.ownership.release(workspace.project, workspace.owner, { processesGone: true, commits: published ? 'published' : 'unchanged' });
    }, { owner: { workId: workspace.owner.workId, generation: choice.generation } });
    this.#finishContext(work, 'completed');
    return 'closed';
  }
  async #stop(work: ConversationWork): Promise<void> {
    const id = work.ledger.id;
    const operation = this.#operations.get(id);
    if (operation) { operation.cancelled = true; operation.abort.abort(); await operation.execution?.cancel(); await operation.promise; }
    else if (work.load().conversation.state === 'running') {
      const result = await recoverRunningWork(work); if (result.blocked.length) throw new Error(result.blocked[0]!.reason);
    }
    if (work.load().conversation.state === 'running') throw new Error('Process cleanup could not be confirmed. Checkout ownership remains held.');
  }
  async cancel(id: string) {
    await this.ready; const work = this.#load(id);
    // Repeated Cancel acknowledges the closed work. Shutdown still drains its wait.
    if (!this.#closed && this.#operations.get(id)?.cancellationCleanup) return this.view(id);
    if (work.load().conversation.work) work.invalidate('cancel');
    await this.#stop(work);
    const conversation = work.load().conversation;
    if (!conversation.work) return (await this.view(id));
    // Process termination and the local outcome do not depend on the hub.
    // Authority is still required before any ownership cleanup can follow.
    work.close('cancelled');
    const target = conversation.work;
    let workspace: GitWorkspace | undefined;
    const cleanup = async () => {
      workspace ??= new GitWorkspace(await this.#project(conversation.projectId), this.options.deviceId, this.ownership,
        { conversationId: id, conversationTitle: conversation.title, workId: target.id }, this.options.redactor);
      const claim = await this.ownership.current(workspace.project);
      const pendingUndo = redoOperations(work).some((entry) => entry.workId === target.id && entry.plan && !this.#undoReceipt(work, entry.id));
      if (claim?.workId === target.id && claim.conversationId === id &&
          (!claim.held || !pendingUndo && await workspace.clean() && (!target.baseCommit || await workspace.head() === target.baseCommit))) {
        await this.ownership.release(workspace.project, workspace.owner, { processesGone: true, commits: 'unchanged' });
      }
      const remaining = await this.ownership.current(workspace.project);
      if (!remaining?.held || remaining.workId !== target.id || remaining.conversationId !== id) this.#finishContext(work, 'cancelled');
    };
    try { await cleanup(); }
    catch (error) {
      if (!(error instanceof HubUnavailable) || this.#closed) throw error;
      return this.#operate(work, operation => this.hubWaits.retry(work, operation.abort.signal, 'checkout-release', cleanup,
        { owner: { workId: target.id, generation: conversation.generation } }), { cancellationCleanup: true });
    }
    this.#index(work); return (await this.view(id));
  }
  /**
   * An interrupted step's leftover edits would otherwise dead-end the work: the next writing step refuses a dirty checkout.
   * Recording them as a checkpoint block routes them through Changes review and Accept, like any other unaccepted change.
   */
  async #blockInterrupted(work: ConversationWork, n: number, before?: GitSnapshot): Promise<void> {
    const view = work.load(); const stretch = view.stretches.find((entry) => entry.n === n); const target = view.conversation.work;
    if (!stretch?.gitBefore || !target || target.id !== stretch.workId) return;
    // Only writing steps leave their own edits behind; Integrate history belongs to integration recovery at publication.
    if (actionPermissions(stretch.action) !== 'write' || stretch.action === 'integrate') return;
    if (checkpointBlocks(work).some((block) => block.workId === target.id && block.stretch === n)) return;
    try {
      const workspace = new GitWorkspace(await this.#project(view.conversation.projectId), this.options.deviceId, this.ownership,
        { conversationId: work.ledger.id, conversationTitle: view.conversation.title, workId: target.id }, this.options.redactor);
      if (workspace.project.branchPolicy !== 'main') return;
      const current = await workspace.snapshot();
      // A block can only be accepted on main at the step's starting commit. A moved HEAD is a recorded checkpoint (its receipt
      // and #recordedHead cover it) or history an agent changed; an unfinished Git operation is not a set of files to review.
      if (current.branch !== 'refs/heads/main' || await workspace.rebaseInProgress() || current.head !== (before?.head ?? stretch.gitBefore) || current.clean) return;
      // After a crash only the starting commit is known; a writing step always starts from a clean tree on that commit.
      const boundary = before ?? { ...current, clean: true };
      work.ledger.append({ type: 'git', stretch: n, data: CheckpointBlockSchema.parse({ schema: 'checkpoint-block-v1', workId: target.id, stretch: n, before: boundary,
        reason: 'Jevellan restarted while this step was changing files. Open Changes, review what it left and accept it before continuing.' }) });
    } catch (error) {
      this.#notice(work, `Jevellan could not inspect the files this step left: ${error instanceof Error ? error.message : 'unknown error'} Open Changes before continuing.`, 'error');
    }
  }
  /**
   * A daemon stop is a restart, not a cancel (7.5): stop the processes, revoke the stretch token and drain, then leave the
   * work open, owned and waiting with the restart notice. Nothing is checkpointed, closed or released here.
   */
  async #shutdown(id: string): Promise<void> {
    const work = this.#load(id); const operation = this.#operations.get(id);
    if (operation) { operation.shutdown = true; operation.abort.abort(); await operation.execution?.stop(); await operation.promise; }
    if (work.load().conversation.state === 'running') {
      const result = await recoverRunningWork(work); if (result.blocked.length) throw new Error(result.blocked[0]!.reason);
      for (const n of result.recovered) await this.#blockInterrupted(work, n);
    }
    if (work.load().conversation.state === 'running') throw new Error('Process cleanup could not be confirmed. Checkout ownership remains held.');
    // Whatever the interrupted operation was waiting on (a decision, the hub, a checkout) will not resume by itself after the restart.
    const current = work.load();
    if (operation && current.conversation.work && current.pause?.reason !== RESTART_NOTICE) work.pause(RESTART_NOTICE, 'waiting-for-you');
  }
  async close(): Promise<void> {
    await this.ready.catch(() => undefined); this.#closed = true;
    const failures: unknown[] = [];
    await Promise.all([...this.#operations.keys()].map(async (id) => {
      try { await this.#shutdown(id); }
      catch (error) {
        const work = this.#load(id); this.#notice(work, error instanceof Error ? error.message : 'Shutdown could not settle this work.', 'error');
        if (work.load().conversation.work && work.load().conversation.state !== 'running') work.pause('Jevellan stopped before this work could settle. Reconnect to the hub before continuing.', 'blocked');
        if (work.load().conversation.state === 'running' || !error || typeof error !== 'object' || !('status' in error) || error.status !== 503) failures.push(error);
      }
    }));
    for (const work of this.#works.values()) this.#queueIndex(work, conversationIndex(work.load().conversation));
    await this.indexes.flush().catch(() => undefined); await this.indexes.close();
    if (failures.length) throw new AggregateError(failures, 'Conversation shutdown did not complete.');
  }
}
