import { existsSync } from 'node:fs';
import type { AccountService } from '@jevellan/accounts';
import {
  CoordinatorEventSchema, CoordinatorStateSchema, HubUnavailable, ProjectCoordinatorStatusSchema, boundedRedaction, coordinatorMovable, isTerminal, mapEffort, resolveProjectPath, type Account,
  type AccountStatus, type Configuration, type CoordinatorEvent, type CoordinatorState, type Effort, type ModelOption, type Project, type ProjectDecision, type ProjectHub,
  type ProjectLedgerEvent, type ProjectRequestOutcome, type ProjectWorkSettings, type SecretRedactor, type ThreadIndex,
} from '@jevellan/core';
import { modelCandidates, projectOutcomeInstruction, type RuntimeSupport } from '@jevellan/decisions';
import { SESSION_NOT_FOUND, type RuntimeAdapter } from '@jevellan/runtime-contract';
import { ProjectTools, type ProjectScope, type ProjectToolHandlers } from './bridge-tools.js';
import {
  COORDINATOR_PROCESS_UNCONFIRMED, MESSAGE_ID_REUSED, TURN_FAILED, activeThreadLine, coordinatorAccountMovedNotice, coordinatorFailedTwiceNotice, coordinatorMovedNotice, coordinatorSystemAppend,
  coordinatorTurnTimedOut, coordinatorUnavailableNotice, coordinatorWorking, eventBlock, eventLine, freshContext, coordinatorWaitsForAccount, noCoordinatorAccount, noCoordinatorModel, openQuestionLine,
  recentConversation,
} from './copy.js';
import { derivedId, type DecisionItems } from './decision-items.js';
import { firstLine } from './git.js';
import type { LaunchResult, TurnLauncher } from './launch.js';
import type { ProjectLedger, ProjectLedgers } from './ledger.js';
import type { DeviceRoster } from './placement.js';
import type { CoordinatorStore } from './stores.js';
import { TurnExecution, type TurnOutcome } from './turn-execution.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const status = (error: unknown) => (error as { status?: unknown } | undefined)?.status;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export type CoordinatorRuntime = RuntimeSupport & { turns: boolean };
export type CoordinatorPlan = { kind: 'ready'; model: ModelOption; effort: Effort; account: Account } | { kind: 'unavailable'; reason: string };
/**
 * The model, effort and account a fresh coordinator session would use on this device (brief 5.1, 8.1; D91, D97): the
 * settings model, or the first menu entry in menu order that is enabled, whose runtime is enabled and runs read-only
 * turns with MCP, and that has an eligible account here. The coordinator's turn loop and the chip use it.
 */
export function coordinatorPlan(input: { work: Pick<ProjectWorkSettings, 'coordinator'>; settings: Configuration['x-jevellan'];
  runtimes: ReadonlyMap<string, CoordinatorRuntime>; accounts: Account[]; statuses: AccountStatus[]; deviceId: string; deviceName: string; now?: number;
  /** Accounts held by threads attached in a terminal here (phase 8): the model stays, another free account runs it, else the plan waits. */
  held?: ReadonlySet<string> | undefined }): CoordinatorPlan {
  const pinned = input.work.coordinator.modelId;
  const candidates = modelCandidates({ settings: input.settings, action: 'reply', runtimes: input.runtimes, accounts: input.accounts, statuses: input.statuses,
    deviceId: input.deviceId, selection: { runtimeId: input.work.coordinator.runtimeId ?? undefined, accountId: input.work.coordinator.accountId ?? undefined }, ...(input.now === undefined ? {} : { now: input.now }) })
    .filter((candidate) => input.runtimes.get(candidate.model.runtime)?.turns && !candidate.model.unavailableReason && (pinned === null || candidate.model.id === pinned));
  if (!candidates.length) return { kind: 'unavailable', reason: noCoordinatorModel(input.deviceName) };
  const ready = candidates.find((candidate) => !candidate.reason);
  const account = ready?.ranking.find((entry) => entry.eligible && !input.held?.has(entry.account.id))?.account;
  if (!ready || !account) {
    const taken = ready?.ranking.find((entry) => entry.eligible)?.account;
    return { kind: 'unavailable', reason: taken ? coordinatorWaitsForAccount(taken.label) : noCoordinatorAccount(input.deviceName) };
  }
  return { kind: 'ready', model: ready.model, effort: mapEffort(input.work.coordinator.effort, ready.model.efforts), account };
}

type CoordinatorSession = NonNullable<CoordinatorState['session']>;
/** A coordinator session rotates after this many turns (brief 8.1). */
export const COORDINATOR_SESSION_TURNS = 40;
/**
 * Whether the stored session carries on (brief 8.1, D77). `current` is the plan with the session's own model pinned, so a
 * null settings model keeps a session whose model still runs here instead of following every eligibility change. The
 * session rotates at 40 turns, when a pinned model differs, when the settings effort maps to another effort on the session
 * model, or when the session model cannot run here any more. An ineligible account is the launcher's rule (D16).
 */
export function keepSession(session: CoordinatorSession, pinned: string | null, current: CoordinatorPlan): boolean {
  return session.turns < COORDINATOR_SESSION_TURNS && (pinned === null || pinned === session.modelId) && current.kind === 'ready' && current.model.id === session.modelId
    && current.model.runtime === session.runtime && current.model.model === session.model && current.effort === session.effort;
}

/**
 * Whether the coordinator may move away from a device (brief phase 5, 3.5.3, D269): a core rule since the hub applies it in the move's
 * own transaction (D283). The work view's `canMoveHere` and the move route use it too, so the menu item and the refusal never disagree.
 */
export { coordinatorMovable };

/** Everything a coordinator prompt is built from; read before launch, because the launcher builds the prompt synchronously. */
export type CoordinatorPromptInput = {
  /** The batch this turn delivers, in arrival order. */
  events: readonly CoordinatorEvent[];
  outcomes?: readonly ProjectRequestOutcome[];
  notebook: string | null;
  /** The project's thread indexes; concluded ones are not listed as active. */
  threads: readonly ThreadIndex[];
  /** The project's questions; only unanswered, unwithdrawn ones are listed. */
  decisions: readonly ProjectDecision[];
  /** Owner messages (with their event id) and coordinator replies from the ledger, oldest first. */
  history: ReadonlyArray<{ from: 'owner' | 'coordinator'; text: string; eventId?: string | undefined }>;
  /** The runtime adapter's display name (D83). */
  runtimeName(runtime: string): string;
  deviceName(deviceId: string): string;
  /** The base branch detected in the coordinator's checkout (D93). */
  base: string;
  /** Report events the fallback already turned into owner questions (D32). */
  askedDirectly: ReadonlySet<string>;
  clock?: ((at: string) => string) | undefined;
};
/** Brief 9.3: one line block per event; titles come from the indexes. */
export function coordinatorEventBlock(input: CoordinatorPromptInput): string {
  const titles = new Map(input.threads.map((thread) => [thread.id, thread.title]));
  return eventBlock(input.events.map((event) => eventLine(event, { title: (id) => titles.get(id), base: input.base, askedDirectly: input.askedDirectly.has(event.id), clock: input.clock })));
}
/** Brief 9.2 for a new session. The recap leaves out the batch being delivered, which follows as events (D36). */
export function coordinatorFreshContext(input: CoordinatorPromptInput): string {
  const batch = new Set(input.events.map((event) => event.id));
  return freshContext({
    notebook: input.notebook,
    threads: input.threads.filter((thread) => !isTerminal(thread.state)).map((thread) => activeThreadLine({ title: thread.title, id: thread.id, state: thread.state,
      isolation: thread.isolation, runtime: input.runtimeName(thread.runtime), modelLabel: thread.modelLabel, effort: thread.effort, deviceName: input.deviceName(thread.ownerDeviceId),
      pr: thread.pr ? { number: thread.pr.number, checks: thread.pr.checks } : undefined, lastSummary: thread.lastSummary })),
    questions: input.decisions.filter((decision) => !decision.answer && !decision.withdrawnAt).map((decision) => openQuestionLine(decision.question)),
    recent: recentConversation(input.history.filter((item) => item.eventId === undefined || !batch.has(item.eventId))),
  });
}
/** The turn prompt (brief 8.1): a session that is not resumed gets the fresh context first, then the event block. */
export function coordinatorPrompt(input: CoordinatorPromptInput, resumed: boolean): string {
  const goals = input.outcomes?.filter(outcome => outcome.source === 'jev').map(outcome => `Requested result for ${outcome.eventId} (${outcome.source}): ${projectOutcomeInstruction(outcome)}`).join('\n');
  const block = coordinatorEventBlock(input) + (goals ? `\n\n${goals}\nCarry this result into the thread task and check the report against it before concluding.` : '');
  return resumed ? block : `${coordinatorFreshContext(input)}\n\n${block}`;
}

/** Coordinator tools without the scope check, which the coordinator owns (the tools themselves arrive with their handlers). */
export type CoordinatorToolHandlers = Omit<ProjectToolHandlers, 'isCurrent'>;
export type CoordinatorTimers = { startMs: number; retryMs: number; turnTimeoutMs: number };
export type CoordinatorContext = {
  deviceId: string; deviceName: string; redactor: SecretRedactor;
  store: CoordinatorStore; ledgers: ProjectLedgers;
  hub: Pick<ProjectHub, 'coordinator' | 'assignCoordinator' | 'coordinatorStatus' | 'putCoordinatorStatus' | 'notebook' | 'threads' | 'decisions'>;
  project(projectId: string): Promise<Project>;
  /** Work settings (the hub copy, or the last good one during an outage). */
  workSettings(projectId: string): Promise<ProjectWorkSettings>;
  settings(): Promise<Configuration['x-jevellan']>;
  accounts: Pick<AccountService, 'list' | 'recordUsage' | 'recordError'>;
  runtimes: ReadonlyMap<string, RuntimeAdapter>;
  launcher: Pick<TurnLauncher, 'launch'>;
  /** Accounts held by threads attached in a terminal here (phase 8); coordinator turns wait for them as `Unavailable`, never as failures. */
  heldAccounts?(): ReadonlySet<string>;
  decisions: Pick<DecisionItems, 'fallbackFromReports'>;
  /** Bound after construction: the thread service is built later. */
  tools(): CoordinatorToolHandlers;
  outcome?(projectId: string, event: Extract<CoordinatorEvent, { kind: 'user-message' }>, history: string, signal: AbortSignal): Promise<ProjectRequestOutcome>;
  /**
   * Bound after construction (the outbox is built later): sends events to the project's coordinator device through the hub relay,
   * durably and under their own ids, which the new coordinator dedupes (3.5.4). `handover` is the revision of the assignment the
   * handover follows (P8 review RL-1): an event that comes back after a later move travels in an envelope its receiver has not seen.
   */
  forward(projectId: string, events: readonly CoordinatorEvent[], handover?: string): void;
  roster(): Promise<DeviceRoster>;
  /** `origin/HEAD` of the project checkout here, else `main` (D93). */
  baseBranch(project: Project): Promise<string>;
  enterOperation(id: string, title: string): () => void;
  timers: CoordinatorTimers;
  now(): number;
};
/** What a turn attempt leaves: run again now, retry after the delay, postpone (hub unreachable, D76), or wait for an event. */
type TurnEnd = 'continue' | 'retry' | 'postpone' | 'wait';
type Prepared = { kind: 'unavailable'; reason: string } | {
  kind: 'ready'; project: Project; cwd: string; model: ModelOption; effort: Effort; accountId: string; requiredAccountId?: string; session: CoordinatorSession | null; prompt: CoordinatorPromptInput;
};
const withoutReason = (state: CoordinatorState): CoordinatorState => { const next = { ...state }; delete next.unavailableReason; return next; };
type PlanInput = Omit<Parameters<typeof coordinatorPlan>[0], 'work'>;
type Readiness = { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; project: Project; cwd: string; plan: Extract<CoordinatorPlan, { kind: 'ready' }>; input: PlanInput; work: ProjectWorkSettings };
/**
 * Whether the coordinator can run on this device (brief 8.1; D34, D97): a model whose runtime runs read-only turns with an eligible
 * account here (the plan), and the project's checkout here. Every turn checks it, and so does Move coordinator here before it
 * assigns this device (D282), so a move never lands on a device where the coordinator could only read `Unavailable`.
 */
async function coordinatorReadiness(c: CoordinatorContext, projectId: string, held?: ReadonlySet<string>): Promise<Readiness> {
  const project = await c.project(projectId);
  const [settings, work, accounts] = await Promise.all([c.settings(), c.workSettings(projectId), c.accounts.list()]);
  const input: PlanInput = { settings, runtimes: new Map([...c.runtimes].map(([id, adapter]) => [id, adapter.capabilities])), accounts: accounts.map((view) => view.account),
    statuses: accounts.flatMap((view) => view.statuses), deviceId: c.deviceId, deviceName: c.deviceName, now: c.now(), held };
  const plan = coordinatorPlan({ ...input, work });
  if (plan.kind === 'unavailable') return plan;
  try { return { kind: 'ready', project, cwd: resolveProjectPath(project, c.deviceId, c.deviceName), plan, input, work }; }
  catch (error) { return { kind: 'unavailable', reason: messageOf(error) }; }
}

/**
 * One project's coordinator on its device (brief 8.1). Events are flushed to coordinator.json before they are acknowledged,
 * recorded in the coordinator ledger when received (D2a), and deduplicated by event id and, for owner messages, by
 * clientMessageId. When this device holds the assignment, a turn starts shortly after an event; one turn runs at a time, events
 * arriving meanwhile go together in the next turn, and the loop runs until the queue is empty. Turns are read-only, resume the
 * session until it rotates, retry once after a failure, and after two failures in a row wait for the owner's next message
 * with the thread fallback active (decision 7). Nothing runs before `begin()`, which follows startup recovery (brief 8.6).
 */
export class Coordinator {
  #seen: { events: Set<string>; messages: Map<string, string> } | undefined;
  #started = false;
  #closed = false;
  /** This device lost the assignment and handed the queue over (3.5.4): no turn starts here any more. */
  #moved = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  /** An event arrived while a turn was being evaluated or ran. */
  #again = false;
  /** An owner message arrived since the last turn launched: after two failures only this tries again. */
  #ownerRetry = false;
  #stopping = false;
  #scope: ProjectScope | undefined;
  #execution: TurnExecution | undefined;
  /** Bumped by Fresh, so a turn in flight never writes its session back. */
  #generation = 0;
  #publishing: Promise<void> = Promise.resolve();
  /** The last status write did not reach the hub (an outage, not a refusal): the sweep writes the current state again (P8 review C-2). */
  #statusDirty = false;
  #outcomeAbort = new AbortController();
  #fallbacks: Promise<void> = Promise.resolve();
  readonly #tasks = new Set<Promise<unknown>>();
  #base: Promise<string> | undefined;
  constructor(readonly projectId: string, private readonly c: CoordinatorContext) {}
  get #ledger(): ProjectLedger { return this.c.ledgers.coordinator(this.projectId); }
  #at(): string { return new Date(this.c.now()).toISOString(); }
  #track(task: Promise<unknown>): void { this.#tasks.add(task); void task.finally(() => { this.#tasks.delete(task); }); }
  /**
   * Event ids and owner message ids already received, from the ledger (built once, then kept current). Events this device handed
   * over when the coordinator moved away no longer count, so they are taken again if the coordinator returns before they were
   * delivered elsewhere (D271).
   */
  #history(): { events: Set<string>; messages: Map<string, string> } {
    if (this.#seen) return this.#seen;
    const seen = { events: new Set<string>(), messages: new Map<string, string>() };
    const forwarded = new Set(this.c.store.local(this.projectId).forwardedEventIds);
    for (const event of this.#ledger.events()) {
      if (event.type !== 'coordinator-event') continue;
      const data = this.#ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' });
      if (forwarded.has(data.id)) continue;
      seen.events.add(data.id); if (data.kind === 'user-message') seen.messages.set(data.clientMessageId, data.text);
    }
    return this.#seen = seen;
  }
  /**
   * Appends to the queue (synchronously flushed) and records the event. A known event id repeats; an owner message id
   * reused for different text is refused (409). While the fallback is active a needs-decision report reaches the owner at once.
   */
  enqueue(raw: CoordinatorEvent): { repeated: boolean } {
    // Redaction never lengthens a text that was checked against its maximum, so an event that passed its schema still does (P8 review S-1).
    const event = CoordinatorEventSchema.parse(boundedRedaction(this.c.redactor, raw));
    const history = this.#history(); const queue = this.c.store.get(this.projectId).queue;
    if (history.events.has(event.id) || queue.some((queued) => queued.id === event.id)) return { repeated: true };
    if (event.kind === 'user-message') {
      const queued = queue.find((entry): entry is typeof event => entry.kind === 'user-message' && entry.clientMessageId === event.clientMessageId);
      const prior = history.messages.get(event.clientMessageId) ?? queued?.text;
      if (prior !== undefined) { if (prior === event.text) return { repeated: true }; throw refuse(MESSAGE_ID_REUSED, 409); }
    }
    this.c.store.update(this.projectId, (state) => ({ ...state, queue: [...state.queue, event] }));
    if (this.c.store.local(this.projectId).forwardedEventIds?.includes(event.id)) {
      this.c.store.updateLocal(this.projectId, (local) => ({ ...local, forwardedEventIds: (local.forwardedEventIds ?? []).filter((id) => id !== event.id) }));
    }
    this.record(event);
    if (event.kind === 'user-message') this.#ownerRetry = true;
    if (this.fallbackActive() && !this.#closed) void this.#fallback([event]);
    this.kick();
    return { repeated: false };
  }
  /** The ledger record of a received event (also used by recovery for queued events whose record a crash lost). */
  record(event: CoordinatorEvent): void {
    this.#ledger.append({ type: 'coordinator-event', data: event });
    const history = this.#history(); history.events.add(event.id);
    if (event.kind === 'user-message') history.messages.set(event.clientMessageId, event.text);
  }
  /** Startup (2.6.13 step 6): queued events whose ledger record a crash lost get one. Returns how many. */
  reconcile(): number {
    const history = this.#history(); let added = 0;
    for (const event of this.c.store.get(this.projectId).queue) if (!history.events.has(event.id)) { this.record(event); added += 1; }
    return added;
  }
  state(): CoordinatorState { return this.c.store.get(this.projectId); }
  /** Decision fallback (decision 7): the coordinator cannot run or failed twice in a row. */
  fallbackActive(): boolean { const state = this.state(); return state.state === 'unavailable' || state.failedTurnsInARow >= 2; }
  /** A turn is being evaluated or runs, a start or retry is scheduled, or a fallback or status write is in flight. */
  get busy(): boolean { return !!this.#running || !!this.#timer || this.#tasks.size > 0; }
  /** The project's coordinator moved to another device and this one handed its queue over (3.5.4). */
  get moved(): boolean { return this.#moved; }
  /**
   * Events wait while no turn will start: after two failed turns only an owner message tries again, so the fence is never reached.
   * The service reads the assignment for such a coordinator at each sweep, so a move away hands the events over (D271).
   */
  get stalled(): boolean {
    if (!this.#started || this.#closed || this.#moved || this.#ownerRetry || this.#running || this.#timer) return false;
    const state = this.state();
    return state.state !== 'unavailable' && state.failedTurnsInARow >= 2 && state.queue.length > 0;
  }
  /**
   * After startup recovery: queued events run in a new turn (brief 8.6), and the hub gets the recovered state (D5). After two failed turns
   * the owner's retry survives the restart (P8 review C-1): an owner message received since the last turn launched, or a turn the
   * restart dropped (it was allowed to run, so its batch is), lets the next turn start as before.
   */
  begin(): void {
    if (this.#started || this.#closed || this.#moved) return;
    this.#started = true;
    if (existsSync(this.c.store.paths.coordinator(this.projectId))) {
      if (this.#retryAfterRestart()) this.#ownerRetry = true;
      this.#publish();
    }
    this.kick();
  }
  /** The in-memory owner retry as the ledger recorded it: the newest turn record or still-queued owner message decides. */
  #retryAfterRestart(): boolean {
    const state = this.state(); if (state.failedTurnsInARow < 2 || !state.queue.length) return false;
    const queued = new Set(state.queue.filter((event) => event.kind === 'user-message').map((event) => event.id));
    const ledger = this.#ledger; const events = ledger.events();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === 'coordinator-turn-start') return false;
      if (event.type === 'coordinator-turn-end') return ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-turn-end' }).status === 'dropped';
      if (event.type === 'coordinator-event' && queued.has(ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' }).id)) return true;
    }
    return false;
  }
  /**
   * Schedules a turn within `startMs` (brief 8.1: within 1 s) when there is something to deliver. A running turn picks the
   * event up when it ends; a scheduled start or retry already covers it. After two failures in a row only an owner message
   * tries again (the notice asks for one).
   */
  kick(): void {
    if (!this.#started || this.#closed || this.#moved) return;
    if (this.#running) { this.#again = true; return; }
    if (this.#timer) return;
    const state = this.state();
    if (!state.queue.length || (state.failedTurnsInARow >= 2 && !this.#ownerRetry)) return;
    this.#schedule(this.c.timers.startMs);
  }
  /** The queue sweep (D70): an unavailable coordinator is evaluated again, and a fallback that could not reach the hub retries. */
  sweep(): void {
    if (!this.#started || this.#closed || this.#moved) return;
    if (this.fallbackActive()) void this.#fallback(this.state().queue);
    if (this.state().state === 'unavailable') this.kick();
    // A status the hub missed is written again, else the hub keeps the last one it got (a turn it thinks still runs, P8 review C-2).
    if (this.#statusDirty && !this.#running) this.#publish();
  }
  /** Stop from the chat: interrupts the running turn, whose events count as delivered (D33); a scheduled start is dropped. */
  async stop(): Promise<void> {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const running = this.#running; if (!running) return;
    this.#stopping = true; this.#outcomeAbort.abort();
    await this.#execution?.stop().catch(() => undefined);
    await running;
  }
  /** Fresh coordinator session: the next turn starts without resuming (brief 8.1, D77). */
  fresh(): void {
    this.#generation += 1;
    this.c.store.update(this.projectId, (state) => ({ ...state, session: null }));
    if (this.#started) this.#publish();
  }
  /** Daemon shutdown: a running turn is terminated and left `running` for recovery (2.6.13 step 5). */
  async close(): Promise<void> {
    this.#closed = true; this.#outcomeAbort.abort();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    await this.#execution?.shutdown().catch(() => undefined);
    await this.#running;
    await Promise.allSettled([...this.#tasks]);
  }
  /**
   * This device became the coordinator by a move (3.5.3): the hub gets its status at once, and events already queued here (a
   * device that coordinated before and kept them) run in a new turn.
   */
  arrived(): void {
    if (!this.#started || this.#closed || this.#moved) return;
    this.#publish(); this.kick();
  }
  /**
   * This device no longer holds the assignment (3.5.4: at startup, or when a relayed event arrives): no turn starts here any more,
   * a running turn is stopped (its events count as delivered, as after Stop, D33), and the queue goes to the coordinator device
   * with `extra` after it.
   */
  async handover(extra: readonly CoordinatorEvent[] = [], assignment?: string): Promise<void> {
    this.#moved = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const running = this.#running;
    if (running) { this.#stopping = true; await this.#execution?.stop().catch(() => undefined); await running; }
    this.#drop(extra, assignment);
  }
  /**
   * The handover itself (3.5.4, D43): every undelivered event, then `extra`, is sent to the coordinator device under its own id (the
   * relay resolves that device when it sends), then coordinator.json goes. The ledger stays as history. Repeating it sends only `extra`.
   */
  #drop(extra: readonly CoordinatorEvent[] = [], assignment?: string): void {
    this.#moved = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const queue = existsSync(this.c.store.paths.coordinator(this.projectId)) ? this.state().queue : [];
    const queued = new Set(queue.map((event) => event.id));
    const events = [...queue, ...extra.filter((event) => !queued.has(event.id))];
    if (events.length) {
      this.c.forward(this.projectId, events, assignment);
      const ids = new Set(events.map((event) => event.id));
      this.c.store.updateLocal(this.projectId, (local) => ({ ...local, forwardedEventIds: [...(local.forwardedEventIds ?? []).filter((id) => !ids.has(id)), ...ids].slice(-500) }));
    }
    this.c.store.drop(this.projectId);
  }

  #schedule(ms: number): void {
    if (this.#moved) return;
    const timer = setTimeout(() => { if (this.#timer === timer) this.#timer = undefined; this.#run(); }, ms);
    this.#timer = timer;
  }
  #run(): void {
    if (this.#closed || this.#running || this.#moved) return;
    this.#again = false; this.#stopping = false; this.#outcomeAbort = new AbortController();
    const running = this.#turn().catch((error: unknown) => {
      // An unexpected failure never leaves the coordinator looking busy; the next event tries again.
      try {
        this.#notice(this.c.redactor.text(messageOf(error)).replace(/\s+/g, ' ').trim().slice(0, 1000) || TURN_FAILED, 'error');
        if (this.state().state === 'running') this.c.store.update(this.projectId, (state) => ({ ...state, state: 'idle' }));
        this.#publish();
      } catch { /* The state files are unreadable; nothing more can be recorded. */ }
      return 'wait' as const;
    }).then((end) => {
      this.#running = undefined;
      if (this.#closed) return;
      try {
        if (end === 'retry' || end === 'postpone') this.#schedule(this.c.timers.retryMs);
        else if (end === 'continue' || this.#again) this.kick();
      } catch { /* The next event tries again. */ }
    });
    this.#running = running;
  }
  /**
   * The assignment fence (D6, 3.5.4): only the assigned device runs turns, a device that lost the assignment hands its queue over,
   * and a member postpones while the hub is unreachable (D76). Null when the turn may go on.
   */
  async #fence(): Promise<TurnEnd | null> {
    let stored: Awaited<ReturnType<CoordinatorContext['hub']['coordinator']>>;
    try { stored = await this.c.hub.coordinator(this.projectId); }
    catch (error) { if (error instanceof HubUnavailable) return 'postpone'; throw error; }
    const assigned = stored?.document.deviceId ?? null;
    if (assigned === this.c.deviceId) return null;
    if (stored && assigned !== null) this.#drop([], String(stored.revision));
    return 'wait';
  }
  async #turn(): Promise<TurnEnd> {
    const fenced = await this.#fence(); if (fenced) return fenced;
    const events = this.state().queue;
    if (!events.length) return 'wait';
    // Fresh pressed from here on applies to the next turn: this one never writes its session back (D194).
    const generation = this.#generation;
    let prepared: Prepared;
    try { prepared = await this.#prepare(events); }
    catch (error) {
      if (this.#closed || this.#stopping) return 'wait';
      if (error instanceof HubUnavailable) return 'postpone';
      return this.#failed(this.#nextTurn(), messageOf(error), 'failed');
    }
    if (prepared.kind === 'unavailable') { await this.#unavailable(prepared.reason, events); return 'wait'; }
    if (this.#closed || this.#stopping) return 'wait';
    // A move accepted while this turn prepared (the published status still said idle) wins: the turn never launches here (3.5.4).
    const moved = await this.#fence(); if (moved) return moved;
    const claimed = await this.#claim(); if (claimed) return claimed;
    return this.#launch(events, prepared, generation);
  }
  /**
   * The turn start, announced on the hub before the launch (D283): the status says `running`, which the hub takes only from the
   * assigned device, and from then on the hub refuses a move while this device is online (the move rule runs in the move's own
   * transaction). So a move recorded at any point before this write is refused here: this device hands the batch over and launches
   * nothing, and no move lands between this write and the launch. An unreachable hub postpones (D76); another refusal while the
   * assignment still names this device tries again after the retry delay.
   */
  async #claim(): Promise<TurnEnd | null> {
    try { await this.#status('running'); return null; }
    catch (error) {
      if (error instanceof HubUnavailable) return 'postpone';
      return await this.#fence() ?? 'postpone';
    }
  }
  /** The ledger turn number counts every coordinator turn of the project, across sessions (coordinator-local `deliveredTurn`). */
  #nextTurn(): number {
    return this.c.store.updateLocal(this.projectId, (local) => ({ ...local, deliveredTurn: local.deliveredTurn + 1 })).deliveredTurn;
  }
  /** Session choice and rotation (brief 8.1; D16, D34, D77, D97) and the prompt inputs. */
  async #prepare(events: CoordinatorEvent[]): Promise<Prepared> {
    const projectId = this.projectId; const { deviceId, deviceName } = this.c;
    // A turn waits for accounts a terminal holds; a move here does not (its readiness check passes no held accounts).
    const ready = await coordinatorReadiness(this.c, projectId, this.c.heldAccounts?.());
    if (ready.kind === 'unavailable') return ready;
    const { project, cwd, plan, input, work } = ready;
    const stored = this.state().session;
    const current = stored && coordinatorPlan({ ...input, work: { coordinator: { ...work.coordinator, modelId: stored.modelId } } });
    const session = stored && current && (!work.coordinator.accountId || stored.accountId === work.coordinator.accountId) && keepSession(stored, work.coordinator.modelId, current) ? stored : null;
    const chosen = session && current?.kind === 'ready' ? { model: current.model, effort: session.effort, accountId: session.accountId }
      : { model: plan.model, effort: plan.effort, accountId: plan.account.id };
    // The fallback's record of reports it already asked about must be complete before the event lines are rendered (D32).
    await this.#fallbacks;
    const [threads, decisions, notebook, roster, base] = await Promise.all([this.#threads(), this.c.hub.decisions(projectId), this.c.hub.notebook(projectId),
      this.c.roster().catch(() => null), this.#baseBranch(project)]);
    const names = new Map((roster?.devices ?? []).map((view) => [view.device.id, view.device.name]));
    const outcomes: ProjectRequestOutcome[] = [];
    if (this.c.outcome) for (const event of events) if (event.kind === 'user-message') outcomes.push(await this.c.outcome(projectId, event, recentConversation(this.#conversation()), this.#outcomeAbort.signal));
    return { kind: 'ready', project, cwd, ...chosen, ...(work.coordinator.accountId ? { requiredAccountId: work.coordinator.accountId } : {}), session, prompt: { events, outcomes, notebook: notebook?.document.content ?? null, threads, decisions, history: this.#conversation(),
      runtimeName: (runtime) => this.c.runtimes.get(runtime)?.displayName ?? runtime, deviceName: (id) => id === deviceId ? deviceName : names.get(id) ?? id, base,
      askedDirectly: this.#askedDirectly(events, decisions) } };
  }
  /**
   * Reports the owner was already asked about (D32): those this coordinator's fallback covered, and every needs-decision report whose
   * fallback question exists on the hub under its derived id (D195), whoever created it: the thread's owner device while this
   * device was away, or a former coordinator device whose queue moved here (D280). The question is the record that travels.
   */
  #askedDirectly(events: readonly CoordinatorEvent[], decisions: readonly ProjectDecision[]): Set<string> {
    const asked = new Set(this.c.store.local(this.projectId).fallbackEventIds); const stored = new Set(decisions.map((decision) => decision.id));
    for (const event of events) {
      if (event.kind === 'thread-report' && event.report.status === 'needs-decision' && stored.has(derivedId('pdec', 'fallback', event.id))) asked.add(event.id);
    }
    return asked;
  }
  async #threads(): Promise<ThreadIndex[]> {
    const threads: ThreadIndex[] = []; let after: string | undefined;
    do {
      const page = await this.c.hub.threads(this.projectId, after);
      threads.push(...page.records.filter((index) => index.projectId === this.projectId)); after = page.next ?? undefined;
    } while (after !== undefined);
    return threads;
  }
  /** Detected once per daemon; a checkout without `origin/HEAD` says `main`. */
  #baseBranch(project: Project): Promise<string> {
    if (!this.#base) {
      const base = this.#base = this.c.baseBranch(project).catch(() => 'main');
      void base.then((value) => { if (value === 'main' && this.#base === base) this.#base = undefined; });
    }
    return this.#base;
  }
  /** Owner messages and coordinator replies, oldest first (9.2 recap, D36). */
  #conversation(): CoordinatorPromptInput['history'] {
    const ledger = this.#ledger;
    return ledger.events().flatMap((event): CoordinatorPromptInput['history'][number][] => {
      if (event.type === 'coordinator-text') return [{ from: 'coordinator', text: ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-text' }).text }];
      if (event.type !== 'coordinator-event') return [];
      const data = ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-event' });
      return data.kind === 'user-message' ? [{ from: 'owner', text: data.text, eventId: data.id }] : [];
    });
  }
  async #launch(events: CoordinatorEvent[], prepared: Extract<Prepared, { kind: 'ready' }>, generation: number): Promise<TurnEnd> {
    const projectId = this.projectId; const { project, model, effort, session } = prepared;
    const turn = this.#nextTurn();
    const scope: ProjectScope = { kind: 'coordinator', projectId, turn };
    // Tokens are valid only while this exact scope is the running turn (D190).
    const tools = new ProjectTools(scope, { ...this.c.tools(), isCurrent: (candidate) => candidate === this.#scope }, this.c.redactor, this.#ledger);
    this.#scope = scope;
    let launched: LaunchResult;
    try {
      launched = await this.c.launcher.launch({ owner: { kind: 'coordinator', projectId, id: projectId }, turn, runtime: model.runtime, modelId: model.id, model: model.model,
        modelLabel: model.label, effort, pinnedAccountId: prepared.accountId, ...(prepared.requiredAccountId ? { requiredAccountId: prepared.requiredAccountId } : {}), permissions: 'read-only', cwd: prepared.cwd, systemAppend: coordinatorSystemAppend(project.name, project.branchPolicy),
        prompt: (resumed) => coordinatorPrompt(prepared.prompt, resumed), ...(session?.nativeSessionId ? { resume: session.nativeSessionId } : {}),
        safetyProfile: 'coordinator', timeoutMs: this.c.timers.turnTimeoutMs, tools });
    } catch (error) { this.#scope = undefined; await tools.close(); return this.#failed(turn, messageOf(error), 'failed'); }
    if (launched.kind === 'unavailable') { this.#scope = undefined; await tools.close(); return this.#failed(turn, launched.reason, 'failed'); }
    const started = launched; const release = this.c.enterOperation(projectId, `Coordinator: ${project.name}`);
    try {
      // Without a resumed session this is a new one, also when the account changed and the old session stayed in its home (D16).
      const record: CoordinatorSession = started.resumed && session ? { ...session, accountId: started.accountId }
        : { runtime: model.runtime, modelId: model.id, model: model.model, effort, accountId: started.accountId, startedAt: this.#at(), turns: 0 };
      const ours = (state: CoordinatorState) => generation === this.#generation && state.session?.startedAt === record.startedAt;
      this.#ownerRetry = false;
      this.c.store.update(projectId, (state) => ({ ...withoutReason(state), state: 'running', session: generation === this.#generation ? record : state.session }));
      if (started.accountChanged) this.#notice(coordinatorAccountMovedNotice(started.accountLabel), 'info');
      this.#ledger.append({ type: 'coordinator-turn-start', turn, data: { schema: 'coordinator-turn-v1', turn, fresh: !started.resumed, runtime: model.runtime,
        modelLabel: model.label, effort, accountLabel: started.accountLabel, eventIds: events.map((event) => event.id) } });
      this.#publish();
      const execution = new TurnExecution({ run: started.run, accountId: started.accountId, secretRef: started.secretRef, model: model.model, deviceId: this.c.deviceId,
        accounts: this.c.accounts, initialUsage: started.usage, redactor: this.c.redactor,
        onSession: (sessionId) => {
          if (generation !== this.#generation) return;
          this.c.store.update(projectId, (state) => ours(state) && state.session ? { ...state, session: { ...state.session, nativeSessionId: sessionId } } : state);
        },
        onProcess: (native) => {
          this.c.store.updateLocal(projectId, (local) => ({ ...local, process: { turn, pid: native.pid, pgid: native.pgid,
            ...(native.startIdentity ? { startIdentity: native.startIdentity } : {}), startedAt: this.#at() } }));
        } });
      this.#execution = execution;
      if (this.#closed) void execution.shutdown().catch(() => undefined);
      else if (this.#stopping) void execution.stop().catch(() => undefined);
      let outcome: TurnOutcome | undefined;
      // The grant closes before the outcome is applied, so no late tool call races the state change.
      try { outcome = await execution.done; } catch { outcome = undefined; } finally { this.#execution = undefined; this.#scope = undefined; await started.release().catch(() => undefined); }
      // A rejected outcome means the process cleanup was not confirmed: its record stays for recovery and the turn counts as failed.
      if (!outcome) return this.#failed(turn, COORDINATOR_PROCESS_UNCONFIRMED, 'failed', false);
      if (outcome.status !== 'shutdown') this.c.store.updateLocal(projectId, (local) => { const cleared = { ...local }; delete cleared.process; return cleared; });
      return this.#outcome(turn, events, outcome, ours);
    } finally { release(); }
  }
  #outcome(turn: number, events: CoordinatorEvent[], outcome: TurnOutcome, ours: (state: CoordinatorState) => boolean): TurnEnd {
    // Shutdown: the state stays `running`, and recovery records the dropped turn with its events still queued (2.6.13).
    if (outcome.status === 'shutdown') return 'wait';
    if (outcome.status === 'failed' || outcome.status === 'timed-out') {
      // The runtime no longer has the session (the CLI's transcript retention, P8 review R-T1): the retry starts a fresh one with the fresh context.
      if (outcome.error?.message === SESSION_NOT_FOUND) this.c.store.update(this.projectId, (state) => ours(state) ? { ...state, session: null } : state);
      return this.#failed(turn, outcome.error?.message || (outcome.status === 'timed-out' ? coordinatorTurnTimedOut(this.c.timers.turnTimeoutMs) : TURN_FAILED), outcome.status);
    }
    // Completed, or stopped by the owner (D33): the batch was delivered. `steered` cannot happen here; it reads as completed.
    const completed = outcome.status !== 'stopped'; const delivered = new Set(events.map((event) => event.id));
    this.c.store.update(this.projectId, (state) => ({ ...withoutReason(state), state: 'idle', queue: state.queue.filter((event) => !delivered.has(event.id)), lastTurnAt: this.#at(),
      ...(completed ? { failedTurnsInARow: 0 } : {}),
      session: ours(state) && state.session ? { ...state.session, turns: state.session.turns + 1, ...(outcome.sessionId ? { nativeSessionId: outcome.sessionId } : {}) } : state.session }));
    this.c.store.updateLocal(this.projectId, (local) => ({ ...local, fallbackEventIds: local.fallbackEventIds.filter((id) => !delivered.has(id)) }));
    if (completed && outcome.finalText) this.#ledger.append({ type: 'coordinator-text', turn, data: { schema: 'coordinator-text-v1', text: outcome.finalText } });
    this.#ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status: completed ? 'completed' : 'interrupted' } });
    this.#publish();
    return 'continue';
  }
  /**
   * A failed turn keeps its events queued at the front (brief 8.1). Odd failures retry once after the delay; every second
   * failure in a row sets the coordinator idle with the notice and turns queued needs-decision reports into owner questions.
   * A turn whose process cleanup was not confirmed is not retried, so its process record stays until the next event's turn.
   */
  #failed(turn: number, error: string, status: 'failed' | 'timed-out', retry = true): TurnEnd {
    const text = this.c.redactor.text(error).replace(/\s+/g, ' ').trim().slice(0, 1000) || TURN_FAILED;
    const state = this.c.store.update(this.projectId, (current) => ({ ...withoutReason(current), state: 'idle', failedTurnsInARow: current.failedTurnsInARow + 1 }));
    this.#ledger.append({ type: 'coordinator-turn-end', turn, data: { schema: 'coordinator-turn-end-v1', turn, status, error: text } });
    this.#publish();
    if (state.failedTurnsInARow % 2 === 1) {
      if (retry) return 'retry';
      this.#notice(text, 'error');
      return 'wait';
    }
    this.#notice(coordinatorFailedTwiceNotice(firstLine(text).slice(0, 300)), 'error');
    void this.#fallback(state.queue);
    return 'wait';
  }
  /** No model, account or checkout here (D34, D97): one notice per change of reason, then the fallback (decision 7). */
  async #unavailable(reason: string, events: CoordinatorEvent[]): Promise<void> {
    const before = this.state();
    if (before.state !== 'unavailable' || before.unavailableReason !== reason) {
      this.c.store.update(this.projectId, (state) => ({ ...state, state: 'unavailable', unavailableReason: reason }));
      this.#notice(coordinatorUnavailableNotice(reason), 'error');
      this.#publish();
    }
    await this.#fallback(events);
  }
  /** Queued needs-decision reports not yet asked about become owner questions; serialized, and a failure is retried by the sweep. */
  #fallback(events: readonly CoordinatorEvent[]): Promise<void> {
    const task = this.#fallbacks.then(async () => {
      const asked = new Set(this.c.store.local(this.projectId).fallbackEventIds);
      const reports = events.filter((event) => event.kind === 'thread-report' && event.report.status === 'needs-decision' && !asked.has(event.id));
      if (!reports.length) return;
      const covered = await this.c.decisions.fallbackFromReports(this.projectId, reports);
      if (covered.length) this.c.store.updateLocal(this.projectId, (local) => ({ ...local, fallbackEventIds: [...local.fallbackEventIds, ...covered].slice(-500) }));
    }).catch(() => undefined);
    this.#fallbacks = task; this.#track(task);
    return task;
  }
  #notice(text: string, kind: 'info' | 'error'): void {
    this.#ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', text, kind } });
  }
  /** The coordinator status on the hub (D5), serialized; a refusal (this device no longer holds the assignment) or an outage is ignored. */
  #publish(): void { void this.#status().catch(() => undefined); }
  /** One status write after the earlier ones; `shown` replaces the local state (the turn-start claim, D283). Rejects with the hub's refusal. */
  #status(shown?: CoordinatorState['state']): Promise<void> {
    const task = this.#publishing.then(async () => {
      const current = this.state(); const session = current.session;
      const state = shown === undefined || shown === current.state ? current : { ...withoutReason(current), state: shown };
      let labels: { modelLabel: string; accountLabel: string } | undefined;
      if (session) {
        const [settings, accounts] = await Promise.all([this.c.settings(), this.c.accounts.list()]);
        labels = { modelLabel: settings.menu.find((entry) => entry.id === session.modelId)?.label ?? session.model,
          accountLabel: accounts.find((view) => view.account.id === session.accountId)?.account.label ?? session.accountId };
      }
      await this.c.hub.putCoordinatorStatus(ProjectCoordinatorStatusSchema.parse({ schema: 'project-coordinator-status-v1', revision: 0, projectId: this.projectId,
        deviceId: this.c.deviceId, state: state.state, ...(state.unavailableReason ? { unavailableReason: state.unavailableReason.slice(0, 400) } : {}),
        failedTurnsInARow: state.failedTurnsInARow, session: session && labels ? { runtime: session.runtime, modelLabel: labels.modelLabel, effort: session.effort,
          accountLabel: labels.accountLabel, turns: session.turns } : null, lastEventId: this.#ledger.lastId(), updatedAt: this.#at() }));
    }).then(() => { this.#statusDirty = false; }, (error: unknown) => {
      // A refusal (this device no longer holds the assignment) is final; an outage leaves the write to the sweep.
      const code = status(error); if (!(typeof code === 'number' && code >= 400 && code < 500)) this.#statusDirty = true;
      throw error;
    });
    const settled = task.then(() => undefined, () => undefined);
    this.#publishing = settled; this.#track(settled);
    return task;
  }
}

/** The coordinators this device holds, and the hub assignment (D6) with Move coordinator here and the handover (3.5.3, 3.5.4). */
export class CoordinatorService {
  readonly #coordinators = new Map<string, Coordinator>();
  readonly #assigning = new Map<string, Promise<string>>();
  readonly #moving = new Map<string, Promise<string>>();
  /** Coordinators with state here whose assignment the startup check has not read yet (3.5.4); an outage keeps them for the next sweep. */
  readonly #unchecked = new Set<string>();
  #checking: Promise<void> | undefined;
  #started = false;
  #closed = false;
  constructor(private readonly c: CoordinatorContext) {}
  get store(): CoordinatorStore { return this.c.store; }
  /** The project's coordinator here; one that handed its queue over is replaced, so a coordinator that returns starts clean. */
  get(projectId: string): Coordinator {
    let coordinator = this.#coordinators.get(projectId);
    if (!coordinator || coordinator.moved) {
      coordinator = new Coordinator(projectId, this.c); this.#coordinators.set(projectId, coordinator);
      if (this.#closed) void coordinator.close(); else if (this.#started) coordinator.begin();
    }
    return coordinator;
  }
  /**
   * After startup recovery (`ProjectWork.start`): every coordinator with state on this device may run its queue (brief 8.6), and
   * reads the assignment once whatever its queue holds, so a device the coordinator moved away from hands over (3.5.4).
   */
  begin(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    for (const projectId of this.c.store.paths.projectIds()) if (existsSync(this.c.store.paths.coordinator(projectId))) this.get(projectId);
    for (const [projectId, coordinator] of this.#coordinators) { this.#unchecked.add(projectId); coordinator.begin(); }
    this.#check();
  }
  /**
   * The periodic queue sweep and `pulse` (D70); one unreadable coordinator never stops the others or the timer. A startup check the
   * hub missed runs again, and a stalled coordinator (two failed turns, events waiting) reads its assignment (D271).
   */
  sweep(): void {
    for (const [projectId, coordinator] of this.#coordinators) {
      try { coordinator.sweep(); if (coordinator.stalled) this.#unchecked.add(projectId); } catch { /* Retried by the next sweep. */ }
    }
    if (this.#unchecked.size) this.#check();
  }
  /** The handover check: one assignment read per coordinator listed; an unreachable hub leaves the rest for the next sweep, so idle sweeps read nothing. */
  #check(): void {
    if (this.#checking || this.#closed) return;
    this.#checking = (async () => {
      for (const projectId of [...this.#unchecked]) {
        if (this.#closed) return;
        const assigned = await this.assignment(projectId);
        this.#unchecked.delete(projectId);
        if (assigned !== null && assigned.deviceId !== this.c.deviceId) await this.handover(projectId, [], assigned.revision);
      }
    })().catch(() => undefined).finally(() => { this.#checking = undefined; });
  }
  /** A coordinator of the project (or any) is evaluating, running, scheduled or writing, or the startup check runs (the `ProjectWork.idle` test seam). */
  busy(projectId?: string): boolean {
    return !!this.#checking || [...this.#coordinators].some(([id, coordinator]) => (projectId === undefined || id === projectId) && coordinator.busy);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#checking;
    await Promise.allSettled([...this.#coordinators.values()].map((coordinator) => coordinator.close()));
  }
  /** The assigned coordinator device, or null before the first message or thread. */
  async deviceOf(projectId: string): Promise<string | null> { return (await this.assignment(projectId))?.deviceId ?? null; }
  /** The assignment with its revision, which names the handovers that follow it (P8 review RL-1); null before the first assignment. */
  async assignment(projectId: string): Promise<{ deviceId: string; revision: string } | null> {
    const stored = await this.c.hub.coordinator(projectId);
    return stored ? { deviceId: stored.document.deviceId, revision: String(stored.revision) } : null;
  }
  /**
   * Assigns this device when no coordinator exists yet (compare-and-swap on revision 0; a lost race reads the winner) and
   * returns the coordinator device. Concurrent calls for one project share one assignment; a running move is waited for.
   */
  ensureAssigned(projectId: string): Promise<string> {
    const moving = this.#moving.get(projectId);
    if (moving) return moving.then(() => this.ensureAssigned(projectId), () => this.ensureAssigned(projectId));
    const running = this.#assigning.get(projectId); if (running) return running;
    const task = (async () => {
      const current = await this.deviceOf(projectId); if (current) return current;
      try { return (await this.c.hub.assignCoordinator(projectId, this.c.deviceId, 0)).document.deviceId; }
      catch (error) {
        if (status(error) !== 409) throw error;
        const winner = await this.deviceOf(projectId); if (!winner) throw error;
        return winner;
      }
    })().finally(() => { this.#assigning.delete(projectId); });
    this.#assigning.set(projectId, task);
    return task;
  }
  /**
   * This device no longer holds the project's coordinator (3.5.4): the coordinator here, if any, stops for good and its queue goes to
   * the coordinator device, followed by `extra` (an event relayed here before the move). Without state here only `extra` is sent.
   */
  async handover(projectId: string, extra: readonly CoordinatorEvent[] = [], assignment?: string): Promise<void> {
    const coordinator = this.#coordinators.get(projectId);
    if (coordinator && !coordinator.moved) { await coordinator.handover(extra, assignment); return; }
    if (existsSync(this.c.store.paths.coordinator(projectId))) { await this.get(projectId).handover(extra, assignment); return; }
    if (extra.length) this.c.forward(projectId, extra, assignment);
  }
  /**
   * Move coordinator here (3.5.3), serialized with the project's first assignment. Allowed by `coordinatorMovable` (else 409 with the
   * device that works); assigned by compare-and-swap on the observed revision, where a lost race reads the assignment again. This
   * device then starts with no session and an empty queue, says so in its chat and publishes its status; the first turn is fresh,
   * from the hub's notebook and indexes (D43). Before any assignment this assigns this device as a first message would (D6). A
   * repeated move (a lost reply) completes a setup that did not happen and changes nothing else. Returns this device.
   */
  moveHere(projectId: string): Promise<string> {
    const running = this.#moving.get(projectId); if (running) return running;
    const assigning = this.#assigning.get(projectId);
    const task = (async () => { await assigning?.catch(() => undefined); return this.#move(projectId); })().finally(() => { this.#moving.delete(projectId); });
    this.#moving.set(projectId, task);
    return task;
  }
  async #move(projectId: string): Promise<string> {
    const here = this.c.deviceId; let checked = false;
    for (let attempt = 1; ; attempt += 1) {
      const stored = await this.c.hub.coordinator(projectId); const from = stored?.document.deviceId;
      if (from === here) { this.#arrive(projectId, false); return here; }
      if (from !== undefined) {
        const [roster, published] = await Promise.all([this.c.roster(), this.c.hub.coordinatorStatus(projectId)]);
        const row = roster.devices.find((view) => view.device.id === from);
        if (!coordinatorMovable(from, row, published?.document)) throw refuse(coordinatorWorking(row?.device.name ?? from), 409);
      }
      // Only a device that can run the coordinator takes it (D282), also before any assignment; a repeated move is never refused.
      if (!checked) { const ready = await coordinatorReadiness(this.c, projectId); if (ready.kind === 'unavailable') throw refuse(ready.reason, 409); checked = true; }
      try { await this.c.hub.assignCoordinator(projectId, here, stored?.revision ?? 0); }
      catch (error) { if (status(error) === 409 && attempt < 3) continue; throw error; }
      if (from !== undefined) this.#arrive(projectId, true);
      return here;
    }
  }
  /**
   * The new coordinator's start (3.5.3): no session and an empty queue, except events this device received before (it coordinated
   * earlier and never handed over), the notice in its chat, then the status. A repeat finds the state file and does nothing.
   */
  #arrive(projectId: string, moved: boolean): void {
    const store = this.c.store; const exists = existsSync(store.paths.coordinator(projectId));
    if (exists && !moved) return;
    const queue = exists ? store.get(projectId).queue : [];
    store.update(projectId, () => CoordinatorStateSchema.parse({ schema: 'coordinator-state-v1', projectId, state: 'idle', session: null, queue, failedTurnsInARow: 0 }));
    this.c.ledgers.coordinator(projectId).append({ type: 'notice', data: { schema: 'project-notice-v1', text: coordinatorMovedNotice(this.c.deviceName), kind: 'info' } });
    this.get(projectId).arrived();
  }
}
