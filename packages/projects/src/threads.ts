import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import { existsSync } from 'node:fs';
import {
  EffortSchema, HubUnavailable, PlacementOverrideSchema, ThreadReadResultSchema, ThreadSchema, concludedRecently, deviceAway, isTerminal, liveWork, mapEffort, newId, stableJson, type Configuration, type PlacementRecord,
  type CoordinatorEvent, type PlacementOverride, type ProjectHub, type ProjectLedgerEvent, type QueuedMessage, type SecretRedactor, type SharedProjects, type Thread, type ThreadCommand,
  type ThreadCreateRequestSchema, type ThreadCreatedViewSchema, type ThreadIndex, type ThreadOverrideRequestSchema, type ThreadReport, type ThreadState,
} from '@jevellan/core';
import type { PlacementFixed } from '@jevellan/decisions';
import { DISPATCH_HOLD_MS, type Admission } from './admission.js';
import {
  COORDINATOR_ELSEWHERE, MODEL_SAME_RUNTIME, NEXT_TURN_FIELDS, NO_RELAY, PROJECT_NOT_FOUND, THREAD_ATTACHED, THREAD_ENDED, THREAD_NOT_FOUND, UNKNOWN_PLACEMENT_MODEL, WAITING_FOR_HUB, WAITING_FOR_MAIN,
  attachedRefusal, isWaitingForAccount, isWaitingForSlot, overrideSummary, ownerStartedLine, placementSummary, queuedReason, restartedReason,
} from './copy.js';
import type { CoordinatorService } from './coordinator.js';
import { derivedId, type DecisionItems } from './decision-items.js';
import type { Outbox } from './envelopes.js';
import type { ProjectLedgers } from './ledger.js';
import type { DeviceRoster, PendingMain, Placement } from './placement.js';
import type { StartReceipts, StartedSummary, ThreadLabels, ThreadStore } from './stores.js';
import { REST_STATES, ThreadRunner, restartRefusal, type ThreadRunnerContext } from './thread-runner.js';
import { assistantText, type ThreadTranscripts } from './transcript.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
type ThreadReadResult = z.infer<typeof ThreadReadResultSchema>;
type ThreadOverrideRequest = z.infer<typeof ThreadOverrideRequestSchema>;
type OverrideChange = PlacementOverride['changes'][number];
type ThreadCreateRequest = z.infer<typeof ThreadCreateRequestSchema>;
/** The coordinator device's start for a restart on another device (D266): the route layer proxies it with the owner's session. */
export type RemoteStart = (projectId: string, coordinatorDeviceId: string, request: ThreadCreateRequest) => Promise<z.infer<typeof ThreadCreatedViewSchema>>;

/**
 * Every message that crosses the device boundary (2.6.1). The local branches run here; the others travel through the hub relay
 * (D40, D265): coordinator events to the coordinator device, starts and commands to the thread's owner device.
 */
export interface Delivery {
  toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void>;
  /** `commandId` makes a retried command repeat, so the owner applies it once; a fresh id otherwise. */
  toThreadOwner(projectId: string, threadId: string, ownerDeviceId: string, command: ThreadCommand, commandId?: string): Promise<void>;
  startOnDevice(thread: Thread, labels: ThreadLabels): Promise<void>;
}
export type DeliveryOptions = {
  deviceId: string; coordinators: Pick<CoordinatorService, 'get' | 'deviceOf'>; store: Pick<ThreadStore, 'create'>;
  /** Applies a command to a local thread (the thread service; bound after construction). */
  command(projectId: string, threadId: string, command: ThreadCommand): Promise<void>;
  /** The hub relay (bound after construction); without one, another device is a programming error. */
  outbox?(): Pick<Outbox, 'enqueue' | 'pending'>;
  now?(): number;
};
export class LocalDelivery implements Delivery {
  /** The last assignment read per project, for routing while the hub is unreachable. */
  readonly #known = new Map<string, string | null>();
  constructor(private readonly o: DeliveryOptions) {}
  #relay(): Pick<Outbox, 'enqueue' | 'pending'> { const outbox = this.o.outbox?.(); if (!outbox) throw new Error(NO_RELAY); return outbox; }
  /**
   * The coordinator queue on this device when it holds the assignment or none exists yet (the event waits here, D6); otherwise
   * the relay, which resolves the coordinator when it sends. Events behind waiting ones keep their order, and an unknown
   * assignment (the hub unreachable before any read) is left to the relay too (D265).
   */
  async toCoordinator(projectId: string, event: CoordinatorEvent): Promise<void> {
    if (await this.#elsewhere(projectId)) { this.#relay().enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event }); return; }
    this.o.coordinators.get(projectId).enqueue(event);
  }
  async #elsewhere(projectId: string): Promise<boolean> {
    const outbox = this.o.outbox?.(); if (!outbox) return false;
    if (outbox.pending(projectId).some((entry) => entry.envelope.body.kind === 'coordinator-event')) return true;
    let assigned: string | null | undefined;
    try { assigned = await this.o.coordinators.deviceOf(projectId); this.#known.set(projectId, assigned); }
    catch (error) { if (!(error instanceof HubUnavailable)) throw error; assigned = this.#known.get(projectId); if (assigned === undefined) return true; }
    return assigned !== null && assigned !== this.o.deviceId;
  }
  async toThreadOwner(projectId: string, threadId: string, ownerDeviceId: string, command: ThreadCommand, commandId?: string): Promise<void> {
    if (ownerDeviceId === this.o.deviceId) { await this.o.command(projectId, threadId, command); return; }
    this.#relay().enqueue(projectId, ownerDeviceId, { kind: 'thread-command', threadId, commandId: commandId ?? newId('tcmd', this.o.now?.() ?? Date.now()), command });
  }
  /** A thread placed on another device is created there (its inbox, 3.5.1 step 3); the outbox keeps the start until the hub holds it. */
  async startOnDevice(thread: Thread, labels: ThreadLabels): Promise<void> {
    if (thread.ownerDeviceId === this.o.deviceId) { this.o.store.create(thread, labels); return; }
    this.#relay().enqueue(thread.projectId, thread.ownerDeviceId, { kind: 'thread-start', thread });
  }
}

export type StartRequest = {
  projectId: string; title: string; task: string; createdBy: 'coordinator' | 'owner'; fixed: PlacementFixed; note?: string | undefined;
  /** Owner-created starts are idempotent by this id (D78). */
  clientRequestId?: string | undefined;
  /** The project's coordinator device; starts run there (D9a). */
  coordinatorDeviceId: string;
  /**
   * Internal, a restart of a main thread (D292): that thread's own claim does not count against the main rule, and the new thread's
   * preparation waits for the caller, which starts it once the old thread has given the checkout back.
   */
  exclude?: string | undefined; deferPrepare?: boolean | undefined;
};
export type StartResult = { threadId: string; state: ThreadState; stateReason?: string; placement: string; repeated: boolean };
export type ThreadServiceOptions = {
  deviceId: string; deviceName: string; redactor: SecretRedactor;
  store: ThreadStore; ledgers: ProjectLedgers; receipts: StartReceipts;
  hub: Pick<ProjectHub, 'threads' | 'thread' | 'coordinator' | 'addOverride'>; projects: Pick<SharedProjects, 'get'>;
  admission: Pick<Admission, 'admit' | 'counts' | 'settings' | 'dispatched' | 'isDispatched'>; placement: Pick<Placement, 'place' | 'refusal'>; accounts: Pick<AccountService, 'list'>;
  /** The configuration: the menu resolves an overridden model. */
  settings(): Promise<Configuration['x-jevellan']>;
  transcripts: Pick<ThreadTranscripts, 'read'>;
  delivery: Delivery;
  /** Everything a runner needs except `rested` and `askDirectly`, which the service provides. */
  runner: Omit<ThreadRunnerContext, 'rested' | 'askDirectly'>;
  /** Decision 7 on the owner device (D280): the roster says whether the coordinator's device is away; the fallback creates the question. */
  roster(): Promise<DeviceRoster>; decisions: Pick<DecisionItems, 'fallbackFromReports'>;
  /** The sweeps check a project's waiting questions at most this often (a new needs-decision report checks at once). */
  fallbackCheckMs: number;
  now(): number;
};
const oldestMessage = (thread: Thread) => thread.queuedMessages.reduce((oldest, message) => message.at < oldest ? message.at : oldest, thread.queuedMessages[0]?.at ?? '');
type Queued = { id: string; ownerDeviceId: string; createdAt: string; local: boolean };

/**
 * Threads on this device (brief 8.2, 2.6.10): the start path with receipts, placement, limits and the FIFO queue (D9, D9a),
 * message routing with the sender rules (D81), stop, discard and allow-turns, and the thread list and read for tools. Starts
 * of one project are serialized, so placement, counting and creation never interleave.
 */
export class ThreadService {
  readonly #o: ThreadServiceOptions;
  readonly #runners = new Map<string, ThreadRunner>();
  readonly #starts = new Map<string, Promise<unknown>>();
  /**
   * Projects that may have queued threads on other devices, with the queued starts sent from here whose index has not yet shown
   * them leaving the queue: only their sweeps read the hub's indexes (D264).
   */
  readonly #remoteQueue = new Map<string, Set<string>>();
  #starting = 0;
  #sweep: Set<string> | undefined;
  /** When each project's waiting questions were last checked against the coordinator device's presence (D280). */
  readonly #checked = new Map<string, number>();
  /** Main threads started from here on other devices, until the hub has their index or `DISPATCH_HOLD_MS` passed (D288). */
  readonly #mainStarts = new Map<string, PendingMain & { projectId: string; until: number }>();
  #started = false;
  #closed = false;
  constructor(o: ThreadServiceOptions) { this.#o = o; }
  /** The runner of a local thread (created on first use); undefined for threads this device does not own. */
  runner(threadId: string): ThreadRunner | undefined {
    let runner = this.#runners.get(threadId);
    if (!runner && this.#o.store.get(threadId)) {
      runner = new ThreadRunner(threadId, { ...this.#o.runner, rested: (projectId) => this.#rested(projectId),
        askDirectly: (projectId) => this.askDirectly(projectId, true).catch(() => undefined) });
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
  /**
   * Lets queued starts and waiting turns run (after `ProjectWork.start`, once the daemon URL is known). Every project coordinated here
   * is read once for queued threads on other devices, which an earlier run may have started.
   */
  begin(): void {
    this.#started = true;
    const paths = this.#o.store.paths;
    for (const projectId of paths.projectIds()) if (existsSync(paths.coordinator(projectId)) && !this.#remoteQueue.has(projectId)) this.#remoteQueue.set(projectId, new Set());
  }

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
        // A thread started on another device: its index once the owner published it, else what the start answered (D264).
        if (prior?.started) return this.#repeated(prior.threadId, prior.started);
      }
      const project = (await this.#o.projects.get(projectId))?.project;
      if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
      const settings = await this.#o.admission.settings(projectId);
      const counts = await this.#o.admission.counts(projectId);
      const projectFull = counts.project >= counts.limits.project;
      const placed = await this.#o.placement.place({ project, workSettings: settings, title: request.title, task: request.task, note: request.note, fixed: request.fixed,
        coordinatorDeviceId: request.coordinatorDeviceId, ignoreRunningLimit: projectFull, exclude: request.exclude });
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
        // Started elsewhere: the slot stays taken until the owner publishes the thread (3.5.1 step 1, D9).
        if (queued === undefined && thread.ownerDeviceId !== this.#o.deviceId) this.#o.admission.dispatched(projectId, thread.ownerDeviceId, threadId);
        // And a main thread's checkout counts as held until the hub knows the thread, so the next start cannot pick it (D288).
        if (thread.isolation === 'main' && thread.ownerDeviceId !== this.#o.deviceId) {
          this.#mainStarts.set(threadId, { threadId, projectId, deviceId: thread.ownerDeviceId, title: thread.title, until: at + DISPATCH_HOLD_MS });
        }
      } finally { hold?.(); }
      const result = this.#result(thread, { modelLabel: placed.labels.modelLabel, deviceName: placed.labels.deviceName }, false);
      if (request.clientRequestId !== undefined) this.#o.receipts.put(projectId, request.clientRequestId, normalized, threadId, this.#summaryOf(result));
      if (request.createdBy === 'owner') {
        await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'thread-user-message', id: newId('cev', at), at: new Date(at).toISOString(),
          threadId, text: ownerStartedLine(thread.title, threadId, thread.task) });
      }
      // Preparation runs in the background: the start answers within the bridge budget.
      if (queued === undefined && thread.ownerDeviceId === this.#o.deviceId && !request.deferPrepare) void this.runner(threadId)?.prepare();
      if (queued !== undefined && thread.ownerDeviceId !== this.#o.deviceId) this.#remoteQueue.set(projectId, (this.#remoteQueue.get(projectId) ?? new Set()).add(threadId));
      return result;
    });
  }
  /**
   * Main threads this device started on other devices whose hub index has not appeared yet (D288). Once the hub has the index, its
   * held checkouts cover the thread; during a hub outage an entry stays until it expires.
   */
  async pendingMain(projectId: string): Promise<PendingMain[]> {
    const pending: PendingMain[] = []; const now = this.#o.now();
    for (const [threadId, entry] of [...this.#mainStarts]) {
      if (entry.projectId !== projectId) continue;
      const known = entry.until > now && await this.#o.hub.thread(threadId).then((row) => row !== null, (error: unknown) => { if (error instanceof HubUnavailable) return false; throw error; });
      if (entry.until <= now || known) { this.#mainStarts.delete(threadId); continue; }
      pending.push({ threadId, deviceId: entry.deviceId, title: entry.title });
    }
    return pending;
  }
  #summaryOf(result: Pick<StartResult, 'state' | 'stateReason' | 'placement'>): StartedSummary {
    return { state: result.state, ...(result.stateReason === undefined ? {} : { stateReason: result.stateReason }), placement: result.placement };
  }
  async #repeated(threadId: string, started: StartedSummary): Promise<StartResult> {
    const index = (await this.#o.hub.thread(threadId).catch((error: unknown) => { if (error instanceof HubUnavailable) return null; throw error; }))?.document;
    const now = index ? { state: index.state, ...(index.stateReason === undefined ? {} : { stateReason: index.stateReason }) } : { state: started.state, ...(started.stateReason === undefined ? {} : { stateReason: started.stateReason }) };
    return { threadId, ...now, placement: started.placement, repeated: true };
  }
  /**
   * A thread on another device, by its hub index (D265): coordinator tools and answered questions act on it through commands to
   * its owner. A thread this device owns is never read from the hub.
   */
  async #remote(projectId: string, threadId: string): Promise<ThreadIndex> {
    const index = (await this.#o.hub.thread(threadId))?.document;
    if (!index || index.projectId !== projectId || index.ownerDeviceId === this.#o.deviceId) throw refuse(THREAD_NOT_FOUND, 404);
    return index;
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
    if (input.runtimeId != null && input.runtimeId !== placement.runtime) throw refuse(MODEL_SAME_RUNTIME, 409);
    if ([input.runtimeId, input.accountId, input.modelId, input.effort].includes(null)) return this.#resetNextTurn(thread, input);
    const model = input.modelId === undefined ? undefined : (await this.#o.settings()).menu.find((entry) => entry.id === input.modelId);
    if (input.modelId !== undefined && !model) throw refuse(UNKNOWN_PLACEMENT_MODEL, 409);
    if (model && model.runtime !== placement.runtime) throw refuse(MODEL_SAME_RUNTIME, 409);
    const changes: OverrideChange[] = [...(input.runtimeId != null && !placement.fixed.includes('runtime') ? [{ field: 'runtime' as const, from: placement.runtime, to: input.runtimeId }] : []),
      ...(model && (model.id !== placement.modelId || !placement.fixed.includes('model')) ? [{ field: 'model' as const, from: placement.modelId, to: model.id }] : []),
      ...(input.accountId != null && (input.accountId !== placement.accountId || !placement.fixed.includes('account')) ? [{ field: 'account' as const, from: placement.accountId, to: input.accountId }] : []),
      ...(input.effort != null && (input.effort !== placement.effortRequested || !placement.fixed.includes('effort')) ? [{ field: 'effort' as const, from: placement.effortRequested, to: input.effort }] : [])];
    if (!changes.length) return;
    if (model && model.id !== placement.modelId || input.accountId !== undefined) {
      // The model must be able to run this thread where it is: enabled, its runtime able to run threads, an account on this device.
      const project = (await this.#o.projects.get(projectId))?.project; if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
      const refused = await this.#o.placement.refusal({ project, workSettings: await this.#o.admission.settings(projectId), title: thread.title, task: thread.task,
        fixed: { isolation: thread.isolation, modelId: model?.id ?? placement.modelId, runtimeId: placement.runtime, deviceId: thread.ownerDeviceId,
          ...((input.accountId ?? (placement.fixed.includes('account') ? placement.accountId : undefined)) ? { accountId: input.accountId ?? placement.accountId } : {}) }, coordinatorDeviceId: thread.coordinatorDeviceId, ignoreRunningLimit: true,
        exclude: threadId });
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
  /** Null returns a field to Auto; absence leaves its current choice alone. A native thread keeps its runtime until restart. */
  async #resetNextTurn(thread: Thread, input: ThreadOverrideRequest): Promise<void> {
    const current = thread.placement;
    const requested = { runtime: input.runtimeId, account: input.accountId, model: input.modelId, effort: input.effort };
    const previous = { runtime: current.runtime, account: current.accountId, model: current.modelId, effort: current.effortRequested };
    const changes: OverrideChange[] = (Object.keys(requested) as Array<keyof typeof requested>).flatMap((field) => {
      const value = requested[field];
      if (value === undefined || value === null && !current.fixed.includes(field)) return [];
      return value === previous[field] && current.fixed.includes(field) ? [] : [{ field, from: previous[field], to: value ?? 'auto' }];
    });
    if (!changes.length) return;
    const project = (await this.#o.projects.get(thread.projectId))?.project; if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
    const fixed: PlacementFixed = { isolation: thread.isolation, deviceId: thread.ownerDeviceId, runtimeId: current.runtime,
      ...(input.modelId === null ? {} : { modelId: input.modelId ?? current.modelId }), ...(input.effort === null ? {} : { effort: input.effort ?? current.effortRequested }),
      ...(input.accountId === null ? {} : input.accountId !== undefined ? { accountId: input.accountId } : current.fixed.includes('account') ? { accountId: current.accountId } : {}) };
    const chosen = await this.#o.placement.place({ project, workSettings: await this.#o.admission.settings(thread.projectId), title: thread.title, task: thread.task,
      note: input.note, fixed, coordinatorDeviceId: thread.coordinatorDeviceId, ignoreRunningLimit: true, exclude: thread.id });
    if (chosen.kind === 'refused') throw refuse(chosen.message, 409);
    const fields = new Set(current.fixed);
    for (const field of Object.keys(requested) as Array<keyof typeof requested>) {
      if (requested[field] === null) fields.delete(field); else if (requested[field] !== undefined) fields.add(field);
    }
    const placement = { ...chosen.record, fixed: [...fields] };
    const at = this.#o.now(); const note = this.#note(input.note);
    const override = PlacementOverrideSchema.parse({ schema: 'placement-override-v1', id: derivedId('povr', thread.projectId, thread.id, input.clientRequestId), projectId: thread.projectId,
      threadId: thread.id, mode: 'next-turn', changes, ...(note ? { note } : {}), at: this.#at(at) });
    await this.#o.hub.addOverride(override);
    await this.#o.delivery.toCoordinator(thread.projectId, { schema: 'coordinator-event-v1', kind: 'placement-override', id: derivedId('cev', override.id), at: this.#at(at), threadId: thread.id,
      summary: overrideSummary({ changes, note }) });
    await this.#o.delivery.toThreadOwner(thread.projectId, thread.id, thread.ownerDeviceId, { type: 'override-next-turn', override, placement });
  }
  /** The owner applies a next-turn override: the next launch reads the thread's placement, so a running turn keeps its own (D252). */
  async #applyNextTurn(threadId: string, override: PlacementOverride, resolved?: PlacementRecord): Promise<void> {
    const menu = (await this.#o.settings()).menu; const current = this.#o.store.get(threadId)!;
    if (isTerminal(current.state)) throw refuse(THREAD_ENDED, 409);
    const to = (field: OverrideChange['field']) => override.changes.find((change) => change.field === field)?.to;
    const model = menu.find((entry) => entry.id === (resolved?.modelId ?? to('model') ?? current.placement.modelId));
    if (!model) throw refuse(UNKNOWN_PLACEMENT_MODEL, 409);
    const requested = EffortSchema.parse(resolved?.effortRequested ?? to('effort') ?? current.placement.effortRequested);
    const accountId = resolved?.accountId ?? to('account');
    const placement = resolved ?? { ...current.placement, modelId: model.id, model: model.model, effortRequested: requested, effortEffective: mapEffort(requested, model.efforts),
      fixed: [...new Set([...current.placement.fixed, ...override.changes.map((change) => change.field)])], ...(accountId ? { accountId } : {}) };
    if (stableJson(placement) !== stableJson(current.placement)) this.#o.store.update(threadId, (latest) => {
      const next = { ...latest, placement };
      if (accountId !== undefined && accountId !== latest.placement.accountId) delete next.nativeSessionId;
      return next;
    }, { type: 'thread-placement', data: placement });
    this.#o.store.setLabels(threadId, { modelLabel: model.label });
  }
  /**
   * Restart with these choices (brief 10, D252): a new thread with the same title and task and the given fields fixed is placed
   * first, through the start path with a request id derived from this one, so a refusal leaves this thread untouched and a retry
   * finds the same new thread. Then the change is recorded, this thread ends with `Restarted as {newId}.` and its worktree goes,
   * and the coordinator hears both. `coordinatorDeviceId` is the device that starts threads (D9a); when it is another device,
   * `remote` asks it to start the new thread (D266), and this device keeps its own receipt so a retry passes the refusals again.
   */
  async restart(projectId: string, threadId: string, input: ThreadOverrideRequest, coordinatorDeviceId: string, remote?: RemoteStart): Promise<{ newThreadId: string }> {
    const thread = this.#local(projectId, threadId); const placement = thread.placement;
    // Before anything is placed or recorded: no new thread, receipt or override exists for a restart the owner's terminal refused (phase 8).
    if (thread.state === 'attached') throw refuse(attachedRefusal(threadId), 409);
    const fixed: PlacementFixed = { ...(input.isolation ? { isolation: input.isolation } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}), ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.effort ? { effort: input.effort } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}) };
    const clientRequestId = derivedId('treq', 'restart', projectId, threadId, input.clientRequestId);
    // A retry of an applied restart passes the refusals that the restart itself caused.
    if (!this.#o.receipts.get(projectId, clientRequestId, { title: thread.title, task: thread.task, ...fixed })) { const refused = restartRefusal(thread); if (refused) throw refuse(refused, 409); }
    const note = this.#note(input.note);
    // A main thread still holds its checkout until it stops below: its own claim does not count, and the new thread prepares after (D292).
    const settles = thread.isolation === 'main' && !isTerminal(thread.state);
    let started: Pick<StartResult, 'threadId'>;
    if (coordinatorDeviceId === this.#o.deviceId) {
      started = await this.start({ projectId, title: thread.title, task: thread.task, createdBy: 'owner', fixed, note, clientRequestId, coordinatorDeviceId,
        ...(settles ? { exclude: threadId, deferPrepare: true } : {}) });
    }
    else {
      if (!remote) throw refuse(COORDINATOR_ELSEWHERE, 409);
      const created = await remote(projectId, coordinatorDeviceId, { schema: 'thread-create-request-v1', clientRequestId, title: thread.title, task: thread.task, ...fixed, ...(note ? { note } : {}) });
      this.#o.receipts.put(projectId, clientRequestId, { title: thread.title, task: thread.task, ...fixed }, created.threadId, this.#summaryOf(created));
      started = created;
    }
    const changes: OverrideChange[] = [
      ...(fixed.isolation !== undefined && fixed.isolation !== thread.isolation ? [{ field: 'isolation' as const, from: thread.isolation, to: fixed.isolation }] : []),
      ...(fixed.runtimeId !== undefined && fixed.runtimeId !== placement.runtime ? [{ field: 'runtime' as const, from: placement.runtime, to: fixed.runtimeId }] : []),
      ...(fixed.accountId !== undefined && fixed.accountId !== placement.accountId ? [{ field: 'account' as const, from: placement.accountId, to: fixed.accountId }] : []),
      ...(fixed.modelId !== undefined && fixed.modelId !== placement.modelId ? [{ field: 'model' as const, from: placement.modelId, to: fixed.modelId }] : []),
      ...(fixed.effort !== undefined && fixed.effort !== placement.effortRequested ? [{ field: 'effort' as const, from: placement.effortRequested, to: fixed.effort }] : []),
      ...(fixed.deviceId !== undefined && fixed.deviceId !== thread.ownerDeviceId ? [{ field: 'device' as const, from: thread.ownerDeviceId, to: fixed.deviceId }] : [])];
    const id = derivedId('povr', projectId, threadId, input.clientRequestId); const at = this.#at(this.#o.now());
    if (changes.length) await this.#o.hub.addOverride(PlacementOverrideSchema.parse({ schema: 'placement-override-v1', id, projectId, threadId, mode: 'restart', changes, ...(note ? { note } : {}), at }));
    await this.runner(threadId)!.restarted(restartedReason(started.threadId));
    // The old thread gave the checkout back: a new thread waiting here prepares now (a repeat finds it past preparing and changes nothing).
    if (settles && this.#o.store.get(started.threadId)?.state === 'preparing') void this.runner(started.threadId)?.prepare();
    await this.#o.delivery.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'placement-override', id: derivedId('cev', id), at, threadId,
      summary: overrideSummary({ changes, note, restartedAs: started.threadId }) });
    return { newThreadId: started.threadId };
  }
  /**
   * The coordinator's queue sweep (D9a): the project's `queued` threads, here and on other devices (their hub indexes), start in
   * creation order as slots free; a full device is skipped, a full project ends the sweep. Only the coordinator device sweeps
   * (any device before an assignment, which then holds only its own threads); a thread elsewhere gets a `dispatch` command
   * once, counted until its owner publishes it (D264).
   */
  sweepQueue(projectId: string): Promise<void> {
    if (!this.#started || this.#closed) return Promise.resolve();
    return this.#exclusive(projectId, async () => {
      const queued = await this.#queued(projectId); if (!queued.length || !(await this.#coordinatesHere(projectId))) return;
      const full = new Set<string>();
      for (const thread of queued) {
        if (this.#closed) return;
        if (full.has(thread.ownerDeviceId) || (!thread.local && this.#o.admission.isDispatched(thread.id))) continue;
        const admitted = await this.#o.admission.admit(projectId, thread.ownerDeviceId, thread.id);
        if (!admitted.ok) { if (admitted.scope === 'project') return; full.add(thread.ownerDeviceId); continue; }
        if (!thread.local) {
          this.#o.admission.dispatched(projectId, thread.ownerDeviceId, thread.id); admitted.release();
          await this.#o.delivery.toThreadOwner(projectId, thread.id, thread.ownerDeviceId, { type: 'dispatch' }, derivedId('tcmd', 'dispatch', projectId, thread.id));
          continue;
        }
        const runner = this.runner(thread.id);
        if (runner) void runner.prepare(admitted.release); else admitted.release();
      }
    });
  }
  /**
   * Queued threads of the project, oldest first: this device's from its files, the others' from the hub, read only while some may
   * wait there (none while the hub is unreachable), so an idle sweep costs no hub request.
   */
  async #queued(projectId: string): Promise<Queued[]> {
    const local = this.#o.store.list(projectId).filter((thread) => thread.state === 'queued')
      .map((thread): Queued => ({ id: thread.id, ownerDeviceId: thread.ownerDeviceId, createdAt: thread.createdAt, local: true }));
    const remote: Queued[] = []; const sent = this.#remoteQueue.get(projectId);
    if (!sent) return local;
    try {
      let after: string | undefined;
      do {
        const page = await this.#o.hub.threads(projectId, after);
        for (const index of page.records) {
          if (index.projectId !== projectId) continue;
          if (index.state !== 'queued') sent.delete(index.id);
          else if (index.ownerDeviceId !== this.#o.deviceId && !this.#o.store.get(index.id)) remote.push({ id: index.id, ownerDeviceId: index.ownerDeviceId, createdAt: index.createdAt, local: false });
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
      // A start whose index has not appeared yet keeps the project read.
      if (!remote.length && !sent.size) this.#remoteQueue.delete(projectId);
    } catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
    return [...local, ...remote].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  /** This device holds the project's coordinator, or none is assigned yet; false while the hub is unreachable. */
  async #coordinatesHere(projectId: string): Promise<boolean> {
    try { const assigned = (await this.#o.hub.coordinator(projectId))?.document.deviceId; return assigned === undefined || assigned === this.#o.deviceId; }
    catch (error) { if (error instanceof HubUnavailable) return false; throw error; }
  }
  /** Threads at rest whose next turn waits for a slot (D9) or for the hub (D273), oldest queued message first. */
  async sweepWaiting(): Promise<void> {
    if (!this.#started || this.#closed) return;
    // Also threads whose turn waits for an account a terminal holds (phase 8), or for their claimed checkout to be back on main (P8 review
    // TH-1), with its messages or the turn it kept.
    const waiting = this.#o.store.all().filter((thread) => REST_STATES.includes(thread.state)
      && (isWaitingForSlot(thread.stateReason) || thread.stateReason === WAITING_FOR_HUB || isWaitingForAccount(thread.stateReason) || thread.stateReason === WAITING_FOR_MAIN)
      && (thread.queuedMessages.length || this.#o.store.local(thread.id).pendingTurn))
      .sort((a, b) => oldestMessage(a).localeCompare(oldestMessage(b)));
    for (const thread of waiting) { if (this.#closed) return; await this.runner(thread.id)?.resume(); }
  }
  /**
   * The sweeps (the periodic timer and `pulse`): the queue of every project with queued threads here or a coordinator here, threads
   * waiting for a slot, the hub or an account, questions waiting on a coordinator whose device is away (D280), and kept main checkout
   * claims (D291, phase 8).
   */
  async sweep(): Promise<void> {
    const paths = this.#o.store.paths;
    const projects = new Set([...this.#o.store.all().filter((thread) => thread.state === 'queued').map((thread) => thread.projectId),
      ...paths.projectIds().filter((projectId) => existsSync(paths.coordinator(projectId)))]);
    for (const projectId of projects) await this.sweepQueue(projectId);
    await this.sweepWaiting();
    for (const projectId of new Set(this.#o.store.all().filter((thread) => this.#unasked(thread)).map((thread) => thread.projectId))) {
      if (this.#closed) return;
      await this.askDirectly(projectId).catch(() => undefined);
    }
    // Last, so a slow settlement (a process to end, an unreachable hub, the activity scan) never delays dispatch (phase 8).
    await this.settleCheckouts();
  }
  /**
   * Ended main threads here whose checkout claim was kept (D291) settle it again, at every sweep until it is released (phase 8). Each
   * runs on its thread's chain; a failure stays on the thread (its notice and the thread page line), never in the sweep.
   */
  async settleCheckouts(): Promise<void> {
    for (const thread of this.#o.store.all()) {
      if (this.#closed) return;
      if (!isTerminal(thread.state) || !this.#o.store.local(thread.id).unsettledCheckout) continue;
      await this.runner(thread.id)?.settleCheckout().catch(() => undefined);
    }
  }
  /** A local thread waits on a needs-decision report whose question this device has not asked the owner itself. */
  #unasked(thread: Thread): boolean {
    return thread.state === 'waiting-for-you' && thread.lastReport?.status === 'needs-decision' && this.#o.store.local(thread.id).decisionReport?.asked === false;
  }
  /**
   * Decision 7 on the thread's owner device (D280): while the coordinator's device is away (D80: left the mesh, revoked, or no
   * heartbeat for 10 minutes) it cannot take a needs-decision report, so this device turns each such report its threads wait on into
   * the owner's question, under the id the coordinator's own fallback uses for that report (D195): neither side ever asks twice, and
   * the coordinator that later receives the report reads it as asked (D32). Runs for a new report (`now`) and at the sweeps, at most
   * every `fallbackCheckMs` per project; a project without such a report reads nothing. Hub errors reach the caller.
   */
  async askDirectly(projectId: string, now = false): Promise<void> {
    const waiting = this.#o.store.list(projectId).filter((thread) => this.#unasked(thread));
    if (!waiting.length || this.#closed) return;
    const at = this.#o.now(); const last = this.#checked.get(projectId);
    if (!now && last !== undefined && at - last < this.#o.fallbackCheckMs) return;
    this.#checked.set(projectId, at);
    const assigned = (await this.#o.hub.coordinator(projectId))?.document.deviceId;
    if (assigned === undefined || assigned === this.#o.deviceId) return;
    if (!deviceAway((await this.#o.roster()).devices.find((view) => view.device.id === assigned))) return;
    const events: CoordinatorEvent[] = waiting.flatMap((thread) => {
      const report = this.#o.store.local(thread.id).decisionReport;
      return report && thread.lastReport ? [{ schema: 'coordinator-event-v1', kind: 'thread-report', id: report.eventId, at: report.at, threadId: thread.id, report: thread.lastReport }] : [];
    });
    const covered = new Set(await this.#o.decisions.fallbackFromReports(projectId, events));
    for (const thread of waiting) {
      this.#o.store.updateLocal(thread.id, (local) => local.decisionReport && covered.has(local.decisionReport.eventId) ? { ...local, decisionReport: { ...local.decisionReport, asked: true } } : local);
    }
  }
  /** Work on another device rested (a relayed coordinator event): sweep the project's queue soon (D264). */
  freed(projectId: string): void { this.#rested(projectId); }
  /** The coordinator moved here (3.5.3): the project's queued threads on other devices are read at its next sweep, which runs soon (D264). */
  coordinating(projectId: string): void {
    if (!this.#remoteQueue.has(projectId)) this.#remoteQueue.set(projectId, new Set());
    this.#rested(projectId);
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
    if (!this.#o.store.get(threadId)) return this.#remoteMessage(projectId, threadId, from, text, interrupt, clientMessageId);
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
  /**
   * A message for a thread on another device (D265): the sender rules against its hub index, then a command its owner applies
   * once per message id, where an owner message also tells the coordinator. It waits until the owner runs it, so it is never
   * `started`; `interrupting` when the thread runs a turn and the sender asked to interrupt.
   */
  async #remoteMessage(projectId: string, threadId: string, from: 'coordinator' | 'owner', text: string, interrupt: boolean, clientMessageId?: string): Promise<{ delivery: 'queued' | 'interrupting'; state: ThreadState; repeated: boolean }> {
    const index = await this.#remote(projectId, threadId);
    if (from === 'coordinator' && index.state === 'attached') throw refuse(THREAD_ATTACHED, 409);
    if (isTerminal(index.state)) throw refuse(THREAD_ENDED, 409);
    const at = this.#o.now();
    const message: QueuedMessage = { id: clientMessageId ?? newId('tmsg', at), from, text: this.#o.redactor.text(text), at: new Date(at).toISOString(), interrupt };
    await this.#o.delivery.toThreadOwner(projectId, threadId, index.ownerDeviceId, { type: 'message', message }, derivedId('tcmd', 'message', projectId, threadId, message.id));
    return { delivery: interrupt && index.state === 'running' ? 'interrupting' : 'queued', state: index.state, repeated: false };
  }
  /**
   * Stop (brief 8.2): `notify` for a stop by the owner (D28); a coordinator stop sends nothing. A thread on another device gets a
   * command (`commandId` repeats a retried stop); an ended one is left alone.
   */
  async stop(projectId: string, threadId: string, reason: string, notify: boolean, commandId?: string): Promise<void> {
    if (!this.#o.store.get(threadId)) {
      const index = await this.#remote(projectId, threadId); if (isTerminal(index.state)) return;
      // Its owner would refuse it as well; an attach after this read makes the owner drop the command with the same refusal (phase 8).
      if (index.state === 'attached') throw refuse(attachedRefusal(threadId), 409);
      await this.#o.delivery.toThreadOwner(projectId, threadId, index.ownerDeviceId, { type: 'stop', reason, notify }, commandId);
      return;
    }
    this.#local(projectId, threadId); await this.runner(threadId)!.stop(reason, notify);
  }
  /**
   * Why a stop is refused now (phase 8): the thread is attached in a terminal, by its file here or its hub index elsewhere. The turn-limit
   * question checks it before the answer is recorded, so a refused Stop leaves the question open. Unknown during a hub outage.
   */
  async stopRefusal(projectId: string, threadId: string): Promise<string | undefined> {
    const local = this.#o.store.get(threadId);
    let state: ThreadState | undefined = local?.projectId === projectId ? local.state : undefined;
    if (!local) {
      try { const index = (await this.#o.hub.thread(threadId))?.document; state = index?.projectId === projectId ? index.state : undefined; }
      catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
    }
    return state === 'attached' ? attachedRefusal(threadId) : undefined;
  }
  async discard(projectId: string, threadId: string): Promise<void> { this.#local(projectId, threadId); await this.runner(threadId)!.discard(); }
  /** Allow 10 more turns; a thread on another device gets a command (`commandId` repeats a retried answer, D265). */
  async allowTurns(projectId: string, threadId: string, commandId?: string): Promise<void> {
    if (!this.#o.store.get(threadId)) {
      const index = await this.#remote(projectId, threadId);
      await this.#o.delivery.toThreadOwner(projectId, threadId, index.ownerDeviceId, { type: 'allow-turns' }, commandId);
      return;
    }
    this.#local(projectId, threadId); await this.runner(threadId)!.allowTurns();
  }
  /**
   * A command for a local thread (the local branch of `Delivery.toThreadOwner`, and the inbox's relayed commands). A message
   * passes the sender rules and, from the owner, reaches the coordinator like any owner message.
   */
  async command(projectId: string, threadId: string, command: ThreadCommand): Promise<void> {
    const thread = this.#local(projectId, threadId); const runner = this.runner(threadId)!;
    switch (command.type) {
      case 'dispatch': await runner.prepare(); return;
      case 'message': { const { from, text, interrupt, id } = command.message; await this.message(projectId, threadId, from, text, interrupt, id); return; }
      case 'stop': await runner.stop(command.reason, command.notify ?? false); return;
      case 'discard': await runner.discard(); return;
      case 'allow-turns': await runner.allowTurns(); return;
      case 'override-next-turn': await this.#applyNextTurn(thread.id, command.override, command.placement); return;
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
