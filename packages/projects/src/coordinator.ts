import {
  CoordinatorEventSchema, mapEffort, type Account, type AccountStatus, type Configuration, type CoordinatorEvent, type CoordinatorState, type Effort, type ModelOption,
  type ProjectHub, type ProjectLedgerEvent, type ProjectWorkSettings, type SecretRedactor,
} from '@jevellan/core';
import { modelCandidates, type RuntimeSupport } from '@jevellan/decisions';
import { MESSAGE_ID_REUSED, noCoordinatorAccount, noCoordinatorModel } from './copy.js';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import type { CoordinatorStore } from './stores.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const status = (error: unknown) => (error as { status?: unknown } | undefined)?.status;

export type CoordinatorRuntime = RuntimeSupport & { turns: boolean };
export type CoordinatorPlan = { kind: 'ready'; model: ModelOption; effort: Effort; account: Account } | { kind: 'unavailable'; reason: string };
/**
 * The model, effort and account a fresh coordinator session would use on this device (brief 5.1, 8.1; D91, D97): the
 * settings model, or the first menu entry in menu order that is enabled, whose runtime is enabled and runs read-only
 * turns with MCP, and that has an eligible account here. The coordinator's turn loop (phase 2) and the chip use it.
 */
export function coordinatorPlan(input: { work: Pick<ProjectWorkSettings, 'coordinator'>; settings: Configuration['x-jevellan'];
  runtimes: ReadonlyMap<string, CoordinatorRuntime>; accounts: Account[]; statuses: AccountStatus[]; deviceId: string; deviceName: string; now?: number }): CoordinatorPlan {
  const pinned = input.work.coordinator.modelId;
  const candidates = modelCandidates({ settings: input.settings, action: 'reply', runtimes: input.runtimes, accounts: input.accounts, statuses: input.statuses,
    deviceId: input.deviceId, ...(input.now === undefined ? {} : { now: input.now }) })
    .filter((candidate) => input.runtimes.get(candidate.model.runtime)?.turns && !candidate.model.unavailableReason && (pinned === null || candidate.model.id === pinned));
  if (!candidates.length) return { kind: 'unavailable', reason: noCoordinatorModel(input.deviceName) };
  const ready = candidates.find((candidate) => !candidate.reason);
  const account = ready?.ranking.find((entry) => entry.eligible)?.account;
  if (!ready || !account) return { kind: 'unavailable', reason: noCoordinatorAccount(input.deviceName) };
  return { kind: 'ready', model: ready.model, effort: mapEffort(input.work.coordinator.effort, ready.model.efforts), account };
}

/**
 * One project's coordinator on its device (brief 8.1). Phase 1 keeps the event queue only: events are flushed to
 * coordinator.json before they are acknowledged, recorded in the coordinator ledger when received (D2a), and deduplicated
 * by event id and, for owner messages, by clientMessageId. The turn loop arrives in phase 2.
 */
export class Coordinator {
  #seen: { events: Set<string>; messages: Map<string, string> } | undefined;
  constructor(readonly projectId: string, private readonly o: { store: CoordinatorStore; ledger: ProjectLedger; redactor: SecretRedactor }) {}
  /** Event ids and owner message ids already received, from the ledger (built once, then kept current). */
  #history(): { events: Set<string>; messages: Map<string, string> } {
    if (this.#seen) return this.#seen;
    const seen = { events: new Set<string>(), messages: new Map<string, string>() };
    for (const event of this.o.ledger.events()) {
      if (event.type !== 'coordinator-event') continue;
      const data = this.o.ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' });
      seen.events.add(data.id); if (data.kind === 'user-message') seen.messages.set(data.clientMessageId, data.text);
    }
    return this.#seen = seen;
  }
  /**
   * Appends to the queue (synchronously flushed) and records the event. A known event id repeats; an owner message id
   * reused for different text is refused (409).
   */
  enqueue(raw: CoordinatorEvent): { repeated: boolean } {
    const event = CoordinatorEventSchema.parse(this.o.redactor.document(raw));
    const history = this.#history(); const queue = this.o.store.get(this.projectId).queue;
    if (history.events.has(event.id) || queue.some((queued) => queued.id === event.id)) return { repeated: true };
    if (event.kind === 'user-message') {
      const queued = queue.find((entry): entry is typeof event => entry.kind === 'user-message' && entry.clientMessageId === event.clientMessageId);
      const prior = history.messages.get(event.clientMessageId) ?? queued?.text;
      if (prior !== undefined) { if (prior === event.text) return { repeated: true }; throw refuse(MESSAGE_ID_REUSED, 409); }
    }
    this.o.store.update(this.projectId, (state) => ({ ...state, queue: [...state.queue, event] }));
    this.record(event);
    this.kick();
    return { repeated: false };
  }
  /** The ledger record of a received event (also used by recovery for queued events whose record a crash lost). */
  record(event: CoordinatorEvent): void {
    this.o.ledger.append({ type: 'coordinator-event', data: event });
    const history = this.#history(); history.events.add(event.id);
    if (event.kind === 'user-message') history.messages.set(event.clientMessageId, event.text);
  }
  /** Startup (2.6.13 step 6): queued events whose ledger record a crash lost get one. Returns how many. */
  reconcile(): number {
    const history = this.#history(); let added = 0;
    for (const event of this.o.store.get(this.projectId).queue) if (!history.events.has(event.id)) { this.record(event); added += 1; }
    return added;
  }
  /** Phase 2 schedules a turn here; in phase 1 events wait in the queue. */
  kick(): void { /* The turn loop arrives in phase 2. */ }
  state(): CoordinatorState { return this.o.store.get(this.projectId); }
  /** Decision fallback (decision 7): the coordinator cannot run or failed twice in a row. */
  fallbackActive(): boolean { const state = this.state(); return state.state === 'unavailable' || state.failedTurnsInARow >= 2; }
  /** Fresh coordinator session: the next turn starts without resuming (brief 8.1, D77). */
  fresh(): void { this.o.store.update(this.projectId, (state) => ({ ...state, session: null })); }
}

/** The coordinators this device holds, and the hub assignment (D6). */
export class CoordinatorService {
  readonly #coordinators = new Map<string, Coordinator>();
  readonly #assigning = new Map<string, Promise<string>>();
  constructor(private readonly o: { store: CoordinatorStore; ledgers: ProjectLedgers; hub: Pick<ProjectHub, 'coordinator' | 'assignCoordinator'>; deviceId: string; redactor: SecretRedactor }) {}
  get store(): CoordinatorStore { return this.o.store; }
  get(projectId: string): Coordinator {
    let coordinator = this.#coordinators.get(projectId);
    if (!coordinator) { coordinator = new Coordinator(projectId, { store: this.o.store, ledger: this.o.ledgers.coordinator(projectId), redactor: this.o.redactor }); this.#coordinators.set(projectId, coordinator); }
    return coordinator;
  }
  /** The assigned coordinator device, or null before the first message or thread. */
  async deviceOf(projectId: string): Promise<string | null> { return (await this.o.hub.coordinator(projectId))?.document.deviceId ?? null; }
  /**
   * Assigns this device when no coordinator exists yet (compare-and-swap on revision 0; a lost race reads the winner) and
   * returns the coordinator device. Concurrent calls for one project share one assignment.
   */
  ensureAssigned(projectId: string): Promise<string> {
    const running = this.#assigning.get(projectId); if (running) return running;
    const task = (async () => {
      const current = await this.deviceOf(projectId); if (current) return current;
      try { return (await this.o.hub.assignCoordinator(projectId, this.o.deviceId, 0)).document.deviceId; }
      catch (error) {
        if (status(error) !== 409) throw error;
        const winner = await this.deviceOf(projectId); if (!winner) throw error;
        return winner;
      }
    })().finally(() => { this.#assigning.delete(projectId); });
    this.#assigning.set(projectId, task);
    return task;
  }
}
