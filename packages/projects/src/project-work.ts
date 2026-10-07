import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import {
  IdSchema, ProjectRequestOutcomeSchema, readDocument, writeDocument, ProjectNotebookSchema, ProjectNotebookViewSchema, ProjectWorkSettingsSchema, ProjectWorkSettingsViewSchema, ThreadCreatedViewSchema, ThreadOverrideViewSchema, defaultProjectWorkSettings, newId,
  type CheckoutOwnership, type Configuration, type CoordinatorMessageRequestSchema, type DecisionAnswerRequestSchema, type Homes, type NotebookRequestSchema, type Project,
  type ProjectHub, type ProjectWorkListView, type ProjectWorkSettings, type ProjectWorkSettingsRequestSchema, type ProjectWorkView, type PublicationLeaseService,
  type RiggingItem, type SecretRedactor, type SharedProjects, type ThreadCreateRequestSchema, type ThreadMessageRequestSchema, type ThreadOverrideRequestSchema,
  type ThreadStopRequestSchema, type ThreadView, type UnreadableEnvelope,
} from '@jevellan/core';
import type { StretchBridges } from '@jevellan/conversations';
import { decideProjectOutcome, type DecisionClient } from '@jevellan/decisions';
import type { BasicMemory } from '@jevellan/memory';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import { Admission } from './admission.js';
import { ProjectApps, tailnetAppPublisher } from './apps.js';
import { ThreadAttach, type ThreadAttachView, type ThreadDetachView } from './attach.js';
import {
  COORDINATOR_ELSEWHERE, COORDINATOR_MEMORY_READ_ONLY, NOTEBOOK_CHANGED, PROJECT_NOT_FOUND, SETTINGS_CHANGED, STOPPED_BY_YOU, THREAD_MEMORY_READ_ONLY, THREAD_NOT_FOUND,
  THREAD_STARTS_ELSEWHERE, relayedEnvelopeLost,
} from './copy.js';
import { coordinatorToolHandlers } from './bridge-tools.js';
import { CoordinatorService, type Coordinator, type CoordinatorToolHandlers } from './coordinator.js';
import { DecisionItems } from './decision-items.js';
import { Inbox, Outbox, type EnvelopeOf } from './envelopes.js';
import { ThreadGit } from './git.js';
import { ThreadIndexPublisher } from './index-publisher.js';
import { TurnLauncher } from './launch.js';
import { ProjectLedgers, type ProjectLedger } from './ledger.js';
import { MailService } from './mail.js';
import { MainCheckout } from './main-checkout.js';
import { ProjectPaths } from './paths.js';
import { Placement, type DeviceRoster } from './placement.js';
import { GitHubAccess, ThreadPublication } from './publication.js';
import { PullRequestTracker, type MergeResultView } from './pull-requests.js';
import { endTurnProcess, recoverProjects } from './recovery.js';
import { CoordinatorStore, StartReceipts, ThreadStore, threadIndex } from './stores.js';
import { LocalDelivery, ThreadService, type RemoteStart } from './threads.js';
import { ThreadTranscripts } from './transcript.js';
import { ProjectViews, effectiveSettings } from './views.js';
import { ThreadWorktree } from './worktree.js';

export type ProjectTimers = {
  /** PR poll, queue sweep and inbox poll; false in tests, which call `pulse()`. The outbox retries a failed drain either way. */
  periodic: boolean;
  prPollMs: number; coordinatorStartMs: number; coordinatorRetryMs: number; coordinatorTurnTimeoutMs: number; threadTurnTimeoutMs: number;
  setupTimeoutMs: number; testTimeoutMs: number; outboxRetryMs: number; outboxMaxMs: number; inboxPollMs: number; indexRetryMs: number;
  queueSweepMs: number; mainLeaseRetryMs: number;
  /** How often the sweeps check a waiting question against the coordinator device's presence (D280); each new question checks at once. */
  fallbackCheckMs: number;
  now(): number;
};
export const DEFAULT_PROJECT_TIMERS: ProjectTimers = {
  periodic: true, prPollMs: 60_000, coordinatorStartMs: 250, coordinatorRetryMs: 30_000, coordinatorTurnTimeoutMs: 1_200_000, threadTurnTimeoutMs: 21_600_000,
  setupTimeoutMs: 900_000, testTimeoutMs: 1_800_000, outboxRetryMs: 10_000, outboxMaxMs: 60_000, inboxPollMs: 3_000, indexRetryMs: 30_000, queueSweepMs: 5_000,
  mainLeaseRetryMs: 20_000, fallbackCheckMs: 60_000, now: Date.now,
};
export type ProjectWorkOptions = {
  homes: Homes; deviceId: string; deviceName: string; redactor: SecretRedactor;
  projects: SharedProjects; hub: ProjectHub;
  github: { credential(): Promise<string | undefined>; fetch?: typeof fetch | undefined; baseUrl?: string | undefined };
  accounts: Pick<AccountService, 'list' | 'resolve' | 'markUsed' | 'recordUsage' | 'recordError'>;
  runtimes: ReadonlyMap<string, RuntimeAdapter>; accountRuns: Set<string>;
  /** Main isolation (phase 6) publishes under these; worktree threads need neither. */
  ownership?: CheckoutOwnership | undefined; leases?: PublicationLeaseService | undefined;
  outside?: { assertIdle(project: Project, path: string): Promise<void> } | undefined;
  bridges: Pick<StretchBridges, 'issueTools'>; memory: Pick<BasicMemory, 'project'>;
  settings(): Promise<Configuration['x-jevellan']>; riggingItems(runtime: string): Promise<RiggingItem[]>;
  /** Jev placement (phase 4). */
  decisionClient?(): Promise<DecisionClient>;
  roster(): Promise<DeviceRoster>;
  enterOperation(id: string, title: string): () => void;
  timers?: Partial<ProjectTimers> | undefined;
};
type ThreadCreateRequest = z.infer<typeof ThreadCreateRequestSchema>;
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const statusOf = (error: unknown) => (error as { status?: unknown } | undefined)?.status;

/**
 * Projects on this daemon (brief 8): the facade the daemon routes call. It builds every part in dependency order, runs
 * startup recovery before anything launches (`ready`, brief 8.6), and owns the periodic loops. Turns launch only after
 * `start()`, which the application calls once the daemon URL is known. `close()` stops every running turn and leaves
 * states for recovery (D24).
 */
export class ProjectWork {
  readonly ready: Promise<void>;
  /** The daemon's own URL for bridge calls; empty until `Application.bindDaemonUrl`. */
  daemonUrl = '';
  readonly paths: ProjectPaths; readonly ledgers: ProjectLedgers; readonly store: ThreadStore; readonly coordinators: CoordinatorService;
  readonly threads: ThreadService; readonly decisions: DecisionItems; readonly tracker: PullRequestTracker; readonly views: ProjectViews;
  readonly admission: Admission; readonly transcripts: ThreadTranscripts;
  readonly apps: ProjectApps;
  /** Mail and reservations between main threads (brief 5.11, 7.2). */
  readonly mail: MailService;
  /** The hub relay (D40): durable sends to other devices, and this device's pending envelopes. */
  readonly outbox: Outbox; readonly inbox: Inbox;
  readonly #o: ProjectWorkOptions;
  readonly #timers: ProjectTimers;
  readonly #publisher: ThreadIndexPublisher;
  readonly #attach: ThreadAttach;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #tools: CoordinatorToolHandlers | undefined;
  #started = false;
  #closing: Promise<void> | undefined;
  constructor(options: ProjectWorkOptions) {
    this.#o = options; const o = options;
    this.apps = new ProjectApps(o.homes, tailnetAppPublisher(async () => (await o.roster()).devices.find(view => view.device.id === o.deviceId)?.device.url ?? this.daemonUrl), o.redactor);
    const timers = this.#timers = { ...DEFAULT_PROJECT_TIMERS, ...o.timers };
    const now = () => timers.now();
    this.paths = new ProjectPaths(o.homes);
    this.ledgers = new ProjectLedgers(this.paths, { redactor: o.redactor, now: () => new Date(now()).toISOString() });
    this.#publisher = new ThreadIndexPublisher(o.hub, timers.indexRetryMs);
    this.store = new ThreadStore(this.paths, this.ledgers, this.#publisher);
    const coordinatorStore = new CoordinatorStore(this.paths); const receipts = new StartReceipts(this.paths, now);
    const github = new GitHubAccess({ credential: o.github.credential, fetch: o.github.fetch, baseUrl: o.github.baseUrl, redactor: o.redactor });
    this.transcripts = new ThreadTranscripts({ homes: o.homes, deviceId: o.deviceId, deviceName: o.deviceName });
    // A thread attached in a terminal holds its account for every turn on this device, read from the threads themselves (phase 8).
    const held = (): ReadonlySet<string> => new Set(this.store.all().filter((thread) => thread.state === 'attached').map((thread) => thread.placement.accountId));
    const launcher = new TurnLauncher({ accounts: o.accounts, runtimes: o.runtimes, accountRuns: o.accountRuns, riggingItems: o.riggingItems, bridges: o.bridges, homes: o.homes,
      deviceId: o.deviceId, deviceName: o.deviceName, daemonUrl: () => this.daemonUrl, redactor: o.redactor, held });
    this.admission = new Admission({ hub: o.hub, deviceId: o.deviceId, deviceName: o.deviceName, localLive: (projectId) => this.threads.liveThreads(projectId),
      nameOf: async (deviceId) => (await o.roster()).devices.find((view) => view.device.id === deviceId)?.device.name, now });
    const placement = new Placement({ settings: o.settings, accounts: o.accounts, runtimes: o.runtimes, roster: o.roster, admission: this.admission, deviceId: o.deviceId,
      deviceName: o.deviceName, hub: o.hub, redactor: o.redactor, now, ...(o.decisionClient ? { decisionClient: o.decisionClient } : {}),
      local: (projectId) => this.store.list(projectId).map((thread) => threadIndex(thread, this.store.labels(thread.id), thread.createdAt)),
      pendingMain: (projectId) => this.threads.pendingMain(projectId) });
    this.decisions = new DecisionItems({ hub: o.hub, now, toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event), threads: () => ({
      allowTurns: (projectId, threadId, commandId) => this.threads.allowTurns(projectId, threadId, commandId),
      stop: (projectId, threadId, reason, commandId) => this.threads.stop(projectId, threadId, reason, true, commandId),
      stopRefusal: (projectId, threadId) => this.threads.stopRefusal(projectId, threadId),
      message: (projectId, threadId, text, messageId) => this.threads.message(projectId, threadId, 'owner', text, false, messageId),
    }) });
    const git = new ThreadGit({ homes: o.homes, redactor: o.redactor });
    const worktrees = new ThreadWorktree({ git, homes: o.homes, paths: this.paths, redactor: o.redactor, deviceId: o.deviceId, deviceName: o.deviceName });
    const publication = new ThreadPublication({ git, homes: o.homes, redactor: o.redactor, github, deviceId: o.deviceId, deviceName: o.deviceName, testTimeoutMs: timers.testTimeoutMs,
      leaseRetryMs: timers.mainLeaseRetryMs, now, ...(o.leases ? { leases: o.leases } : {}), ...(o.ownership ? { ownership: o.ownership } : {}) });
    const main = new MainCheckout({ git, redactor: o.redactor, deviceId: o.deviceId, deviceName: o.deviceName, ownership: o.ownership, outside: o.outside });
    this.coordinators = new CoordinatorService({ deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, store: coordinatorStore, ledgers: this.ledgers, hub: o.hub,
      project: (projectId) => this.#project(projectId), workSettings: (projectId) => this.admission.settings(projectId), settings: o.settings, accounts: o.accounts,
      runtimes: o.runtimes, launcher, heldAccounts: held, decisions: this.decisions, tools: () => this.#coordinatorTools(), roster: o.roster,
      outcome: async (projectId, event, history, signal) => {
        const file = join(this.paths.project(projectId), 'request-outcomes', `${IdSchema.parse(event.id)}.json`);
        if (existsSync(file)) {
          const saved = readDocument(file, ProjectRequestOutcomeSchema);
          if (saved.projectId !== projectId || saved.eventId !== event.id) throw new Error('This requested result belongs to another event.');
          return saved;
        }
        const release = o.enterOperation(`project_request_${event.id}`, 'Interpreting a project request');
        try {
          const result = await decideProjectOutcome(o.decisionClient, { projectId, eventId: event.id, request: event.text, history, model: (await o.settings()).decisions.model }, signal);
          return writeDocument(file, ProjectRequestOutcomeSchema, result);
        } finally { release(); }
      },
      forward: (projectId, events, handover) => {
        for (const event of events) this.outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event }, handover === undefined ? {} : { handover });
      },
      baseBranch: (project) => worktrees.baseBranch(worktrees.repository(project)), enterOperation: o.enterOperation,
      timers: { startMs: timers.coordinatorStartMs, retryMs: timers.coordinatorRetryMs, turnTimeoutMs: timers.coordinatorTurnTimeoutMs }, now });
    const delivery = new LocalDelivery({ deviceId: o.deviceId, coordinators: this.coordinators, store: this.store, outbox: () => this.outbox, now,
      command: (projectId, threadId, command) => this.threads.command(projectId, threadId, command) });
    this.mail = new MailService({ hub: o.hub, toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event), local: (threadId) => this.store.get(threadId), now });
    this.threads = new ThreadService({ deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, store: this.store, ledgers: this.ledgers, receipts, hub: o.hub,
      projects: o.projects, admission: this.admission, placement, accounts: o.accounts, transcripts: this.transcripts, delivery, settings: o.settings, now,
      roster: o.roster, decisions: this.decisions, fallbackCheckMs: timers.fallbackCheckMs,
      runner: { deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, store: this.store, ledgers: this.ledgers, project: (projectId) => this.#project(projectId),
        workSettings: (projectId) => this.admission.settings(projectId), worktrees, main, publication, launcher, accounts: o.accounts, admission: this.admission,
        endProcess: (process) => endTurnProcess(process),
        accountWait: (thread) => launcher.accountWait({ runtime: thread.placement.runtime, model: thread.placement.model }),
        decisions: this.decisions, toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event),
        memory: (project) => o.memory.project(project, o.deviceId, () => { throw new Error(THREAD_MEMORY_READ_ONLY); }), mail: this.mail,
        appTool: async (scope, name, input, signal) => {
          if (scope.kind !== 'thread' || signal.aborted) throw new Error('This app call is outside an active thread turn.');
          const thread = this.store.get(scope.threadId);
          if (!thread || thread.projectId !== scope.projectId || thread.ownerDeviceId !== o.deviceId) throw refuse(THREAD_NOT_FOUND, 404);
          if (name === 'jevellan_apps_list') return { schema: 'project-apps-v1', apps: this.apps.list(scope.projectId) };
          if (name === 'jevellan_app_stop') return this.apps.stop(scope.projectId, (input as { appId: string }).appId);
          const project = await this.#project(scope.projectId); const directory = project.paths[o.deviceId];
          if (!directory || !thread.cwd) throw new Error('This project has no local app directory.');
          return this.apps.start({ projectId: scope.projectId, threadId: scope.threadId, cwd: thread.cwd, projectDirectory: directory }, input, signal);
        },
        runtimeName: (runtime) => o.runtimes.get(runtime)?.displayName ?? runtime, enterOperation: o.enterOperation,
        timers: { threadTurnTimeoutMs: timers.threadTurnTimeoutMs, setupTimeoutMs: timers.setupTimeoutMs }, now } });
    this.tracker = new PullRequestTracker({ threads: this.store, github, git, worktrees, project: (projectId) => this.#project(projectId),
      toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event),
      transition: async (threadId, apply) => { const runner = this.threads.runner(threadId); if (runner) await runner.transition(apply); else await apply(); },
      hub: o.hub, redactor: o.redactor, now, pollMs: timers.prPollMs, periodic: timers.periodic });
    this.outbox = new Outbox({ paths: this.paths, hub: o.hub, deviceId: o.deviceId, redactor: o.redactor, timers,
      delivered: (envelope) => { if (envelope.targetDeviceId === o.deviceId) this.relayArrived(); } });
    this.inbox = new Inbox({ paths: this.paths, hub: o.hub, deviceId: o.deviceId, timers, handlers: {
      // Thread events from other devices may mean a slot freed there: the queue sweep follows (D264). A project whose coordinator
      // moved away hands its queue over with this event (3.5.4); before any assignment the event waits here (D6).
      coordinatorEvent: async (envelope) => {
        const { projectId } = envelope; await this.#project(projectId);
        const assigned = await this.coordinators.assignment(projectId);
        if (assigned !== null && assigned.deviceId !== o.deviceId) { await this.coordinators.handover(projectId, [envelope.body.event], assigned.revision); return; }
        this.coordinators.get(projectId).enqueue(envelope.body.event); this.threads.freed(projectId);
      },
      threadStart: (envelope) => this.#threadStart(envelope),
      threadCommand: (envelope) => this.#threadCommand(envelope),
    }, dropped: (lost) => this.#lostEnvelope(lost) });
    this.#attach = new ThreadAttach({ deviceId: o.deviceId, deviceName: o.deviceName, store: this.store, coordinators: coordinatorStore, hub: o.hub, roster: o.roster,
      runner: (threadId) => this.threads.runner(threadId), project: (projectId) => this.#project(projectId), main, accounts: o.accounts, transcripts: this.transcripts });
    this.views = new ProjectViews({ deviceId: o.deviceId, deviceName: o.deviceName, hub: o.hub, projects: o.projects, store: this.store, ledgers: this.ledgers,
      coordinators: this.coordinators, transcripts: this.transcripts, worktrees, accounts: o.accounts, runtimes: o.runtimes, settings: o.settings, roster: o.roster, placement });
    this.ready = Promise.all([this.apps.ready, recoverProjects({ paths: this.paths, ledgers: this.ledgers, store: this.store, coordinators: this.coordinators,
      toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event), redactor: o.redactor, now })]).then(() => undefined);
  }
  /**
   * A relayed envelope this device could not read was dropped (P8 review S-2): the project's chat here says what was lost. Without a
   * readable project of this device nothing can name it.
   */
  #lostEnvelope(lost: UnreadableEnvelope): void {
    if (lost.projectId === null || !this.paths.projectIds().includes(lost.projectId)) return;
    try { this.ledgers.coordinator(lost.projectId).append({ type: 'notice', data: { schema: 'project-notice-v1', text: relayedEnvelopeLost(lost), kind: 'error' } }); }
    catch { /* The ledger is unwritable; the inbox has dropped the envelope either way. */ }
  }
  async #project(projectId: string): Promise<Project> {
    const project = (await this.#o.projects.get(projectId))?.project; if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
    return project;
  }
  /** Coordinator tool handlers (brief 7.1), built on first use because the thread service and the tracker come after the coordinators. Memory is read-only. */
  #coordinatorTools(): CoordinatorToolHandlers {
    return this.#tools ??= coordinatorToolHandlers({ deviceId: this.#o.deviceId, deviceName: this.#o.deviceName, threads: this.threads, store: this.store, decisions: this.decisions,
      pullRequests: this.tracker, hub: this.#o.hub, ledgers: this.ledgers, mail: this.mail, roster: this.#o.roster, now: () => this.#timers.now(),
      memory: async (projectId) => this.#o.memory.project(await this.#project(projectId), this.#o.deviceId, () => { throw new Error(COORDINATOR_MEMORY_READ_ONLY); }) });
  }
  #thread(projectId: string, threadId: string): void {
    if (this.store.get(threadId)?.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
  }
  /**
   * A thread the coordinator device placed here (3.5.1 step 3): created once (an existing thread.json is a repeat) with this
   * device's labels, then prepared in the background unless it waits in the queue for the coordinator's dispatch. Its account was
   * ranked for this device at placement; the launcher ranks again here when it is no longer eligible (D16).
   */
  async #threadStart(envelope: EnvelopeOf<'thread-start'>): Promise<void> {
    const { thread } = envelope.body;
    if (thread.projectId !== envelope.projectId || thread.ownerDeviceId !== this.#o.deviceId) throw refuse(THREAD_STARTS_ELSEWHERE, 409);
    await this.#project(envelope.projectId);
    if (this.store.get(thread.id)) return;
    const [settings, accounts] = await Promise.all([this.#o.settings(), this.#o.accounts.list()]);
    this.store.create(thread, { modelLabel: settings.menu.find((entry) => entry.id === thread.placement.modelId)?.label ?? thread.placement.modelId,
      accountLabel: accounts.find((view) => view.account.id === thread.placement.accountId)?.account.label ?? thread.placement.accountId });
    if (thread.state === 'preparing') void this.threads.runner(thread.id)?.prepare();
  }
  /**
   * A command from another device for a thread here, applied once per command id (thread-local `seenCommands`, the newest 200).
   * A dispatch (preparation and first turn) and allow-turns (which waits for the thread's step chain) run in the background, so
   * the inbox never waits on a turn.
   */
  async #threadCommand(envelope: EnvelopeOf<'thread-command'>): Promise<void> {
    const { threadId, commandId, command } = envelope.body;
    this.#thread(envelope.projectId, threadId);
    if (this.store.local(threadId).seenCommands?.includes(commandId)) return;
    if (command.type === 'dispatch' || command.type === 'allow-turns') void this.threads.command(envelope.projectId, threadId, command).catch(() => undefined);
    else await this.threads.command(envelope.projectId, threadId, command);
    this.store.updateLocal(threadId, (local) => ({ ...local, seenCommands: [...(local.seenCommands ?? []).filter((id) => id !== commandId), commandId].slice(-200) }));
  }
  /**
   * Idempotent; after `bindDaemonUrl`. Queued starts and waiting turns may run from now on, coordinators deliver their queued
   * events in a new turn, and the periodic loops start when timers are periodic. No thread that recovery left at rest is
   * resumed (brief 8.6).
   */
  start(): void {
    if (this.#started || this.#closing) return;
    this.#started = true;
    void this.ready.then(() => {
      if (this.#closing) return;
      this.threads.begin();
      this.coordinators.begin();
      void this.threads.sweep().catch(() => undefined);
      void this.outbox.drain();
      this.inbox.start();
      if (!this.#timers.periodic) return;
      this.tracker.start();
      this.#sweepTimer = setInterval(() => { void this.threads.sweep().catch(() => undefined); this.coordinators.sweep(); }, this.#timers.queueSweepMs); this.#sweepTimer.unref();
    }, () => undefined);
  }
  /**
   * One round of the periodic work (tests and the UI refresh): PR poll, index flush, queue and waiting sweeps, coordinator re-checks
   * (D70), then the outbox drain and the inbox poll, which never fail (a hub outage leaves both for the next round).
   */
  async pulse(): Promise<void> {
    await this.ready;
    await this.tracker.poll();
    await this.#publisher.flush().catch(() => undefined);
    await this.threads.sweep();
    this.coordinators.sweep();
    await this.outbox.drain();
    await this.inbox.poll();
  }
  /** The hub stored an envelope for this device (the hub's relay route, or this device's own outbox): poll the inbox now. */
  relayArrived(): void {
    if (!this.#started || this.#closing) return;
    void this.ready.then(() => { if (!this.#closing) this.inbox.kick(); }, () => undefined);
  }
  /** Resolves when no start, sweep, thread step or coordinator turn is in flight or scheduled (test seam; checks every 20 ms, twice in a row). */
  async idle(projectId?: string): Promise<void> {
    await this.ready;
    for (let quiet = 0; quiet < 2;) {
      await delay(20); quiet = this.threads.busy(projectId) || this.coordinators.busy(projectId) || this.outbox.busy || this.inbox.busy ? 0 : quiet + 1;
    }
  }
  /** Stops timers, terminates every running turn (shutdown intent) and drains; thread states are never rewritten (D24). */
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      if (this.#sweepTimer) clearInterval(this.#sweepTimer);
      await this.ready.catch(() => undefined);
      // No new envelope is handled while turns stop; the outbox closes last, its entries stay on disk for the next start.
      await this.inbox.close();
      // Coordinator turns first (their tools start and message threads), then runners: tracker transitions wait on runner chains (2.6.14).
      await this.coordinators.close();
      await this.threads.close();
      await this.apps.close();
      await this.tracker.close();
      await this.#publisher.close();
      await this.outbox.close();
    })();
  }

  // Browser and API operations. Refusals throw Error(sentence) with a status.
  list(): Promise<ProjectWorkListView> { return this.views.list(); }
  view(projectId: string): Promise<ProjectWorkView> { return this.views.project(projectId); }
  coordinatorLedger(projectId: string): ProjectLedger { return this.ledgers.coordinator(projectId); }
  /**
   * The coordinator chat to stream (brief 11): this device's ledger when the coordinator runs here, or before any assignment
   * (an empty chat is valid). Another device's chat is proxied there by the route (D266).
   */
  async coordinatorEvents(projectId: string): Promise<ProjectLedger> {
    await this.#project(projectId);
    const deviceId = await this.coordinators.deviceOf(projectId);
    if (deviceId !== null && deviceId !== this.#o.deviceId) throw refuse(COORDINATOR_ELSEWHERE, 409);
    return this.ledgers.coordinator(projectId);
  }
  coordinatorDevice(projectId: string): Promise<string | null> { return this.coordinators.deviceOf(projectId); }
  /** The device that owns a thread: this device's thread file first, then the hub index. */
  async threadOwner(projectId: string, threadId: string): Promise<string | null> {
    const local = this.store.get(threadId); if (local) return local.projectId === projectId ? local.ownerDeviceId : null;
    const index = (await this.#o.hub.thread(threadId))?.document;
    return index && index.projectId === projectId ? index.ownerDeviceId : null;
  }
  /** Coordinators run on the device they are assigned to; the routes proxy another device's coordinator there (D266). */
  async #coordinatorHere(projectId: string): Promise<string> {
    await this.#project(projectId);
    const deviceId = await this.coordinators.ensureAssigned(projectId);
    if (deviceId !== this.#o.deviceId) throw refuse(COORDINATOR_ELSEWHERE, 409);
    return deviceId;
  }
  /** An owner message for the coordinator (brief 8.1): queued and flushed before the answer, idempotent by client id. */
  async postMessage(projectId: string, input: z.infer<typeof CoordinatorMessageRequestSchema>): Promise<{ repeated: boolean }> {
    await this.#coordinatorHere(projectId); const at = this.#timers.now();
    return this.coordinators.get(projectId).enqueue({ schema: 'coordinator-event-v1', kind: 'user-message', id: newId('cev', at), at: new Date(at).toISOString(),
      text: input.text, clientMessageId: input.clientMessageId });
  }
  /** The assigned coordinator when it runs here; null before any assignment. The routes proxy another device's coordinator there. */
  async #assignedHere(projectId: string): Promise<Coordinator | null> {
    await this.#project(projectId);
    const deviceId = await this.coordinators.deviceOf(projectId);
    if (deviceId === null) return null;
    if (deviceId !== this.#o.deviceId) throw refuse(COORDINATOR_ELSEWHERE, 409);
    return this.coordinators.get(projectId);
  }
  /**
   * Move coordinator here (brief phase 5, 3.5.3): this device takes the project's coordinator over when the device that holds it is
   * offline or its coordinator runs no turn, else 409. The queued threads on other devices are read at the next sweep, and the
   * inbox is read at once.
   */
  async moveCoordinatorHere(projectId: string): Promise<void> {
    await this.#project(projectId);
    await this.coordinators.moveHere(projectId);
    this.threads.coordinating(projectId);
    // Events the hub retargeted to this device with the move (D270) arrive now rather than at the next poll.
    this.relayArrived();
  }
  /** Interrupts the running coordinator turn (brief 8.1); its events count as delivered (D33). Nothing to stop before assignment. */
  async stopCoordinator(projectId: string): Promise<void> { await (await this.#assignedHere(projectId))?.stop(); }
  /** The next coordinator turn starts a fresh session (D77). Before assignment there is no session, and Fresh assigns nothing (D206). */
  async freshCoordinator(projectId: string): Promise<void> { (await this.#assignedHere(projectId))?.fresh(); }
  async settingsView(projectId: string): Promise<z.infer<typeof ProjectWorkSettingsViewSchema>> {
    const project = await this.#project(projectId);
    return this.#settingsView(project, (await this.#o.hub.settings(projectId))?.document ?? null);
  }
  #settingsView(project: Project, stored: ProjectWorkSettings | null) {
    const shown = effectiveSettings(stored ?? defaultProjectWorkSettings(project.id), project);
    return ProjectWorkSettingsViewSchema.parse({ schema: 'project-work-settings-view-v1', settings: shown.settings, ...(shown.notice ? { notice: shown.notice } : {}) });
  }
  /** Settings 5.1 with a revision check; a conflict is the owner's reload sentence. */
  async putSettings(projectId: string, input: z.infer<typeof ProjectWorkSettingsRequestSchema>, clientRequestId?: string): Promise<z.infer<typeof ProjectWorkSettingsViewSchema>> {
    const project = await this.#project(projectId);
    const settings = ProjectWorkSettingsSchema.parse({ ...input.settings, schema: 'project-work-settings-v1', projectId, revision: input.revision });
    const requestId = input.clientRequestId ?? clientRequestId;
    try { return this.#settingsView(project, (await this.#o.hub.putSettings(settings, input.revision, ...(requestId === undefined ? [] : [requestId]))).document); }
    catch (error) { if (statusOf(error) === 409) throw refuse(SETTINGS_CHANGED, 409); throw error; }
  }
  async notebookView(projectId: string): Promise<z.infer<typeof ProjectNotebookViewSchema>> {
    await this.#project(projectId); const stored = await this.#o.hub.notebook(projectId);
    return ProjectNotebookViewSchema.parse({ schema: 'project-notebook-view-v1', notebook: stored?.document ?? null, revision: stored?.revision ?? 0 });
  }
  async putNotebook(projectId: string, input: z.infer<typeof NotebookRequestSchema>): Promise<z.infer<typeof ProjectNotebookViewSchema>> {
    await this.#project(projectId);
    const notebook = ProjectNotebookSchema.parse({ schema: 'project-notebook-v1', projectId, revision: input.expectedRevision, content: input.content,
      updatedAt: new Date(this.#timers.now()).toISOString(), updatedBy: 'owner' });
    try {
      const stored = await this.#o.hub.putNotebook(notebook, input.expectedRevision);
      return ProjectNotebookViewSchema.parse({ schema: 'project-notebook-view-v1', notebook: stored.document, revision: stored.revision });
    } catch (error) { if (statusOf(error) === 409) throw refuse(NOTEBOOK_CHANGED, 409); throw error; }
  }
  /**
   * New thread from the owner (3.1): assigns the coordinator here when none, then the start path with receipts (D78). A restart's
   * new thread from another device carries the owner's note for placement (D266).
   */
  async createThread(projectId: string, input: ThreadCreateRequest): Promise<z.infer<typeof ThreadCreatedViewSchema>> {
    const coordinatorDeviceId = await this.#coordinatorHere(projectId);
    const started = await this.threads.start({ projectId, title: input.title, task: input.task, createdBy: 'owner', clientRequestId: input.clientRequestId, coordinatorDeviceId, note: input.note,
      fixed: { ...(input.isolation ? { isolation: input.isolation } : {}), ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.effort ? { effort: input.effort } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}) } });
    return ThreadCreatedViewSchema.parse({ schema: 'thread-created-view-v1', threadId: started.threadId, state: started.state, placement: started.placement });
  }
  threadView(projectId: string, threadId: string): Promise<ThreadView> { return this.views.thread(projectId, threadId); }
  async threadMessage(projectId: string, threadId: string, input: z.infer<typeof ThreadMessageRequestSchema>): Promise<{ repeated: boolean }> {
    const result = await this.threads.message(projectId, threadId, 'owner', input.text, input.interrupt, input.clientMessageId);
    return { repeated: result.repeated };
  }
  /** Stop from the thread page: `Stopped by you.` unless a reason is given; the coordinator is told (D28). */
  stopThread(projectId: string, threadId: string, input?: z.infer<typeof ThreadStopRequestSchema>): Promise<void> {
    return this.threads.stop(projectId, threadId, input?.reason || STOPPED_BY_YOU, true);
  }
  discardThread(projectId: string, threadId: string): Promise<void> { return this.threads.discard(projectId, threadId); }
  allowTurns(projectId: string, threadId: string): Promise<void> { return this.threads.allowTurns(projectId, threadId); }
  /**
   * Override from the thread page (brief 10, 12.3): from the next turn on this device, or a restart whose new thread starts on
   * the coordinator device like any new thread (D9a), assigning the coordinator here when none; `remote` reaches a coordinator
   * on another device (D266).
   */
  async overrideThread(projectId: string, threadId: string, input: z.infer<typeof ThreadOverrideRequestSchema>, remote?: RemoteStart): Promise<z.infer<typeof ThreadOverrideViewSchema>> {
    this.#thread(projectId, threadId);
    if (input.mode === 'next-turn') { await this.threads.overrideNextTurn(projectId, threadId, input); return ThreadOverrideViewSchema.parse({ schema: 'thread-override-view-v1' }); }
    await this.#project(projectId);
    const { newThreadId } = await this.threads.restart(projectId, threadId, input, await this.coordinators.ensureAssigned(projectId), remote);
    return ThreadOverrideViewSchema.parse({ schema: 'thread-override-view-v1', newThreadId });
  }
  async mergePullRequest(projectId: string, threadId: string): Promise<MergeResultView> { this.#thread(projectId, threadId); return this.tracker.merge(threadId); }
  async refreshPullRequest(projectId: string, threadId: string): Promise<void> { this.#thread(projectId, threadId); await this.tracker.refresh(threadId); }
  answerDecision(projectId: string, decisionId: string, input: z.infer<typeof DecisionAnswerRequestSchema>): Promise<{ repeated: boolean }> {
    return this.decisions.answer(projectId, decisionId, input);
  }
  /**
   * Terminal takeover (brief phase 7), for the local control routes only: the answer carries the native session id and the account's
   * credentials, so it never goes through the redactor and never leaves the loopback socket.
   */
  async attach(threadId: string): Promise<ThreadAttachView> { await this.ready; return this.#attach.attach(threadId); }
  /**
   * Detach also frees the thread's account (phase 8): threads waiting for it and coordinators waiting as `Unavailable` are checked now,
   * not at the next sweep.
   */
  async detach(threadId: string): Promise<ThreadDetachView> {
    await this.ready;
    const detached = await this.#attach.detach(threadId);
    const projectId = this.store.get(threadId)?.projectId;
    if (projectId) this.threads.freed(projectId);
    this.coordinators.sweep();
    return detached;
  }
}
