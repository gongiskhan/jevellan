import type { AccountService } from '@jevellan/accounts';
import {
  ProjectWorkListViewSchema, ProjectWorkViewSchema, ThreadViewSchema, defaultProjectWorkSettings, runningSection, type Configuration, type CoordinatorView, type Project,
  type ProjectDecision, type ProjectHub, type ProjectLedgerEvent, type ProjectWorkListView, type ProjectWorkSettings, type ProjectWorkView, type PullRequestEntry,
  type SharedProjects, type ThreadIndex, type ThreadReport, type ThreadView,
} from '@jevellan/core';
import type { PlacementGates } from '@jevellan/decisions';
import type { RuntimeAdapter } from '@jevellan/runtime-contract';
import { BRANCH_PUSHED_NO_TOKEN, LEAVE_GIT_SETTING, MAIN_NOT_AVAILABLE, NOT_GITHUB, PROJECT_NOT_FOUND, THREAD_NOT_FOUND, attachCommand } from './copy.js';
import { coordinatorPlan, type CoordinatorService } from './coordinator.js';
import type { ProjectLedgers } from './ledger.js';
import { PHASE_GATES, type DeviceRoster } from './placement.js';
import { threadIndex, type ThreadStore } from './stores.js';
import { atTurnLimit, isDiscarded } from './thread-runner.js';
import type { ThreadTranscripts } from './transcript.js';
import type { ThreadWorktree } from './worktree.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const ANSWERED_SHOWN = 10;
const BRANCH_ONLY = [BRANCH_PUSHED_NO_TOKEN, NOT_GITHUB];

// Pure builders, exported for unit tests.

/** Open questions and the last answered ones, newest answer first (brief 11, 12.2). */
export function decisionLists(decisions: readonly ProjectDecision[]): { open: ProjectDecision[]; answered: ProjectDecision[] } {
  return {
    open: decisions.filter((decision) => !decision.answer && !decision.withdrawnAt),
    answered: decisions.filter((decision) => decision.answer).sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')).slice(0, ANSWERED_SHOWN),
  };
}
/** Sidebar counts: open questions, the Running section (display only, not the limit count) and threads in review. */
export function workCounts(threads: readonly ThreadIndex[], decisions: readonly ProjectDecision[]): { waiting: number; running: number; inReview: number } {
  return { waiting: decisionLists(decisions).open.length, running: threads.filter((thread) => runningSection(thread.state)).length,
    inReview: threads.filter((thread) => thread.state === 'in-review').length };
}
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
export function effectiveSettings(settings: ProjectWorkSettings, project: Pick<Project, 'branchPolicy'>, gates: Pick<PlacementGates, 'mainIsolation'> = PHASE_GATES): { settings: ProjectWorkSettings; notice?: string } {
  if (settings.defaultIsolation !== 'main') return { settings };
  const worktree: ProjectWorkSettings = { ...settings, defaultIsolation: 'worktree' };
  if (project.branchPolicy !== 'main') return { settings: worktree, notice: LEAVE_GIT_SETTING };
  return gates.mainIsolation ? { settings } : { settings: worktree, notice: MAIN_NOT_AVAILABLE };
}

export type ProjectViewsOptions = {
  deviceId: string; deviceName: string;
  hub: Pick<ProjectHub, 'threads' | 'decisions' | 'settings' | 'coordinator' | 'coordinatorStatus' | 'notebook'>;
  projects: Pick<SharedProjects, 'get' | 'list'>;
  store: Pick<ThreadStore, 'get' | 'labels'>; ledgers: ProjectLedgers; coordinators: Pick<CoordinatorService, 'get'>;
  transcripts: Pick<ThreadTranscripts, 'read'>; worktrees: Pick<ThreadWorktree, 'repository' | 'baseBranch'>;
  accounts: Pick<AccountService, 'list'>; runtimes: ReadonlyMap<string, RuntimeAdapter>;
  settings(): Promise<Configuration['x-jevellan']>; roster(): Promise<DeviceRoster>;
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
   * the state of the coordinator device (its local file here, the published status elsewhere). The list rows need only this
   * (D246); the chip adds the sessions.
   */
  async #coordinatorState(projectId: string, roster: DeviceRoster) {
    const deviceId = (await this.#o.hub.coordinator(projectId))?.document.deviceId ?? null; const here = deviceId === this.#o.deviceId;
    const row = deviceId === null ? undefined : roster.devices.find((view) => view.device.id === deviceId);
    const deviceName = here ? this.#o.deviceName : row?.device.name ?? null;
    if (deviceId === null) return { deviceId, deviceName, state: 'none' as const, online: false };
    // This device is running, so it is never offline to itself (D8); a stale device keeps its state (D80).
    if (!here && (!row || row.status === 'offline' || row.revoked)) return { deviceId, deviceName, state: 'offline' as const, online: false };
    if (here) {
      const local = this.#o.coordinators.get(projectId).state();
      return { deviceId, deviceName, state: local.state, ...(local.unavailableReason ? { unavailableReason: local.unavailableReason } : {}), online: true, local };
    }
    const status = (await this.#o.hub.coordinatorStatus(projectId))?.document;
    return { deviceId, deviceName, state: status?.state ?? 'idle', ...(status?.unavailableReason ? { unavailableReason: status.unavailableReason } : {}), online: true,
      published: status?.session ?? null };
  }
  /** The coordinator chip: the coordinator state with the session here or elsewhere, and the planned one. */
  async #coordinator(projectId: string, roster: DeviceRoster, work: ProjectWorkSettings): Promise<CoordinatorView> {
    const [where, config, accounts] = await Promise.all([this.#coordinatorState(projectId, roster), this.#o.settings(), this.#o.accounts.list()]);
    const label = (modelId: string) => config.menu.find((entry) => entry.id === modelId)?.label ?? modelId;
    const plan = coordinatorPlan({ work, settings: config, runtimes: new Map([...this.#o.runtimes].map(([id, adapter]) => [id, adapter.capabilities])),
      accounts: accounts.map((view) => view.account), statuses: accounts.flatMap((view) => view.statuses), deviceId: where.deviceId ?? this.#o.deviceId,
      deviceName: where.deviceName ?? this.#o.deviceName });
    const planned = plan.kind === 'ready' ? { runtime: plan.model.runtime, modelLabel: plan.model.label, effort: plan.effort } : null;
    const session = 'local' in where ? where.local.session : undefined;
    return { deviceId: where.deviceId, deviceName: where.deviceName, planned, canMoveHere: false, state: where.state,
      ...('unavailableReason' in where && where.unavailableReason ? { unavailableReason: where.unavailableReason } : {}), online: where.online,
      session: session ? { runtime: session.runtime, modelLabel: label(session.modelId), effort: session.effort,
        accountLabel: accounts.find((view) => view.account.id === session.accountId)?.account.label ?? session.accountId, turns: session.turns }
        : 'published' in where ? where.published : null };
  }
  async #work(projectId: string): Promise<ProjectWorkSettings> { return (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId); }
  /**
   * `GET /api/project-work`: every project with its counts and coordinator state. Every open page polls it, so it reads only
   * what the rows show (D246): no work settings, configuration or accounts, which on a member are hub requests per project.
   */
  async list(): Promise<ProjectWorkListView> {
    const [projects, roster] = await Promise.all([this.#o.projects.list(), this.#o.roster()]);
    const entries = await Promise.all(projects.map(async ({ project }) => {
      const [threads, decisions, coordinator] = await Promise.all([this.#threads(project.id), this.#o.hub.decisions(project.id), this.#coordinatorState(project.id, roster)]);
      return { projectId: project.id, name: project.name, ...workCounts(threads, decisions), coordinator: { deviceId: coordinator.deviceId, state: coordinator.state } };
    }));
    return ProjectWorkListViewSchema.parse({ schema: 'project-work-list-view-v1', projects: entries });
  }
  /** `GET /api/projects/:id/work`: the project page. */
  async project(projectId: string): Promise<ProjectWorkView> {
    const project = await this.#project(projectId);
    const [threads, decisions, work, notebook, roster, baseBranch] = await Promise.all([this.#threads(projectId), this.#o.hub.decisions(projectId), this.#work(projectId),
      this.#o.hub.notebook(projectId), this.#o.roster(), this.#base(project)]);
    const shown = effectiveSettings(work, project);
    return ProjectWorkViewSchema.parse({ schema: 'project-work-view-v1', project: { id: project.id, name: project.name, branchPolicy: project.branchPolicy, baseBranch },
      settings: shown.settings, ...(shown.notice ? { settingsNotice: shown.notice } : {}), coordinator: await this.#coordinator(projectId, roster, work), threads,
      decisions: decisionLists(decisions), pullRequests: pullRequestEntries(threads), notebookRevision: notebook?.revision ?? 0,
      lastEventId: this.#o.ledgers.coordinator(projectId).lastId(), gates: PHASE_GATES });
  }
  /** `GET /api/projects/:id/threads/:tid` for a thread this device owns (D81 `canMessage`; overrides arrive in phase 4). */
  async thread(projectId: string, threadId: string): Promise<ThreadView> {
    const thread = this.#o.store.get(threadId);
    if (!thread || thread.projectId !== projectId) throw refuse(THREAD_NOT_FOUND, 404);
    const project = await this.#project(projectId); const ledger = this.#o.ledgers.thread(projectId, threadId); const events = ledger.events();
    const reports = events.filter((event) => event.type === 'thread-report').map((event) => ledger.payload(event as ProjectLedgerEvent & { type: 'thread-report' }) as ThreadReport);
    // The page keeps working when the native session cannot be read; the transcript is just absent.
    const transcript = await this.#o.transcripts.read(thread, project.name).catch(() => null);
    return ThreadViewSchema.parse({ schema: 'project-thread-view-v1', thread: threadIndex(thread, this.#o.store.labels(threadId), events.at(-1)?.t ?? thread.createdAt),
      placement: thread.placement, reports, transcript, queuedMessages: thread.queuedMessages,
      canMessage: !['attached', 'done', 'stopped', 'failed'].includes(thread.state), turnAllowance: thread.turnAllowance, deviceName: this.#o.deviceName,
      baseBranch: thread.baseBranch, ...(thread.attach ? { attach: thread.attach } : {}), attachCommand: attachCommand(threadId),
      canOverride: { nextTurn: false, restart: false }, atTurnLimit: atTurnLimit(thread),
      canDiscard: (thread.state === 'stopped' || thread.state === 'failed') && thread.isolation === 'worktree' && !isDiscarded(thread.stateReason) });
  }
}
