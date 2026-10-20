import { overrideOffered, overrideEditorView, overrideEditorRequest } from './override-editor.js';
import { fallbackChip, threadWhyView } from './thread-why.js';
import { threadActionView, threadCardView } from './card-views.js';
import { overviewBoard } from './owner-status.js';
import { ProjectSidebarViewSchema, type ProjectSidebarView } from '@jevellan/core';
/** Sidebar order: by name without regard to case, so rows never move while their counts change. */
export function sidebarOrder<T extends { name: string; projectId: string }>(rows: readonly T[]): T[] { return [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.projectId.localeCompare(b.projectId)); }
export function sidebarView(rows: ProjectWorkListView['projects']): ProjectSidebarView {
  const projects = sidebarOrder(rows), active = projects.filter(row => row.status !== 'archived');
  return ProjectSidebarViewSchema.parse({ schema: 'project-sidebar-view-v1', projects,
    activeIds: active.map(row => row.projectId), archivedIds: projects.filter(row => row.status === 'archived').map(row => row.projectId),
    defaultProject: active[0]?.projectId ?? null, waitingTotal: active.reduce((total, row) => total + row.waiting, 0) });
}
import { boardGroup } from '@jevellan/core';
import type { AccountService } from '@jevellan/accounts';
import {
  ProjectWorkListViewSchema, ProjectWorkViewSchema, ThreadViewSchema, clipRedacted, defaultProjectWorkSettings, deviceAway, isTerminal, openQuestions, projectPathProblem, type AccountView, type Configuration, type CoordinatorState,
  type CoordinatorView, type Project,
  type ProjectDecision, type ProjectHub, type ProjectLedgerEvent, type ProjectWorkListView, type ProjectWorkSettings, type ProjectWorkSummary, type ProjectWorkView,
  type PullRequestEntry, type SharedProjects, type ThreadIndex, type ThreadReport, type ThreadView, type SessionCacheSummary,
} from '@jevellan/core';
import type { PlacementGates } from '@jevellan/decisions';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import { BRANCH_PUSHED_NO_TOKEN, NOT_GITHUB, PROJECT_NOT_FOUND, THREAD_NOT_FOUND, attachCommand, attachedRefusal, checkoutStillHeld } from './copy.js';
import { coordinatorMovable, coordinatorPlan, type CoordinatorService } from './coordinator.js';
import type { ProjectLedgers } from './ledger.js';
import { PHASE_GATES, type DeviceRoster, type Placement } from './placement.js';
import { type ThreadStore } from './stores.js';
import { atTurnLimit, canContinueThread, isDiscarded, restartRefusal } from './thread-runner.js';
import type { ThreadTranscripts } from './transcript.js';
import type { ThreadWorktree } from './worktree.js';
import { cacheRecords, sessionCacheKey, sessionCacheSummaries } from './session-cache.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
/**
 * Where the coordinator lives: its local state here, the session and last event id it published elsewhere, and whether it may move
 * to this device (`canMoveHere`, 3.5.3).
 */
type CoordinatorWhere = { deviceId: string | null; deviceName: string | null; state: CoordinatorView['state']; unavailableReason?: string; online: boolean;
  movable: boolean; local?: CoordinatorState; published?: CoordinatorView['session']; lastEventId?: number; sessionCache?: SessionCacheSummary[]; sessionHistory?: import('@jevellan/core').CoordinatorView['sessionHistory'] };
const ANSWERED_SHOWN = 10;
const BRANCH_ONLY = [BRANCH_PUSHED_NO_TOKEN, NOT_GITHUB];

// Pure builders, exported for unit tests.

/** Open questions and the last answered ones, newest answer first (brief 11, 12.2). */
export function decisionLists(decisions: readonly ProjectDecision[]): { open: ProjectDecision[]; answered: ProjectDecision[] } {
  return {
    open: openQuestions(decisions),
    answered: decisions.filter((decision) => decision.answer).sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')).slice(0, ANSWERED_SHOWN),
  };
}
/** Sidebar counts (D257): a core rule, because the hub computes them for the members' list (D267). */
export { workCounts } from '@jevellan/core';
/** Pull requests from the thread indexes, plus branch-only threads with their reason (brief 12.2). */
export function pullRequestEntries(threads: readonly ThreadIndex[]): PullRequestEntry[] {
  return threads.flatMap((thread): PullRequestEntry[] => {
    const branch = thread.branch === undefined ? {} : { branch: thread.branch };
    if (thread.pr) return [{ threadId: thread.id, title: thread.title, ...branch, pr: thread.pr }];
    if (thread.state === 'idle' && thread.branch !== undefined && BRANCH_ONLY.includes(thread.stateReason ?? '')) return [{ threadId: thread.id, title: thread.title, ...branch, reason: thread.stateReason! }];
    return [];
  });
}
/**
 * Settings as threads apply them (brief 5.1, 3.1 step 2b): a main default shows as worktree with the reason, the Leave git
 * notice on a project that leaves git to the owner, else the phase text while main isolation is gated (D88).
 */
export function effectiveSettings(settings: ProjectWorkSettings, project: Pick<Project, 'branchPolicy'> & Partial<Pick<Project, 'memory'>>, gates: Pick<PlacementGates, 'mainIsolation'> = PHASE_GATES): { settings: ProjectWorkSettings; notice?: string } {
  if (project.memory && project.memory.mode !== settings.memory.mode) settings = { ...settings, memory: { ...settings.memory, mode: project.memory.mode } };
  void gates; return { settings };
}

export type ProjectViewsOptions = {
  deviceId: string; deviceName: string;
  hub: Pick<ProjectHub, 'threads' | 'decisions' | 'settings' | 'coordinator' | 'coordinatorStatus' | 'notebook' | 'workSummaries' | 'sessionCaches' | 'tasks'>;
  projects: Pick<SharedProjects, 'get' | 'list'>;
  store: Pick<ThreadStore, 'get' | 'labels' | 'local' | 'index'>; ledgers: ProjectLedgers; coordinators: Pick<CoordinatorService, 'get'>;
  transcripts: Pick<ThreadTranscripts, 'read'>; worktrees: Pick<ThreadWorktree, 'repository' | 'baseBranch'>;
  accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
  mergesHeld?(projectId: string, threadId: string): Promise<boolean>;
  githubNotice?(projectId: string): Promise<string | undefined>; settings(): Promise<Configuration['x-jevellan']>; roster(): Promise<DeviceRoster>;
  /** The per-device setup of New thread and Override (D281). */
  placement: Pick<Placement, 'deviceSetup'>;
};

/** The Projects HTTP views (brief 11, design 2.1.4) for phase 1: the project list, the project page and a local thread. */
export class ProjectViews {
  readonly #o: ProjectViewsOptions;
  readonly #bases = new Map<string, Promise<string | null>>();
  constructor(o: ProjectViewsOptions) { this.#o = o; }
  async #project(projectId: string): Promise<Project> {
    const project = (await this.#o.projects.get(projectId))?.project; if (!project) throw refuse(PROJECT_NOT_FOUND, 404);
    return project;
  }
  async #threads(projectId: string): Promise<ThreadIndex[]> {
    const threads: ThreadIndex[] = []; let after: string | undefined;
    do { const page = await this.#o.hub.threads(projectId, after); threads.push(...page.records.filter((index) => index.projectId === projectId)); after = page.next ?? undefined; } while (after !== undefined);
    for (const thread of threads) if (thread.pr) delete thread.pr.review;
    return threads;
  }
  /** The base branch of the project checkout here (D93), detected once per project; null without a checkout. */
  #base(project: Project): Promise<string | null> {
    let base = this.#bases.get(project.id);
    if (!base) {
      base = (async () => this.#o.worktrees.baseBranch(this.#o.worktrees.repository(project)))().catch(() => null);
      this.#bases.set(project.id, base);
      void base.then((value) => { if (value === null) this.#bases.delete(project.id); });
    }
    return base;
  }
  /**
   * Where the coordinator lives and its state (D5, D80, D91): `none` before assignment, `offline` when the roster says so, else
   * the state of the coordinator device (its local file here, the status it published elsewhere; a status a former coordinator
   * device left reads as none yet, so idle). The list rows need only this (D246); the chip adds the sessions. Elsewhere, the
   * coordinator may move here by the move route's own rule (D269).
   */
  async #coordinatorState(projectId: string, roster: DeviceRoster): Promise<CoordinatorWhere> {
    const deviceId = (await this.#o.hub.coordinator(projectId))?.document.deviceId ?? null; const here = deviceId === this.#o.deviceId;
    const row = deviceId === null ? undefined : roster.devices.find((view) => view.device.id === deviceId);
    const deviceName = here ? this.#o.deviceName : row?.device.name ?? null;
    if (deviceId === null) return { deviceId, deviceName, state: 'none' as const, online: false, movable: false };
    // This device is running, so it is never offline to itself (D8); a stale device keeps its state (D80).
    if (!here && deviceAway(row)) return { deviceId, deviceName, state: 'offline' as const, online: false, movable: true };
    if (here) {
      const local = this.#o.coordinators.get(projectId).state();
      return { deviceId, deviceName, state: local.state, ...(local.unavailableReason ? { unavailableReason: local.unavailableReason } : {}), online: true, movable: false, local };
    }
    const published = (await this.#o.hub.coordinatorStatus(projectId))?.document;
    const status = published?.deviceId === deviceId ? published : undefined;
    return { deviceId, deviceName, state: status?.state ?? 'idle', ...(status?.unavailableReason ? { unavailableReason: status.unavailableReason } : {}), online: true,
      movable: coordinatorMovable(deviceId, row, status), published: status?.session ?? null, lastEventId: status?.lastEventId ?? 0, sessionCache: status?.sessionCache ?? [], sessionHistory: status?.sessionHistory ?? [] };
  }
  /**
   * A list row's coordinator from the hub's summary (D267), by the `#coordinatorState` rules: here the local state; elsewhere
   * offline by the roster's presence (or when the device is unknown), else the state it published (idle before any).
   */
  #summaryState(summary: ProjectWorkSummary): { deviceId: string | null; state: ProjectWorkListView['projects'][number]['coordinator']['state'] } {
    const where = summary.coordinator; if (!where) return { deviceId: null, state: 'none' };
    if (where.deviceId === this.#o.deviceId) return { deviceId: where.deviceId, state: this.#o.coordinators.get(summary.projectId).state().state };
    if (!where.device || where.device.status === 'offline' || where.device.revoked) return { deviceId: where.deviceId, state: 'offline' };
    return { deviceId: where.deviceId, state: where.state ?? 'idle' };
  }
  /**
   * The coordinator chip: the coordinator state with the session here or elsewhere, and the planned one. Where the move rule lets the
   * coordinator come here, `moveRefusal` says why this device still cannot run it (D282): the plan here, then the project's path in the
   * settings (the move itself also checks the checkout).
   */
  #coordinator(where: CoordinatorWhere, work: ProjectWorkSettings, project: Project, config: Configuration['x-jevellan'], accounts: AccountView[]): CoordinatorView {
    const label = (modelId: string) => config.menu.find((entry) => entry.id === modelId)?.label ?? modelId;
    const plan = (deviceId: string, deviceName: string) => coordinatorPlan({ work, settings: config, runtimes: new Map([...this.#o.runtimes].map(([id, adapter]) => [id, adapter.capabilities])),
      accounts: accounts.map((view) => view.account), statuses: accounts.flatMap((view) => view.statuses), deviceId, deviceName });
    const there = plan(where.deviceId ?? this.#o.deviceId, where.deviceName ?? this.#o.deviceName);
    const planned = there.kind === 'ready' ? { runtime: there.model.runtime, modelLabel: there.model.label, effort: there.effort } : null;
    const here = where.movable ? plan(this.#o.deviceId, this.#o.deviceName) : undefined;
    const moveRefusal = here && (here.kind === 'unavailable' ? here.reason : projectPathProblem(project, this.#o.deviceId, this.#o.deviceName));
    const session = where.local?.session;
    return { deviceId: where.deviceId, deviceName: where.deviceName, planned, canMoveHere: where.movable, ...(moveRefusal ? { moveRefusal: moveRefusal.slice(0, 400) } : {}), state: where.state,
      ...(where.unavailableReason ? { unavailableReason: where.unavailableReason } : {}), online: where.online,
      sessionHistory: where.local ? this.#o.coordinators.get(project.id).sessionHistory().map(({ nativeSessionId: _native, ...entry }) => { void _native; return entry; }) : where.sessionHistory ?? [],
      session: session ? { runtime: session.runtime, modelLabel: label(session.modelId), effort: session.effort,
        accountLabel: accounts.find((view) => view.account.id === session.accountId)?.account.label ?? session.accountId, turns: session.turns, ...(session.context ? { context: session.context } : {}),
        ...(session.nativeSessionId ? { cacheSessionKey: sessionCacheKey({ kind: 'coordinator', id: project.id }, session.runtime, session.accountId, session.nativeSessionId) } : {}) }
        : where.published ?? null };
  }
  async #work(projectId: string): Promise<ProjectWorkSettings> { return (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId); }
  /**
   * `GET /api/project-work`: every project with its counts and coordinator state. Every open page polls it, so it reads only
   * what the rows show (D246), and all of it in one hub read (D267): on a member, one hub request per poll whatever the number
   * of projects.
   */
  async list(): Promise<ProjectWorkListView> {
    const summaries = await this.#o.hub.workSummaries();
    // Sidebar order is by name so rows never move while their counts change; the dot is the coordinator working, then open questions.
    const rows = summaries.map((summary) => { const coordinator = this.#summaryState(summary); return { projectId: summary.projectId, name: summary.name, ...(summary.status ? { status: summary.status } : {}),
      waiting: summary.waiting, running: summary.running, inReview: summary.inReview, coordinator, attention: coordinator.state === 'running' ? 'running' as const : summary.waiting ? 'waiting-for-you' as const : 'idle' as const }; })
    return ProjectWorkListViewSchema.parse({ schema: 'project-work-list-view-v1', projects: sidebarOrder(rows) });
  }
  async sidebar(): Promise<ProjectSidebarView> { return sidebarView((await this.list()).projects); }
  async #drafts(projectId: string): Promise<number> { try { const page = await this.#o.hub.tasks(projectId); return page.records.filter(task => task.state === 'draft').length; } catch { return 0; } }
  /** `GET /api/projects/:id/work`: the project page. */
  async project(projectId: string): Promise<ProjectWorkView> {
    const project = await this.#project(projectId);
    const [threads, decisions, work, notebook, roster, baseBranch, config, accounts] = await Promise.all([this.#threads(projectId), this.#o.hub.decisions(projectId),
      this.#work(projectId), this.#o.hub.notebook(projectId), this.#o.roster(), this.#base(project), this.#o.settings(), this.#o.accounts.list()]);
    const githubNotice = await this.#o.githubNotice?.(projectId);
    const shown = effectiveSettings(work, project); const where = await this.#coordinatorState(projectId, roster);
    // The chat history bound the page opens with (D268): this device's ledger, or the last event id a coordinator elsewhere published.
    const lastEventId = where.deviceId === null || where.deviceId === this.#o.deviceId ? this.#o.ledgers.coordinator(projectId).lastId() : where.lastEventId ?? 0;
    // Threads are placed on the coordinator's device; while it is away, the only way on is moving it here, so this device places (D281).
    const placing = where.deviceId === null || where.state === 'offline' ? this.#o.deviceId : where.deviceId;
    const coordinator = this.#coordinator(where, work, project, config, accounts);
    const cacheSnapshots = await this.#o.hub.sessionCaches?.(projectId) ?? [];
    const summaries = [...cacheSnapshots.filter(row => row.deviceId !== this.#o.deviceId).flatMap(row => row.records),
      ...sessionCacheSummaries(cacheRecords(this.#o.ledgers.coordinator(projectId)), work.nightlyWindow.timezone),
      ...(where.deviceId !== this.#o.deviceId ? where.sessionCache ?? [] : []), ...threads.flatMap(thread => thread.sessionCache ?? [])];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: work.nightlyWindow.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const cacheRows = [...new Map(summaries.filter(row => row.day === today).map(row => [`${row.day}:${row.key}`, row])).values()];
    const devices = this.#o.placement.deviceSetup(project, work, roster, placing, { settings: config, accounts });
    return ProjectWorkViewSchema.parse({ schema: 'project-work-view-v1', project: { id: project.id, name: project.name, branchPolicy: project.branchPolicy, baseBranch },
      sessionCache: cacheRows,
      settings: shown.settings, ...(githubNotice ? { githubNotice } : {}), ...(shown.notice ? { settingsNotice: shown.notice } : {}), coordinator, threads,
      decisions: decisionLists(decisions), pullRequests: pullRequestEntries(threads), notebookRevision: notebook?.revision ?? 0, lastEventId, gates: PHASE_GATES, devices, board: overviewBoard(threads), needsOwner: decisionLists(decisions).open.length + threads.filter(thread => boardGroup(thread) === 'waiting').length + await this.#drafts(projectId) });
  }
  /** Owner-target projection: the base is this thread's recorded base, independent of the caller's checkout. */
  async actions(projectId: string, threadId: string) {
    const thread = this.#o.store.get(threadId);
    if (!thread || thread.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
    const ledger = this.#o.ledgers.thread(projectId, threadId);
    const index = this.#o.store.index(thread, this.#o.store.labels(threadId), ledger.events().at(-1)?.t ?? thread.createdAt);
    const held = await this.#o.mergesHeld?.(projectId, threadId).catch(() => undefined);
    return threadActionView(index, held ?? index.landingStage === 'held', thread.baseBranch);
  }
  /** `GET /api/projects/:id/threads/:tid` for a thread this device owns (D81 `canMessage`; overrides as the API allows them, D252). */
  async overrideEditor(projectId: string, threadId: string, preview?: unknown) {
    const [view, work, config, roster] = await Promise.all([this.thread(projectId, threadId), this.project(projectId), this.#o.settings(), this.#o.roster()]);
    const modelName = (id: string) => { const entry = config.menu.find(row => row.id === id); return entry ? `${this.#o.runtimes.get(entry.runtime)?.displayName ?? entry.runtime} ${entry.label}` : id; };
    return overrideEditorView(projectId, view, work, config.menu, roster.devices, this.#o.deviceId, modelName, preview);
  }
  async overrideEditorInput(projectId: string, threadId: string, raw: unknown) {
    const [view, config] = await Promise.all([this.thread(projectId, threadId), this.#o.settings()]);
    return overrideEditorRequest(view, config.menu, raw);
  }
  async why(projectId: string, threadId: string) {
    const [view, config, accounts, roster] = await Promise.all([this.thread(projectId, threadId), this.#o.settings(), this.#o.accounts.list(), this.#o.roster()]);
    const runtime = (id: string) => this.#o.runtimes.get(id)?.displayName ?? id;
    return threadWhyView(projectId, view, {
      runtime, model: id => { const entry = config.menu.find(row => row.id === id); return entry ? `${runtime(entry.runtime)} ${entry.label}` : id; },
      device: id => id === this.#o.deviceId ? this.#o.deviceName : roster.devices.find(row => row.device.id === id)?.device.name ?? id,
      account: id => accounts.find(row => row.account.id === id)?.account.label ?? (id === view.placement.accountId ? view.thread.accountLabel : id),
    });
  }
  async thread(projectId: string, threadId: string): Promise<ThreadView> {
    const thread = this.#o.store.get(threadId);
    if (!thread || thread.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
    const project = await this.#project(projectId); const ledger = this.#o.ledgers.thread(projectId, threadId); const events = ledger.events();
    const reports = events.filter((event) => event.type === 'thread-report').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'thread-report' }) as ThreadReport);
    const fixTurns = events.filter(event => event.type === 'thread-turn-start').flatMap(event => { const start = ledger.payload(event as ProjectLedgerEvent & { type: 'thread-turn-start' }); return start.fix ? [{ turn: start.turn, fix: start.fix }] : []; });
    // The page keeps working when the native session cannot be read; the transcript is just absent.
    const transcript = await this.#o.transcripts.read(thread, project.name).catch(() => null);
    const restartReason = restartRefusal(thread);
    // An ended main thread whose claim the sweeps are still settling says why the checkout stays held (phase 8, D291).
    const kept = isTerminal(thread.state) ? this.#o.store.local(threadId).unsettledCheckout?.message : undefined;
    const routed = events.findLast(event => event.type === 'thread-message-route');
    const mergesHeld = await this.#o.mergesHeld?.(projectId, threadId).catch(() => undefined);
    const index = { ...this.#o.store.index(thread, this.#o.store.labels(threadId), events.at(-1)?.t ?? thread.createdAt), sessionCache: sessionCacheSummaries(cacheRecords(ledger)).slice(-500) };
    const canOverride = { nextTurn: !isTerminal(thread.state), restart: !restartReason, ...(restartReason ? { restartReason } : {}) };
    return ThreadViewSchema.parse({ schema: 'project-thread-view-v1', thread: index, overrideEditorPath: overrideOffered({ canOverride }) ? `/api/projects/${projectId}/threads/${threadId}/override-editor` : null, placementNotice: fallbackChip(thread.placement),
      card: threadCardView(index, { deviceName: () => this.#o.deviceName, runtimeName: id => this.#o.runtimes.get(id)?.displayName ?? id, held: mergesHeld ?? index.landingStage === 'held', baseBranch: thread.baseBranch }),
      ...(this.#o.store.local(threadId).memoryRecall ? { memoryRecall: this.#o.store.local(threadId).memoryRecall } : {}),
      ...(this.#o.store.local(threadId).escalations ? { escalations: this.#o.store.local(threadId).escalations } : {}),
      notices: events.filter(event => event.type === 'notice').slice(-20).map(event => { const notice = ledger.payload(event as ProjectLedgerEvent & { type: 'notice' }); return { at: event.t, text: clipRedacted(notice.text, 4000), kind: notice.kind }; }),
      sessionHistory: (this.#o.store.local(threadId).sessionHistory ?? []).map(({ nativeSessionId: _native, ...entry }) => { void _native; return entry; }),
      placement: thread.placement, reports, ...(fixTurns.length ? { fixTurns } : {}), transcript, queuedMessages: thread.queuedMessages,
      ...(routed ? { messageRoute: ledger.payload(routed as typeof routed & { type: 'thread-message-route' }) } : {}),
      ...(mergesHeld === undefined ? {} : { mergesHeld }),
      canMessage: thread.state !== 'attached' && canContinueThread(thread), turnAllowance: thread.turnAllowance, deviceName: this.#o.deviceName,
      baseBranch: thread.baseBranch, ...(thread.attach ? { attach: thread.attach } : {}), attachCommand: attachCommand(threadId),
      canOverride, atTurnLimit: atTurnLimit(thread),
      canDiscard: (thread.state === 'stopped' || thread.state === 'failed') && thread.isolation === 'worktree' && !isDiscarded(thread.stateReason),
      ...(thread.state === 'attached' ? { stopRefusal: attachedRefusal(threadId) } : {}), ...(kept ? { checkoutHeld: checkoutStillHeld(kept) } : {}) });
  }
}
