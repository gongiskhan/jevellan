import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import {
  EffortSchema, PlacementOverrideSchema, ThreadReadResultSchema, ThreadSchema, concludedRecently, isTerminal, liveWork, mapEffort, newId, stableJson, type Configuration, type CoordinatorEvent,
  type PlacementOverride, type ProjectHub, type ProjectLedgerEvent, type SecretRedactor, type SharedProjects, type Thread, type ThreadCommand, type ThreadIndex,
  type ThreadOverrideRequestSchema, type ThreadReport, type ThreadState,
} from '@jevellan/core';
import type { PlacementFixed } from '@jevellan/decisions';
import type { Admission } from './admission.js';
import {
  MODEL_SAME_RUNTIME, NEXT_TURN_FIELDS, PROJECT_NOT_FOUND, REMOTE_THREADS_LATER, THREAD_ATTACHED, THREAD_ENDED, THREAD_NOT_FOUND, UNKNOWN_PLACEMENT_MODEL, isWaitingForSlot,
  overrideSummary, ownerStartedLine, placementSummary, queuedReason, restartedReason,
} from './copy.js';
import type { CoordinatorService } from './coordinator.js';
import { derivedId } from './decision-items.js';
import type { ProjectLedgers } from './ledger.js';
import type { Placement } from './placement.js';
import type { StartReceipts, ThreadLabels, ThreadStore } from './stores.js';
import { REST_STATES, ThreadRunner, restartRefusal, type ThreadRunnerContext } from './thread-runner.js';
import { assistantText, type ThreadTranscripts } from './transcript.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
type ThreadReadResult = z.infer<typeof ThreadReadResultSchema>;
type ThreadOverrideRequest = z.infer<typeof ThreadOverrideRequestSchema>;
type OverrideChange = PlacementOverride['changes'][number];

/**
 * Every message that crosses the device boundary (2.6.1). Phases 1-4 deliver locally; phase 5 adds the envelope branches
 * without changing callers. Placement only offers this device before phase 5 (D88), so a remote owner is a programming error.
 */
export interface Delivery {
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  toThreadOwner(projectId: string, threadId: string, ownerDeviceId: string, command: ThreadCommand): Promise<void>;
  startOnDevice(thread: Thread, labels: ThreadLabels): Promise<void>;
}
export class LocalDelivery implements Delivery {
  constructor(private readonly o: { deviceId: string; coordinators: Pick<CoordinatorService, 'get'>; store: Pick<ThreadStore, 'create'>;
    /** Applies a command to a local thread (the thread service; bound after construction). */
    command(projectId: string, threadId: string, command: ThreadCommand): Promise<void> }) {}
  /** The coordinator queue on this device; with no coordinator assigned yet the event waits here too (D6). */
  async toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void> { this.o.coordinators.get(projectId).enqueue(event); }
  async toThreadOwner(projectId: string, threadId: string, ownerDeviceId: string, command: ThreadCommand): Promise<void> {
    if (ownerDeviceId !== this.o.deviceId) throw new Error(REMOTE_THREADS_LATER);
    await this.o.command(projectId, threadId, command);
  }
  async startOnDevice(thread: Thread, labels: ThreadLabels): Promise<void> {
    if (thread.ownerDeviceId !== this.o.deviceId) throw new Error(REMOTE_THREADS_LATER);
    this.o.store.create(thread, labels);
  }
}

export type StartRequest = {
  projectId: string; title: string; task: string; createdBy: 'coordinator' | 'owner'; fixed: PlacementFixed; note?: string | undefined;
  /** Owner-created starts are idempotent by this id (D78). */
  clientRequestId?: string | undefined;
  /** The project's coordinator device; starts run there (D9a). */
  coordinatorDeviceId: string;
};
export type StartResult = { threadId: string; state: ThreadState; stateReason?: string; placement: string; repeated: boolean };
export type ThreadServiceOptions = {
  deviceId: string; deviceName: string; redactor: SecretRedactor;
  store: ThreadStore; ledgers: ProjectLedgers; receipts: StartReceipts;
  hub: Pick<ProjectHub, 'threads' | 'addOverride'>; projects: Pick<SharedProjects, 'get'>;
  admission: Pick<Admission, 'admit' | 'counts' | 'settings'>; placement: Pick<Placement, 'place' | 'refusal'>; accounts: Pick<AccountService, 'list'>;
  /** The configuration: the menu resolves an overridden model. */
  settings(): Promise<Configuration['x-jevellan']>;
  transcripts: Pick<ThreadTranscripts, 'read'>;
  delivery: Delivery;
  /** Everything a runner needs except `rested`, which the service provides. */
  runner: Omit<ThreadRunnerContext, 'rested'>;
  now(): number;
};
const oldestMessage = (thread: Thread) => thread.queuedMessages.reduce((oldest, message) => message.at < oldest ? message.at : oldest, thread.queuedMessages[0]?.at ?? '');

/**
 * Threads on this device (brief 8.2, 2.6.10): the start path with receipts, placement, limits and the FIFO queue (D9, D9a),
 * message routing with the sender rules (D81), stop, discard and allow-turns, and the thread list and read for tools. Starts
 * of one project are serialized, so placement, counting and creation never interleave.
 */
export class ThreadService {
  readonly #o: ThreadServiceOptions;
  readonly #runners = new Map<string, ThreadRunner>();
  readonly #starts = new Map<string, Promise<unknown>>();
  #starting = 0;
  #sweep: Set<string> | undefined;
  #started = false;
  #closed = false;
  constructor(o: ThreadServiceOptions) { this.#o = o; }
  /** The runner of a local thread (created on first use); undefined for threads this device does not own. */
  runner(threadId: string): ThreadRunner | undefined {
    let runner = this.#runners.get(threadId);
    if (!runner && this.#o.store.get(threadId)) {
      runner = new ThreadRunner(threadId, { ...this.#o.runner, rested: (projectId) => this.#rested(projectId) });
      this.#runners.set(threadId, runner);
    }
    return runner;
  }
  /** Local threads in a live step, from memory (D9 admission counts these, never the hub copy). */
  liveThreads(projectId: string): string[] {
    return this.#o.store.list(projectId).filter((thread) => liveWork(thread.state)).map((thread) => thread.id);
  }
  #local(projectId: string, threadId: string): Thread {
    const thread = this.#o.store.get(threadId);
    if (!thread || thread.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
    return thread;
  }
  #exclusive<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    this.#starting += 1;
    const result = (this.#starts.get(projectId) ?? Promise.resolve()).then(task);
    const chain = result.then(() => undefined, () => undefined).finally(() => { this.#starting -= 1; });
    this.#starts.set(projectId, chain);
    void chain.then(() => { if (this.#starts.get(projectId) === chain) this.#starts.delete(projectId); });
    return result;
  }
  #summary(thread: Thread, labels: { modelLabel: string; deviceName: string }): string {
    const placement = thread.placement;
    return placementSummary({ runtime: this.#o.runner.runtimeName(placement.runtime), modelLabel: labels.modelLabel, effort: placement.effortEffective, isolation: thread.isolation,
      deviceName: labels.deviceName, fallback: placement.source === 'fallback' ? placement.error?.message : undefined });
  }
  #result(thread: Thread, labels: { modelLabel: string; deviceName: string }, repeated: boolean): StartResult {
    return { threadId: thread.id, state: thread.state, ...(thread.stateReason === undefined ? {} : { stateReason: thread.stateReason }), placement: this.#summary(thread, labels), repeated };
  }
  /** Lets queued starts and waiting turns run (after `ProjectWork.start`, once the daemon URL is known). */
  begin(): void { this.#started = true; }

  /**
   * The start path (3.1 step 2): receipts, project and settings, live work, placement, then the thread is created as
   * `preparing`, or `queued` over a running limit (D9, D71, D133). Refusals are 409 with the placement text; nothing is
   * created. An owner start tells the coordinator with the preformatted line (brief 9.5, D35).
   */
  start(request: StartRequest): Promise<StartResult> {
    return this.#exclusive(request.projectId, async () => {
      const { projectId } = request;
      const normalized = { title: request.title, task: request.task, ...request.fixed };
      if (request.clientRequestId !== undefined) {
        const prior = this.#o.receipts.get(projectId, request.clientRequestId, normalized);
        const existing = prior && this.#o.store.get(prior.threadId);
        if (existing) return this.#result(existing, { modelLabel: this.#o.store.labels(existing.id).modelLabel, deviceName: this.#o.deviceName }, true);
      }
      const project = (await this.#o.projects.get(projectId))?.project;
      if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
      const settings = await this.#o.admission.settings(projectId);
      const counts = await this.#o.admission.counts(projectId);
      const projectFull = counts.project >= counts.limits.project;
      const placed = await this.#o.placement.place({ project, workSettings: settings, title: request.title, task: request.task, note: request.note, fixed: request.fixed,
        coordinatorDeviceId: request.coordinatorDeviceId, ignoreRunningLimit: projectFull });
      if (placed.kind === 'refused') throw refuse(placed.message, 409);
      const at = this.#o.now(); const threadId = newId('thread', at); const record = placed.record;
      let queued = projectFull ? queuedReason(counts.limits.project, null) : placed.atLimit ? queuedReason(settings.maxRunningPerDevice, placed.labels.deviceName) : undefined;
      let hold: (() => void) | undefined;
      if (queued === undefined) {
        // The final check is an admission, serialized with every other one, so no two starts take the last slot.
        const admitted = await this.#o.admission.admit(projectId, record.deviceId, threadId);
        if (admitted.ok) hold = admitted.release; else queued = admitted.queued;
      }
      const thread = ThreadSchema.parse({ schema: 'project-thread-v1', id: threadId, projectId, title: request.title, task: request.task, createdAt: new Date(at).toISOString(),
        createdBy: request.createdBy, state: queued === undefined ? 'preparing' : 'queued', ...(queued === undefined ? {} : { stateReason: queued }), isolation: record.isolation,
        placement: record, ownerDeviceId: record.deviceId, coordinatorDeviceId: request.coordinatorDeviceId, cwd: '', baseBranch: '', baseCommit: '', turns: 0,
        turnAllowance: settings.threadTurnCap, queuedMessages: [], verificationAttempts: 0 });
      try {
        const accountLabel = (await this.#o.accounts.list()).find((view) => view.account.id === record.accountId)?.account.label ?? record.accountId;
        await this.#o.delivery.startOnDevice(thread, { modelLabel: placed.labels.modelLabel, accountLabel });
      } finally { hold?.(); }
      if (request.clientRequestId !== undefined) this.#o.receipts.put(projectId, request.clientRequestId, normalized, threadId);
      if (request.createdBy === 'owner') {
        await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'thread-user-message', id: newId('cev', at), at: new Date(at).toISOString(),
          threadId, text: ownerStartedLine(thread.title, threadId, thread.task) });
      }
      // Preparation runs in the background: the start answers within the bridge budget.
      if (queued === undefined && thread.ownerDeviceId === this.#o.deviceId) void this.runner(threadId)?.prepare();
      return this.#result(thread, { modelLabel: placed.labels.modelLabel, deviceName: placed.labels.deviceName }, false);
    });
  }
  #at(at: number): string { return new Date(at).toISOString(); }
  #note(note: string | undefined): string | undefined { const trimmed = note?.trim(); return trimmed ? this.#o.redactor.text(trimmed).slice(0, 400) : undefined; }
  /**
   * From the next turn (brief 10, D50, D252): the model (same runtime only) and the effort of the thread's next turn. Only changed
   * fields are recorded, `from` being the requested value; the hub record comes first, so a refused write changes nothing, then the
   * coordinator hears it, then the owner applies it. A retry with the same request id repeats; nothing to change is a no-op.
   */
  async overrideNextTurn(projectId: string, threadId: string, input: ThreadOverrideRequest): Promise<void> {
    const thread = this.#local(projectId, threadId); const placement = thread.placement;
    if (input.isolation !== undefined || input.deviceId !== undefined) throw refuse(NEXT_TURN_FIELDS, 400);
    if (isTerminal(thread.state)) throw refuse(THREAD_ENDED, 409);
    const model = input.modelId === undefined ? undefined : (await this.#o.settings()).menu.find((entry) => entry.id === input.modelId);
    if (input.modelId !== undefined && !model) throw refuse(UNKNOWN_PLACEMENT_MODEL, 409);
    if (model && model.runtime !== placement.runtime) throw refuse(MODEL_SAME_RUNTIME, 409);
    const changes: OverrideChange[] = [...(model && model.id !== placement.modelId ? [{ field: 'model' as const, from: placement.modelId, to: model.id }] : []),
      ...(input.effort !== undefined && input.effort !== placement.effortRequested ? [{ field: 'effort' as const, from: placement.effortRequested, to: input.effort }] : [])];
    if (!changes.length) return;
    if (model && model.id !== placement.modelId) {
      // The model must be able to run this thread where it is: enabled, its runtime able to run threads, an account on this device.
      const project = (await this.#o.projects.get(projectId))?.project; if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
      const refused = await this.#o.placement.refusal({ project, workSettings: await this.#o.admission.settings(projectId), title: thread.title, task: thread.task,
        fixed: { isolation: thread.isolation, modelId: model.id, deviceId: thread.ownerDeviceId }, coordinatorDeviceId: thread.coordinatorDeviceId, ignoreRunningLimit: true });
      if (refused) throw refuse(refused, 409);
    }
    const at = this.#o.now(); const note = this.#note(input.note);
    const override = PlacementOverrideSchema.parse({ schema: 'placement-override-v1', id: derivedId('povr', projectId, threadId, input.clientRequestId), projectId, threadId,
      mode: 'next-turn', changes, ...(note ? { note } : {}), at: this.#at(at) });
    await this.#o.hub.addOverride(override);
    await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'placement-override', id: derivedId('cev', override.id), at: this.#at(at), threadId,
      summary: overrideSummary({ changes, note }) });
    await this.#o.delivery.toThreadOwner(projectId, threadId, thread.ownerDeviceId, { type: 'override-next-turn', override });
  }
  /** The owner applies a next-turn override: the next launch reads the thread's placement, so a running turn keeps its own (D252). */
  async #applyNextTurn(threadId: string, override: PlacementOverride): Promise<void> {
    const menu = (await this.#o.settings()).menu; const current = this.#o.store.get(threadId)!;
    if (isTerminal(current.state)) throw refuse(THREAD_ENDED, 409);
    const to = (field: OverrideChange['field']) => override.changes.find((change) => change.field === field)?.to;
    const model = menu.find((entry) => entry.id === (to('model') ?? current.placement.modelId));
    if (!model) throw refuse(UNKNOWN_PLACEMENT_MODEL, 409);
    const requested = EffortSchema.parse(to('effort') ?? current.placement.effortRequested);
    const placement = { ...current.placement, modelId: model.id, model: model.model, effortRequested: requested, effortEffective: mapEffort(requested, model.efforts) };
    if (stableJson(placement) !== stableJson(current.placement)) this.#o.store.update(threadId, (latest) => ({ ...latest, placement }), { type: 'thread-placement', data: placement });
    this.#o.store.setLabels(threadId, { modelLabel: model.label });
  }
  /**
   * Restart with these choices (brief 10, D252): a new thread with the same title and task and the given fields fixed is placed
   * first, through the start path with a request id derived from this one, so a refusal leaves this thread untouched and a retry
   * finds the same new thread. Then the change is recorded, this thread ends with `Restarted as {newId}.` and its worktree goes,
   * and the coordinator hears both. `coordinatorDeviceId` is the device that starts threads (D9a).
   */
  async restart(projectId: string, threadId: string, input: ThreadOverrideRequest, coordinatorDeviceId: string): Promise<{ newThreadId: string }> {
    const thread = this.#local(projectId, threadId); const placement = thread.placement;
    const fixed: PlacementFixed = { ...(input.isolation ? { isolation: input.isolation } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.effort ? { effort: input.effort } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}) };
    const clientRequestId = derivedId('treq', 'restart', projectId, threadId, input.clientRequestId);
    // A retry of an applied restart passes the refusals that the restart itself caused.
    if (!this.#o.receipts.get(projectId, clientRequestId, { title: thread.title, task: thread.task, ...fixed })) { const refused = restartRefusal(thread); if (refused) throw refuse(refused, 409); }
    const note = this.#note(input.note);
    const started = await this.start({ projectId, title: thread.title, task: thread.task, createdBy: 'owner', fixed, note, clientRequestId, coordinatorDeviceId });
    const changes: OverrideChange[] = [
      ...(fixed.isolation !== undefined && fixed.isolation !== thread.isolation ? [{ field: 'isolation' as const, from: thread.isolation, to: fixed.isolation }] : []),
      ...(fixed.modelId !== undefined && fixed.modelId !== placement.modelId ? [{ field: 'model' as const, from: placement.modelId, to: fixed.modelId }] : []),
      ...(fixed.effort !== undefined && fixed.effort !== placement.effortRequested ? [{ field: 'effort' as const, from: placement.effortRequested, to: fixed.effort }] : []),
      ...(fixed.deviceId !== undefined && fixed.deviceId !== thread.ownerDeviceId ? [{ field: 'device' as const, from: thread.ownerDeviceId, to: fixed.deviceId }] : [])];
    const id = derivedId('povr', projectId, threadId, input.clientRequestId); const at = this.#at(this.#o.now());
    if (changes.length) await this.#o.hub.addOverride(PlacementOverrideSchema.parse({ schema: 'placement-override-v1', id, projectId, threadId, mode: 'restart', changes, ...(note ? { note } : {}), at }));
    await this.runner(threadId)!.restarted(restartedReason(started.threadId));
    await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'placement-override', id: derivedId('cev', id), at, threadId,
      summary: overrideSummary({ changes, note, restartedAs: started.threadId }) });
    return { newThreadId: started.threadId };
  }
  /**
   * The coordinator's queue sweep (D9a): `queued` threads in creation order start as slots free; a full device is skipped,
   * a full project ends the sweep.
   */
  sweepQueue(projectId: string): Promise<void> {
    if (!this.#started || this.#closed) return Promise.resolve();
    return this.#exclusive(projectId, async () => {
      const full = new Set<string>();
      for (const thread of this.#o.store.list(projectId).filter((entry) => entry.state === 'queued')) {
        if (this.#closed) return;
        if (full.has(thread.ownerDeviceId)) continue;
        const admitted = await this.#o.admission.admit(projectId, thread.ownerDeviceId, thread.id);
        if (!admitted.ok) { if (admitted.scope === 'project') return; full.add(thread.ownerDeviceId); continue; }
        const runner = this.runner(thread.id);
        if (runner) void runner.prepare(admitted.release); else admitted.release();
      }
    });
  }
  /** Threads at rest whose next turn waits for a slot (D9), oldest queued message first. */
  async sweepWaiting(): Promise<void> {
    if (!this.#started || this.#closed) return;
    const waiting = this.#o.store.all().filter((thread) => REST_STATES.includes(thread.state) && isWaitingForSlot(thread.stateReason) && thread.queuedMessages.length)
      .sort((a, b) => oldestMessage(a).localeCompare(oldestMessage(b)));
    for (const thread of waiting) { if (this.#closed) return; await this.runner(thread.id)?.resume(); }
  }
  /** Both sweeps, for every project with local threads (the periodic timer and `pulse`). */
  async sweep(): Promise<void> {
    for (const projectId of new Set(this.#o.store.all().filter((thread) => thread.state === 'queued').map((thread) => thread.projectId))) await this.sweepQueue(projectId);
    await this.sweepWaiting();
  }
  /** A thread left live work: run the sweeps soon, once per burst. */
  #rested(projectId: string): void {
    if (!this.#started || this.#closed) return;
    if (this.#sweep) { this.#sweep.add(projectId); return; }
    const projects = this.#sweep = new Set([projectId]);
    setImmediate(() => {
      this.#sweep = undefined;
      void (async () => { for (const id of projects) await this.sweepQueue(id); await this.sweepWaiting(); })().catch(() => undefined);
    });
  }
  /**
   * A message for a thread (brief 7.1, 8.2; D81). The coordinator cannot message an attached thread; ended threads refuse
   * both senders. An owner message also reaches the coordinator as `thread-user-message`.
   */
  async message(projectId: string, threadId: string, from: 'coordinator' | 'owner', text: string, interrupt: boolean, clientMessageId?: string): Promise<{ delivery: 'started' | 'queued' | 'interrupting'; state: ThreadState; repeated: boolean }> {
    const thread = this.#local(projectId, threadId);
    if (from === 'coordinator' && thread.state === 'attached') throw refuse(THREAD_ATTACHED, 409);
    if (isTerminal(thread.state)) throw refuse(THREAD_ENDED, 409);
    const at = this.#o.now();
    const result = await this.runner(threadId)!.deliver({ id: clientMessageId ?? newId('tmsg', at), from, text, at: new Date(at).toISOString(), interrupt });
    if (from === 'owner' && !result.repeated) {
      await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'thread-user-message', id: newId('cev', at), at: new Date(at).toISOString(), threadId,
        text: this.#o.redactor.text(text) });
    }
    return { ...result, state: this.#o.store.get(threadId)!.state };
  }
  /** Stop (brief 8.2): `notify` for a stop by the owner (D28); a coordinator stop sends nothing. */
  async stop(projectId: string, threadId: string, reason: string, notify: boolean): Promise<void> {
    this.#local(projectId, threadId); await this.runner(threadId)!.stop(reason, notify);
  }
  async discard(projectId: string, threadId: string): Promise<void> { this.#local(projectId, threadId); await this.runner(threadId)!.discard(); }
  async allowTurns(projectId: string, threadId: string): Promise<void> { this.#local(projectId, threadId); await this.runner(threadId)!.allowTurns(); }
  /** A command for a local thread (the local branch of `Delivery.toThreadOwner`; phase 5 inbox commands use it too). */
  async command(projectId: string, threadId: string, command: ThreadCommand): Promise<void> {
    const thread = this.#local(projectId, threadId); const runner = this.runner(threadId)!;
    switch (command.type) {
      case 'dispatch': await runner.prepare(); return;
      case 'message': await runner.deliver(command.message); return;
      case 'stop': await runner.stop(command.reason, false); return;
      case 'discard': await runner.discard(); return;
      case 'allow-turns': await runner.allowTurns(); return;
      case 'override-next-turn': await this.#applyNextTurn(thread.id, command.override); return;
    }
  }
  /** `jevellan_threads_list`: the project's hub indexes that are not concluded; `all` adds those concluded in the last 14 days. */
  async list(projectId: string, include: 'active' | 'all'): Promise<ThreadIndex[]> {
    const threads: ThreadIndex[] = []; let after: string | undefined; const now = this.#o.now();
    do {
      const page = await this.#o.hub.threads(projectId, after);
      threads.push(...page.records.filter((index) => index.projectId === projectId && (!isTerminal(index.state) || (include === 'all' && concludedRecently(index, now)))));
      after = page.next ?? undefined;
    } while (after !== undefined);
    return threads;
  }
  /** `jevellan_thread_read` for a local thread: state, the last three reports and, on request, the assistant text tail. */
  async read(projectId: string, threadId: string, detail: 'summary' | 'transcript'): Promise<ThreadReadResult> {
    const thread = this.#local(projectId, threadId); const ledger = this.#o.ledgers.thread(projectId, threadId);
    const reports = ledger.events().filter((event) => event.type === 'thread-report').slice(-3)
      .map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'thread-report' }) as ThreadReport);
    let transcript: { transcript?: string | null; transcriptNote?: string } = {};
    if (detail === 'transcript') {
      try {
        const project = (await this.#o.projects.get(projectId))?.project;
        const read = await this.#o.transcripts.read(thread, project?.name ?? '');
        transcript = { transcript: read ? assistantText(read) : null };
      } catch (error) { transcript = { transcript: null, transcriptNote: this.#o.redactor.text(error instanceof Error ? error.message : String(error)).slice(0, 400) }; }
    }
    return ThreadReadResultSchema.parse({ schema: 'thread-read-result-v1', threadId, state: thread.state, ...(thread.stateReason === undefined ? {} : { stateReason: thread.stateReason }),
      reports, ...(thread.pr ? { pr: thread.pr } : {}), ...transcript });
  }
  /** A start, sweep or thread step is running or waiting (the `ProjectWork.idle` test seam). */
  busy(projectId?: string): boolean {
    if (this.#starting > 0) return true;
    for (const [threadId, runner] of this.#runners) {
      if (runner.busy && (projectId === undefined || this.#o.store.get(threadId)?.projectId === projectId)) return true;
    }
    return false;
  }
  /** Daemon shutdown: every running turn is terminated and every chain drained; states stay for recovery (D24). */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#runners.values()].map((runner) => runner.shutdown()));
  }
}
