import {ProjectIntakeActions} from './intake-actions.js';
import { ProjectJevDecisions } from './jev-decisions.js';
import {projectNotebookEditor,ProjectNotebookCommandSchema} from '@jevellan/core';
import {projectCoordinatorComposerFromUi} from '@jevellan/core';
import {chatItems,chatProposalGroups,projectChatThreadTitles,projectChatCardInteraction,ProjectChatCardViewRequestSchema,ProjectChatCardViewSchema} from '@jevellan/core';
import {projectChatRequest,projectChatView} from '@jevellan/core';
import {publicProjectData} from './ledger.js';
import {projectTaskPageView} from '@jevellan/core';
import { ProjectTaskCommandSchema, projectTaskQueueRequest, projectTaskQueueInteraction, projectTaskEditView, projectTaskDraft } from '@jevellan/core';
import { CursorTranscriptSchema, EARLIER_TRANSCRIPT_UNAVAILABLE, transcriptTurnPresentation, TRANSCRIPT_PROMPT, HISTORY_PROMPT_COLLAPSE_CHARACTERS } from '@jevellan/core';
import { taskEditorView } from '@jevellan/core';
import { projectSetupPresentation } from '@jevellan/core';
import { defaultRuntimeCacheWindow } from '@jevellan/core';
import { ProjectEnvironmentEditorSaveSchema } from '@jevellan/core';
import { environmentEditor } from './environment-editor.js';
import { ProjectPlacementEditorSaveSchema } from '@jevellan/core';
import { placementEditor } from './placement-editor.js';
import { MergeCorrectionInputSchema } from '@jevellan/core';
import { waitingItemsView, sentText } from './waiting-views.js';
import { projectConfigurationInfo } from './project-configuration.js';
import { coordinatorEditor } from './coordinator-editor.js';
import { settingsChangeView } from './settings-change-views.js';
import { landingEditor } from './landing-editor.js';
import { settingsEditorBase, settingsEditorRequest, settingsEditorSaved } from './settings-editor.js';
import { ProjectLandingEditorRequestSchema, ProjectLandingEditorSaveSchema } from '@jevellan/core';
import { ProjectSettingsChangeViewRequestSchema } from '@jevellan/core';
import { ProjectCoordinatorEditorSaveSchema } from '@jevellan/core';
import { QUESTION_NOT_FOUND } from './copy.js';
import { ProjectSendRequestSchema, ProjectSendSavedSchema, boundedRedaction, type ProjectPageRequest, type ProjectWaitingRespondRequest, ProjectWaitingResponseSchema } from '@jevellan/core';
import { projectGoalViews, goalEditorView, goalEditorRequest } from './goal-views.js';
import { projectPageView } from './page-view.js';
import { projectJobsView } from './jobs-view.js';
import { jobEditorView, dailyEditorView, routineEditorRequest } from './routine-editors.js';
import { RoutineEditorSaveRequestSchema, type RoutineEditorChoice } from '@jevellan/core';
import { ProjectCleanupInventory } from './cleanup.js';
import { ProjectDeployService } from './deploy.js';
import { setupProposalId } from './setup.js';
import { SETUP_ALREADY_PROPOSED, STEERING_PREFIX } from './copy.js';
import { ProjectSetupProposalSchema, SetupProposeInputSchema, SetupProposalViewSchema, SetupActionRequestSchema, ProjectRunRequestSchema, projectSetupPlan } from '@jevellan/core';
import { ProjectNotifications } from './notifications.js';
import { ProjectUsage } from './usage.js';
import { SettingsChangePlanSchema, settingsChangePlan } from './settings-changes.js';
import { projectSettingValue, withProjectSetting, ProjectSettingsUndoRequestSchema, type CoordinatorEvent, type ProjectSettingsChange } from '@jevellan/core';
import { settingText, SETTING_CHANGED_AGAIN } from './copy.js';
import { restoreFromVault, vaultDefinition, vaultDefinitionText } from './vault-definition.js';
import { nightlyFixMinutes } from './session-context.js';
import { NightlyReview } from './nightly-review.js';
import { ProjectGithub } from './github-awareness.js';
import { coordinatorMemory, projectNow, projectRecall } from './shared-context.js';
import { HUB_MEMORY_OFFLINE, ProjectCaptureQueue } from '@jevellan/memory';
import { ProjectMemoryProgramme } from './memory-programme.js';
import { listNativeSessions } from '@jevellan/mesh';
import { nativeFormat } from '@jevellan/runtime-contract';
import { WorktreeDiskService } from './worktree-disk.js';
import { ThreadLandingService } from './landing.js';
import { applyEkoaCodeSetup, EKOA_FAST_CHECKS } from './ekoa-code.js';
import { EkoaCodeSetupRequestSchema, collectDeviceFacts, deviceResourceRefusal, parseGitHubRemote, liveWork, resolveProjectPath, type DeviceFacts } from '@jevellan/core';
import { ProjectDailyWork } from './daily.js';
import { ProjectJobRunner } from './job-runner.js';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite, deviceAllowsWork, type ProjectLedgerEvent } from '@jevellan/core';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import type { AccountService } from '@jevellan/accounts';
import {
  AttachedGrantSchema, HubUnavailable, IdSchema, ProjectRequestOutcomeSchema, readDocument, writeDocument, ProjectNotebookSchema, ProjectNotebookViewSchema, ProjectWorkSettingsSchema, ProjectWorkSettingsViewSchema, ThreadCreatedViewSchema, ThreadOverrideViewSchema, defaultProjectWorkSettings, newId,
  type CheckoutOwnership, type Configuration, type CoordinatorMessageRequestSchema, type DecisionAnswerRequestSchema, type Homes, type NotebookRequestSchema, type Project,
  type ProjectHub, type ProjectWorkListView, type ProjectWorkSettings, type ProjectWorkSettingsRequestSchema, type ProjectWorkView, type PublicationLeaseService,
  type RiggingItem, type SecretRedactor, type SharedProjects, type ThreadCreateRequestSchema, type ThreadMessageRequestSchema, type ThreadOverrideRequestSchema,
  type ThreadStopRequestSchema, type ThreadView, type UnreadableEnvelope, type ProjectMemoryRequest, type MemoryCapture,
} from '@jevellan/core';
import type { StretchBridges, BridgeScopeTools } from '@jevellan/conversations';
import { bridgeTools, applicationRoot, minimalEnvironment, resolvedPath, stableJson } from '@jevellan/core';
import { ProjectTools } from './bridge-tools.js';
import { deadlineClient, decideAccount, decideProjectOutcome, type DecisionSource } from '@jevellan/decisions';
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
import { DecisionItems, derivedId } from './decision-items.js';
import { Inbox, Outbox, type EnvelopeOf } from './envelopes.js';
import { GIT_NETWORK_TIMEOUT_MS, ThreadGit } from './git.js';
import { ThreadIndexPublisher } from './index-publisher.js';
import { TurnLauncher } from './launch.js';
import { ProjectJournals, type JournalOptions } from './journal.js';
import { cacheRecords, sessionCacheSnapshot } from './session-cache.js';
import { ProjectLedgers, type ProjectLedger } from './ledger.js';
import { ProjectPaths } from './paths.js';
import { Placement, type DeviceRoster } from './placement.js';
import { GitHubAccess, ThreadPublication } from './publication.js';
import { PullRequestTracker, type MergeResultView } from './pull-requests.js';
import { endTurnProcess, recoverProjects } from './recovery.js';
import { CoordinatorStore, StartReceipts, ThreadStore, threadIndex } from './stores.js';
import { LocalDelivery, ThreadService, type RemoteStart } from './threads.js';
import { ThreadTranscripts } from './transcript.js';
import { ThreadFollowups } from './thread-followup.js';
import { ProjectViews, effectiveSettings } from './views.js';
import { ThreadWorktree } from './worktree.js';
import { ProjectGoals } from './goals.js';
import { ProjectTasks } from './tasks.js';
import { ProjectDispatcher } from './dispatcher.js';
import { ProjectMergeGate } from './merge-gate.js';
import { PullRequestVerification } from './pr-verification.js';
import { TaskCreateRequestSchema, TaskListViewSchema, TaskViewSchema, type TaskUpdateRequest } from '@jevellan/core';

export type ProjectTimers = {
  /** Fixtures exercising pre-switch threads may retain their original delivery. */
  defaultDelivery?: 'land' | 'pull-request';
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
  /** Jev control (bridge) for the l-v1 landing route. */
  landingJev?(projectId: string): Promise<import('./landing.js').LandingJev | undefined>;
  /** The owner's display id of an object (bridge short ids), for refusals he reads. */
  displayId?(projectId: string, prefix: 'G' | 'T', internalId: string): string | undefined;
  /** Missed nights (bridge): decides whether a window this late still opens as a catch-up. */
  nightGuard?(projectId: string, date: string, latenessMs: number, items: readonly string[]): Promise<{ open: true } | { open: false; outcome: string }>;
  /** Why this device may not start new work now (B5: it runs a newer version than its hub). */
  deployHealth?(id: string, checks: import('@jevellan/core').ProjectHealthCheck[], trigger: import('@jevellan/core').ProjectHealthRun['trigger'], deployId: string): Promise<import('@jevellan/core').ProjectHealthRun[]>;
  workRefusal?(): string | undefined;
  journal?: Pick<JournalOptions, 'isHub' | 'request'>;
  library?: import('@jevellan/core').ProjectLibrary;
  terminalRead?(scope: import('./bridge-tools.js').ProjectScope, input: unknown): Promise<unknown>;
  homes: Homes; deviceId: string; deviceName: string; redactor: SecretRedactor;
  facts?(): DeviceFacts;
  projects: SharedProjects; hub: ProjectHub;
  environment?: { credentials(projectId: string): Promise<Record<string, string>> };
  github: { credential(projectId?: string): Promise<string | undefined>; fetch?: typeof fetch | undefined; baseUrl?: string | undefined };
  accounts: Pick<AccountService, 'list' | 'resolve' | 'markUsed' | 'recordUsage' | 'recordError'>;
  runtimes: ReadonlyMap<string, RuntimeAdapter>; accountRuns: Set<string>;
  /** Main isolation (phase 6) publishes under these; worktree threads need neither. */
  ownership?: CheckoutOwnership | undefined; leases?: PublicationLeaseService | undefined;
  outside?: { assertIdle(project: Project, path: string): Promise<void> } | undefined;
  bridges: Pick<StretchBridges, 'issueTools' | 'restoreTools'>; memory: Pick<BasicMemory, 'project'>;
  sendCapture?(request: ProjectMemoryRequest): Promise<void>;
  hubMemory?: import('@jevellan/memory').HubMemoryStore;
  switchMemory?(projectId: string, mode: Project['memory']['mode'], requestId: string): Promise<Project>;
  settings(): Promise<Configuration['x-jevellan']>; riggingItems(runtime: string, projectId?: string): Promise<RiggingItem[]>;
  /** Jev placement (phase 4). */
  decisionClient?: DecisionSource;
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
  readonly jevDecisions: ProjectJevDecisions;
  readonly journal: ProjectJournals | undefined;
  readonly ready: Promise<void>;
  /** The daemon's own URL for bridge calls; empty until `Application.bindDaemonUrl`. */
  daemonUrl = '';
  readonly paths: ProjectPaths; readonly ledgers: ProjectLedgers; readonly store: ThreadStore; readonly coordinators: CoordinatorService;
  readonly threads: ThreadService; readonly decisions: DecisionItems; readonly tracker: PullRequestTracker; readonly views: ProjectViews;
  readonly admission: Admission; readonly transcripts: ThreadTranscripts;
  readonly apps: ProjectApps;
  readonly captures: ProjectCaptureQueue;
  readonly memoryProgramme: ProjectMemoryProgramme | undefined;
  readonly reviews: NightlyReview; readonly daily: ProjectDailyWork; readonly jobs: ProjectJobRunner;
  readonly intakeActions:ProjectIntakeActions;
  readonly goals: ProjectGoals; readonly tasks: ProjectTasks; readonly dispatcher: ProjectDispatcher;
  readonly deploys: ProjectDeployService;
  readonly mergeGate: ProjectMergeGate; readonly landings: ThreadLandingService;
  readonly disk: WorktreeDiskService;
  readonly cleanupInventory: ProjectCleanupInventory;
  /** Mail and reservations between main threads (brief 5.11, 7.2). */
  readonly usage: ProjectUsage;
  readonly notifications: ProjectNotifications;
  /** The hub relay (D40): durable sends to other devices, and this device's pending envelopes. */
  readonly outbox: Outbox; readonly inbox: Inbox;
  readonly #o: ProjectWorkOptions;
  readonly #timers: ProjectTimers;
  readonly #publisher: ThreadIndexPublisher;
  readonly #attach: ThreadAttach;
  readonly #attachedGrants = new Map<string, { close(): Promise<void> }>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #taskSweep: Promise<void> | undefined;
  #taskSweepAgain = false;
  readonly #cachePublished = new Map<string, number>();
  #tools: CoordinatorToolHandlers | undefined;
  readonly #github: ProjectGithub;
  #started = false;
  #closing: Promise<void> | undefined;
  constructor(options: ProjectWorkOptions) {
    this.#o = options; const o = options;
    this.apps = new ProjectApps(o.homes, tailnetAppPublisher(async () => (await o.roster()).devices.find(view => view.device.id === o.deviceId)?.device.url ?? this.daemonUrl), o.redactor);
    const timers = this.#timers = { ...DEFAULT_PROJECT_TIMERS, ...o.timers };
    const now = () => timers.now();
    this.captures = new ProjectCaptureQueue(o.homes, o.redactor, now);
    const facts = () => o.facts?.() ?? collectDeviceFacts(o.homes);
    this.paths = new ProjectPaths(o.homes);
    this.ledgers = new ProjectLedgers(this.paths, { redactor: o.redactor, now: () => new Date(now()).toISOString() });
    this.#publisher = new ThreadIndexPublisher(o.hub, timers.indexRetryMs);
    this.store = new ThreadStore(this.paths, this.ledgers, this.#publisher);
    this.journal = o.journal ? new ProjectJournals({ homes: o.homes, deviceId: o.deviceId, ...o.journal, ledgers: this.ledgers, hub: o.hub,
      projects: async () => (await o.projects.list()).map(row => row.project), threads: projectId => this.store.list(projectId), now,
      dream: projectId => { const dream = this.memoryProgramme?.dream.state(projectId); if (!dream?.report) return undefined;
        const windowId = this.memoryProgramme?.session(projectId, 'dream')?.windowId;
        return { id: dream.id, report: dream.report, ...(windowId ? { windowId } : {}) }; } }) : undefined;
    const coordinatorStore = new CoordinatorStore(this.paths); const receipts = new StartReceipts(this.paths, now);
    const github = new GitHubAccess({ credential: o.github.credential, fetch: o.github.fetch, baseUrl: o.github.baseUrl, redactor: o.redactor });
    const git = new ThreadGit({ homes: o.homes, redactor: o.redactor });
    this.transcripts = new ThreadTranscripts({ homes: o.homes, deviceId: o.deviceId, deviceName: o.deviceName });
    // A thread attached in a terminal holds its account for every turn on this device, read from the threads themselves (phase 8).
    const projectEnvironment = async (projectId: string) => {
      const settings = await this.admission.settings(projectId), secrets = await o.environment?.credentials(projectId) ?? {};
      for (const value of Object.values(secrets)) o.redactor.add(value);
      return { ...Object.fromEntries(settings.environment.variables.map(row => [row.name, row.value])), ...secrets };
    };
    const held = (): ReadonlySet<string> => new Set(this.store.all().filter((thread) => thread.state === 'attached').map((thread) => thread.placement.accountId));
    const launcher = new TurnLauncher({ accounts: o.accounts, runtimes: o.runtimes, accountRuns: o.accountRuns, riggingItems: o.riggingItems, bridges: o.bridges, homes: o.homes,
      deviceId: o.deviceId, deviceName: o.deviceName, daemonUrl: () => this.daemonUrl, redactor: o.redactor, held, projectEnvironment, library: o.library, projectSettings: projectId => this.admission.settings(projectId),
      sessionLedger: projectId => this.ledgers.coordinator(projectId), now, useOwnSetup: async runtime => (await o.settings()).runtimes[runtime]?.useOwnSetup !== false,
      cacheWindowMinutes: async runtime => (await o.settings()).runtimes[runtime]?.cacheWindowMinutes ?? defaultRuntimeCacheWindow(runtime),
      chooseAccount: async (request, ranking) => {
        const settings = await o.settings();
        const thread = request.owner.kind === 'thread' ? this.store.get(request.owner.id) : undefined;
        return decideAccount(deadlineClient(o.decisionClient), {
          ranking, model: settings.decisions.model, now: now(), redactor: o.redactor,
          state: JSON.stringify(o.redactor.document({ schema: 'account-route-state-v1', runtime: request.runtime, model: request.model,
            owner: request.owner.kind, title: thread?.title ?? request.modelLabel, task: thread?.task.slice(0, 6000), routingProfile: settings.routingProfile })),
        }, AbortSignal.timeout(150_000));
      },
      archiveSession: (owner, session) => {
        if (owner.kind === 'thread') this.store.updateLocal(owner.id, local => ({ ...local, sessionHistory: [...(local.sessionHistory ?? []).filter(row => row.key !== session.key), session] }));
        else if (owner.kind === 'coordinator') coordinatorStore.updateLocal(owner.projectId, local => ({ ...local, sessionHistory: [...(local.sessionHistory ?? []).filter(row => row.key !== session.key), session] }));
      },
      cacheLedger: owner => owner.kind === 'thread' ? this.ledgers.thread(owner.projectId, owner.id) : this.ledgers.coordinator(owner.projectId),
      ...(this.journal ? { journalDirectory: async (projectId: string) => { await this.journal!.sync(projectId).catch(() => undefined); return this.journal!.readableDirectory(projectId); } } : {}),
      threadGitEnvironment: async projectId => {
        try {
          const registered = await o.projects.get(projectId); if (!registered) throw new Error(PROJECT_NOT_FOUND);
          const project = registered.project;
          const remote = await git.remoteUrl(resolveProjectPath(project, o.deviceId));
          return remote ? await github.turnGitEnvironment(projectId, remote) : {};
        } catch (error) { if (error instanceof HubUnavailable) return {}; throw error; }
      },
      protectedPaths: async () => { const [projects, roster] = await Promise.all([o.projects.list(), o.roster()]); return [...new Set([
        ...projects.flatMap(row => row.project.paths[o.deviceId] ? [row.project.paths[o.deviceId]!] : []), ...(roster.devices.find(row => row.device.id === o.deviceId)?.device.protectedPaths ?? [])])]; } });
    this.admission = new Admission({ ...(timers.defaultDelivery ? { defaultDelivery: timers.defaultDelivery } : {}), createdThreads: id => this.store.created(id), hub: o.hub, deviceId: o.deviceId, deviceName: o.deviceName, localLive: (projectId) => this.threads.liveThreads(projectId),
      facts,
      guard: async (_projectId, deviceId, threadId) => {
        if (deviceId === o.deviceId && !deviceAllowsWork(o.homes)) return 'This device serves apps only; project work runs on a working device.';
        const roster = await o.roster().catch((error: unknown) => { if (error instanceof HubUnavailable) return undefined; throw error; });
        const view = roster?.devices.find(row => row.device.id === deviceId);
        if (view?.device.workPolicy?.mode === 'apps-only') return 'This device serves apps only; project work runs on a working device.';
        const needs = this.store.get(threadId)?.taskContext?.needs ?? [], missing = needs.filter(tag => !view?.device.tags?.includes(tag));
        if (missing.length) return `Missing device tags: ${missing.join(', ')}.`;
        return deviceId !== o.deviceId ? deviceResourceRefusal(view?.device.name ?? deviceId, view?.heartbeat?.facts) : undefined;
      },
      nameOf: async (deviceId) => (await o.roster()).devices.find((view) => view.device.id === deviceId)?.device.name, now });
    this.jevDecisions = new ProjectJevDecisions({ homes: o.homes, deviceId: o.deviceId, redactor: o.redactor,hub:o.hub });
    const placement = new Placement({ recordDecision: decision => this.jevDecisions.recordNew(decision), settings: o.settings, accounts: o.accounts, runtimes: o.runtimes, roster: o.roster, admission: this.admission, deviceId: o.deviceId,
      facts,
      deviceName: o.deviceName, hub: o.hub, redactor: o.redactor, now, ...(o.decisionClient ? { decisionClient: o.decisionClient } : {}),
      local: (projectId) => this.store.list(projectId).map((thread) => threadIndex(thread, this.store.labels(thread.id), thread.createdAt)),
      pendingMain: (projectId) => this.threads.pendingMain(projectId) });
    this.decisions = new DecisionItems({ redactor: o.redactor, intakeAnswer:(decision,answer,request)=>this.intakeActions.answer(decision,answer,request), deployAnswer: (decision, answer, request) => this.deploys.answer(decision, answer, request), hub: o.hub, now, toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event), mergeAnswer: (decision, answer, validateOnly) => (decision.landing || decision.blocker) ? this.landings.answer(decision, answer, validateOnly) : this.mergeGate.answer(decision, answer, validateOnly), threads: () => ({
      automaticFixAnswer: (projectId, threadId, prNumber, allow, commandId) => this.threads.automaticFixAnswer(projectId, threadId, prNumber, allow, commandId),
      allowTurns: (projectId, threadId, commandId) => this.threads.allowTurns(projectId, threadId, commandId),
      stop: (projectId, threadId, reason, commandId) => this.threads.stop(projectId, threadId, reason, true, commandId),
      stopRefusal: (projectId, threadId) => this.threads.stopRefusal(projectId, threadId),
      message: (projectId, threadId, text, messageId) => this.threads.message(projectId, threadId, 'owner', text, false, messageId),
    }) });
    this.disk = new WorktreeDiskService({ homes: o.homes, git, deviceId: o.deviceId, now, ownership: async () => {
      const owners = [];
      for (const { project } of await o.projects.list()) {
        if (!project.paths[o.deviceId]) continue;
        const retained = new Set(this.store.list(project.id).filter(thread => thread.state !== 'done' || this.store.local(thread.id).process).map(thread => `thread:${thread.id}`));
        for (const run of await this.jobs.runs(project.id)) if (!run.conclusion) retained.add(`job:${run.id}`);
        for (const task of await this.tasks.list(project.id)) if (task.nightlyReview && !['done', 'failed', 'cancelled'].includes(task.state)) retained.add(`review:${task.id}`);
        for (const run of await this.mergeGate.documents(project.id)) if (run.schema === 'verification-run-v1' && !['passed', 'failed', 'cancelled'].includes(run.state)) retained.add(`verification:${run.id}`);
        owners.push({ project, repository: resolveProjectPath(project, o.deviceId, o.deviceName), retained });
      }
      return owners;
    } });
    this.cleanupInventory = new ProjectCleanupInventory({ homes: o.homes, deviceId: o.deviceId, git, hub: o.hub,
      projects: async () => (await o.projects.list()).map(row => row.project), threads: () => this.paths.projectIds().flatMap(id => this.store.list(id)), thread: id => this.store.get(id), local: id => this.store.local(id), activePaths: () => this.disk.activePaths() });
    const validateBranch = async (project: Project, branch: string) => {
      const repo = resolveProjectPath(project, o.deviceId, o.deviceName);
      const valid = await git.run(repo, ['check-ref-format', '--branch', branch], { permitted: [1, 128] });
      if (valid.code !== 0 || branch.startsWith('-')) throw refuse(`Branch ${branch} is not a valid branch name.`, 400);
      const remote = await git.run(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
      if (!remote.stdout.trim()) throw refuse(`Branch ${branch} is not on origin.`, 409);
      const repository = parseGitHubRemote(project.remoteUrl ?? await git.remoteUrl(repo) ?? '');
      if (repository) {
        const client = await github.open(project.id), pull = await client.findOpenPull(repository, branch);
        if (pull && pull.author !== await client.viewer()) throw refuse(`Branch ${branch} belongs to #${pull.number} by ${pull.author ?? 'unknown'}; only your own work can be continued.`, 409);
      }
    };
    const worktrees = new ThreadWorktree({ validateBranch, projectEnvironment, git, homes: o.homes, paths: this.paths, redactor: o.redactor, deviceId: o.deviceId, deviceName: o.deviceName });
    this.#github = new ProjectGithub({ github, redactor: o.redactor, now, project: id => this.#project(id),
      // The thread's pull request as this device's tracker last read it from GitHub, which can be newer than the hub's index (fix-051).
      thread: async id => { const index = (await o.hub.thread(id))?.document, pr = this.store.get(id)?.pr; return index && pr ? { ...index, pr } : index; },
      baseBranch: async project => worktrees.baseBranch(worktrees.repository(project)),
      repository: async project => parseGitHubRemote(await git.remoteUrl(worktrees.repository(project)) ?? '') });
    const publication = new ThreadPublication({ projectEnvironment, git, homes: o.homes, redactor: o.redactor, github, deviceId: o.deviceId, deviceName: o.deviceName, testTimeoutMs: timers.testTimeoutMs,
      leaseRetryMs: timers.mainLeaseRetryMs, now, ...(o.leases ? { leases: o.leases } : {}), ...(o.ownership ? { ownership: o.ownership } : {}) });
    this.coordinators = new CoordinatorService({ deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, store: coordinatorStore, ledgers: this.ledgers, hub: o.hub,
      captureTurn: (project, session) => this.#capture(project, { scope: 'coordinator', runtime: session.runtime, model: session.model, accountId: session.accountId, sessionId: session.nativeSessionId }),
      ...(this.journal ? { handoffContext: (projectId: string) => this.journal!.handoffContext(projectId) } : {}),
      memoryContext: async project => {
        try { const port = o.memory.project(project, o.deviceId, () => {}, { kind: 'viewer' }), signal = AbortSignal.timeout(150_000);
          const notes = port.list ? await port.list(signal) : (await port.search('Project OR build OR test OR convention OR decision', signal)).notes;
          const brief = await port.findTitle('Project brief', signal);
          return coordinatorMemory(brief ? [brief, ...notes.filter(note => note.permalink !== brief.permalink)] : notes);
        } catch (error) { return `Project memory:\n${error instanceof Error && error.message === HUB_MEMORY_OFFLINE ? HUB_MEMORY_OFFLINE : 'Project memory is unavailable for this turn.'}`; }
      },
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
          // The model read is part of the decision and its deadline (fix-051).
          const result = await decideProjectOutcome(o.decisionClient, { projectId, eventId: event.id, request: event.text, history, model: async () => (await o.settings()).decisions.model }, signal);
          return writeDocument(file, ProjectRequestOutcomeSchema, result);
        } finally { release(); }
      },
      forward: (projectId, events, handover) => {
        for (const event of events) this.outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event }, handover === undefined ? {} : { handover });
      },
      baseBranch: (project) => worktrees.baseBranch(worktrees.repository(project)), enterOperation: o.enterOperation,
      timers: { startMs: timers.coordinatorStartMs, retryMs: timers.coordinatorRetryMs, turnTimeoutMs: timers.coordinatorTurnTimeoutMs }, now });
    const delivery = this.#delivery = new LocalDelivery({ deviceId: o.deviceId, coordinators: this.coordinators, store: this.store, outbox: () => this.outbox, now,
      command: (projectId, threadId, command) => this.threads.command(projectId, threadId, command) });
    this.tasks = new ProjectTasks({ hub: o.hub, deviceId: o.deviceId, redactor: o.redactor, now,
      settings: projectId => this.admission.settings(projectId), validateBranch: async (id, branch) => validateBranch(await this.#project(id), branch),
      validateGoal: (projectId, goalId, source, refillEventId) => this.goals.validate(projectId, goalId, source, refillEventId), projectDay: projectId => this.goals.day(projectId),
      changed: () => { void this.#sweepTasks(true).catch(() => undefined); },
      cancelThread: (task, reason, owner) => this.threads.stop(task.projectId, task.threadId!, reason, owner),
      reviewed: async (task, outcome, note) => delivery.toCoordinator(task.projectId, { schema: 'coordinator-event-v1', kind: 'task-reviewed', taskId: task.id, title: task.title, outcome, ...(note ? { note } : {}),
        id: `cev_${task.id}_${task.revision}`, at: task.updatedAt }) });
    this.goals = new ProjectGoals({ hub: o.hub, tasks: this.tasks, redactor: o.redactor, now, settings: projectId => this.admission.settings(projectId), ...(o.displayId ? { displayId: (projectId, goalId) => o.displayId!(projectId, 'G', goalId) } : {}),
      event: (projectId, event) => delivery.toCoordinator(projectId, event), changed: () => { void this.#sweepTasks(true).catch(() => undefined); },
      windowOpen: projectId => this.daily.mergesHeld(projectId),
      available: async projectId => {
        const coordinator = this.coordinators.get(projectId), state = coordinator.state();
        if (state.state !== 'idle' || state.queue.length || state.failedTurnsInARow >= 2 || coordinator.busy) return false;
        const view = await this.views.project(projectId); return view.coordinator.state === 'idle' && view.coordinator.planned !== null;
      } });
    const followups = new ThreadFollowups({ paths: this.paths, placement, settings: o.settings, project: id => this.#project(id),
      workSettings: id => this.admission.settings(id), client: o.decisionClient });
    this.threads = new ThreadService({ deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, ...(o.workRefusal ? { workRefusal: o.workRefusal } : {}), store: this.store, ledgers: this.ledgers, receipts, hub: o.hub,
      projects: o.projects, admission: this.admission, placement, accounts: o.accounts, transcripts: this.transcripts, delivery, settings: o.settings, now,
      roster: o.roster, decisions: this.decisions, fallbackCheckMs: timers.fallbackCheckMs, managedQueue: true, failedJobs: (thread, head) => this.#github.failedJobs(thread, head),
      validateBranch: async (id, branch) => validateBranch(await this.#project(id), branch),
      landInstead: async (thread, requestId) => {
        const prior = this.store.local(thread.id).landInstead; if (thread.delivery === 'land' && prior?.commandId === requestId) return;
        if (!thread.pr || thread.pr.state !== 'open') throw new Error('This thread has no open pull request.');
        const opened = this.ledgers.thread(thread.projectId, thread.id).events().some(event => event.type === 'thread-publication' && (() => { const data = this.ledgers.thread(thread.projectId, thread.id).payload(event as typeof event & { type: 'thread-publication' }); return data.result === 'pr-opened' && data.prNumber === thread.pr!.number; })());
        const project = await this.#project(thread.projectId), repository = parseGitHubRemote(project.remoteUrl ?? await git.remoteUrl(thread.cwd) ?? '');
        if (!opened || !repository) throw new Error('Only a pull request opened by Jevellan can use Land instead.');
        const client = await github.open(thread.projectId), pull = await client.getPull(repository, thread.pr.number), login = await client.viewer();
        if (!pull.author || pull.author !== login) throw new Error('Only your own pull request can use Land instead.');
        if (pull.merged || pull.state !== 'open' && prior?.commandId !== requestId) throw new Error('The pull request is no longer open.');
        if (!prior) this.store.updateLocal(thread.id, local => ({ ...local, landInstead: { commandId: requestId, prNumber: pull.number, head: pull.headSha, at: new Date(now()).toISOString() } }));
        if (pull.state === 'open') {
          const synced = await worktrees.syncPullHead(project, thread);
          if (synced.kind === 'conflict') throw new Error('The pull request head conflicts with this worktree. Resolve it before Land instead.');
          await client.closePull(repository, pull.number);
        }
        this.store.update(thread.id, current => { const next = { ...current, delivery: 'land' as const }; delete next.pr; return next; }, { type: 'thread-publication', data: { schema: 'thread-publication-v1', result: 'pr-state', prNumber: pull.number, pr: { ...thread.pr!, state: 'closed' } } });
      },
      pullRequestChanged: () => { void this.tracker.poll(); },
      refreshLanding: (projectId, threadId) => this.daily.assertMerge(projectId, threadId),
      queueChanged: projectId => { void this.dispatcher.sweep(projectId).catch(() => undefined); },
      runner: {
        landing: { publish: (...args) => this.landings.publish(...args), concluded: (...args) => this.landings.concluded(...args) },
        library: o.library,
        routeMessages: (thread, body, ids, signal) => followups.route(thread, body, ids, signal),
        reconsider: async (thread, reason, trouble, signal, minimumEffort) => placement.reconsider(await this.#project(thread.projectId), await this.admission.settings(thread.projectId), thread, reason, trouble, signal, minimumEffort),
      ...(this.journal ? { journalContents: (projectId: string, threadId: string) => this.journal!.contents(projectId, threadId) } : {}),
        deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, store: this.store, ledgers: this.ledgers, project: (projectId) => this.#project(projectId),
        workSettings: (projectId) => this.admission.settings(projectId), worktrees, publication, launcher, accounts: o.accounts, admission: this.admission,
        endProcess: (process) => endTurnProcess(process),
        accountWait: (thread) => launcher.accountWait({ runtime: thread.placement.runtime, model: thread.placement.model,
          ...(thread.placement.fixed.includes('account') ? { requiredAccountId: thread.placement.accountId } : {}) }),
        unavailableAccount: thread => launcher.unavailableAccount({ runtime: thread.placement.runtime, model: thread.placement.model, modelLabel: this.store.labels(thread.id).modelLabel,
          ...(thread.placement.fixed.includes('account') ? { requiredAccountId: thread.placement.accountId } : {}) }),
        decisions: this.decisions, toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event),
        memory: async (project, scope) => {
          const task = scope?.kind === 'thread' ? (await this.tasks.list(project.id)).find(task => task.threadId === scope.threadId) : undefined;
          return o.memory.project(project, o.deviceId, () => { throw new Error(THREAD_MEMORY_READ_ONLY); }, { kind: 'thread', ...(scope?.kind === 'thread' ? { id: scope.threadId } : {}),
            ...(scope?.provenance ? { provenance: { ...scope.provenance, ...(task ? { taskId: task.id } : {}) } } : {}) });
        },
        githubTool: (scope, _name, input, signal) => this.#github.read(scope, input, signal),
        terminalRead: (scope, input) => { if (!o.terminalRead) throw new Error('Owner terminals are unavailable.'); return o.terminalRead(scope, input); },
        captureTurn: (project, thread) => this.#capture(project, { scope: thread.state === 'attached' ? 'attached' : 'thread', threadId: thread.id, runtime: thread.placement.runtime,
          model: thread.placement.model, accountId: thread.placement.accountId, sessionId: thread.nativeSessionId }),
        recall: async (project, thread) => projectRecall(() => o.memory.project(project, o.deviceId, () => {}, { kind: 'viewer' }), { title: thread.title, brief: thread.task },
          { ...(o.decisionClient ? { client: o.decisionClient } : {}), model: (await o.settings()).decisions.model }, AbortSignal.timeout(150_000)),
        projectNow: async (project, thread) => {
          const threads = []; let after: string | undefined;
          do { const page = await o.hub.threads(project.id, after); threads.push(...page.records); after = page.next ?? undefined; } while (after);
          const roster = await o.roster(), names = new Map(roster.devices.map(view => [view.device.id, view.device.name]));
          return projectNow(threads, thread.id, thread.baseBranch, id => names.get(id) ?? id, now());
        },
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
    this.jobs = new ProjectJobRunner({ leases:o.leases,assertIntakeLanding:id=>this.daily.assertMerge(id),library: o.library, beforeDeployment: run => this.deploys.beforeJob(run), roster: o.roster, relay: async (projectId, deviceId, runId) => { this.outbox.enqueue(projectId, deviceId, { kind: 'job-run', runId, commandId: derivedId('jobcmd', runId, deviceId) }); await this.outbox.drain(); }, projectEnvironment, homes: o.homes, hub: o.hub, tasks: this.tasks, git, github, deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, now, facts,
      project: id => this.#project(id), settings: id => this.admission.settings(id), baseBranch: repo => worktrees.baseBranch(repo), event: (id, event) => delivery.toCoordinator(id, event),
      windowOpened: async id => (await this.daily.window(id))?.openedAt, day: id => this.daily.day(id), dayStart: (id, day) => this.daily.dayStart(id, day), changed: () => { void this.#sweepTasks(true).catch(() => undefined); } });
    this.intakeActions=new ProjectIntakeActions({prepareMerge:check=>this.jobs.prepareIntakeLanding(check),queueMerge:(action,check)=>this.jobs.queueIntakeLanding(action,check),hub:o.hub,github,tasks:this.tasks,deviceId:o.deviceId,redactor:o.redactor,now,changed:()=>{void this.#sweepTasks(true).catch(()=>undefined);}});
    this.daily = new ProjectDailyWork({ landing: (threadId, held) => { if (!this.store.get(threadId)) return; if (held) this.store.setIndexFields(threadId, { landing: 'held' }); else if (this.store.local(threadId).landing === 'held') this.store.setIndexFields(threadId, { landing: undefined }); }, fixCutoffMinutes: nightlyFixMinutes(o.homes), hub: o.hub, tasks: this.tasks, runner: this.jobs, redactor: o.redactor, now, deviceId: o.deviceId, settings: id => this.admission.settings(id),
      memoryDream: async (id, requestId) => { if (!this.memoryProgramme) throw new Error('The memory dream runs on the hub.'); return this.memoryProgramme.runNow(await this.#project(id), requestId); },
      memoryDreamLine: id => this.memoryProgramme?.line(id), ...(o.nightGuard ? { nightGuard: o.nightGuard } : {}),
      validateGoal: async (id, goalId) => { if (goalId) await this.goals.read(id, goalId); }, event: (id, event) => delivery.toCoordinator(id, event), changed: () => { void this.#sweepTasks(true).catch(() => undefined); } });
    this.memoryProgramme = o.hubMemory ? new ProjectMemoryProgramme({ sessionEnd: evidence => this.ledgers.sessionEnd(evidence), store: o.hubMemory, captures: this.captures, hub: o.hub, launcher, placement, git, daily: this.daily,
      deviceId: o.deviceId, redactor: o.redactor, accounts: o.accounts, settings: id => this.admission.settings(id), repository: project => worktrees.repository(project), baseBranch: repo => worktrees.baseBranch(repo),
      event: (id, event) => delivery.toCoordinator(id, event), enterOperation: o.enterOperation, now }) : undefined;
    this.reviews = new NightlyReview({ sessionEnd: evidence => this.ledgers.sessionEnd(evidence), hub: o.hub, tasks: this.tasks, homes: o.homes, git, launcher, deviceId: o.deviceId, deviceName: o.deviceName, redactor: o.redactor, now, facts,
      memory: async id => o.memory.project(await this.#project(id), o.deviceId, () => { throw new Error(THREAD_MEMORY_READ_ONLY); }, { kind: 'review' }),
      settings: o.settings, accounts: o.accounts, runtimes: o.runtimes, project: id => this.#project(id), repository: project => worktrees.repository(project), baseBranch: repo => worktrees.baseBranch(repo), timeoutMs: timers.threadTurnTimeoutMs,
      event: (id, event) => delivery.toCoordinator(id, event), changed: () => { void this.#sweepTasks(true).catch(() => undefined); } });
    this.dispatcher = new ProjectDispatcher({ settings: id => this.admission.settings(id), tasks: this.tasks, threads: this.threads, deviceId: o.deviceId,
      text: async task => {
        const goal = task.goalId ? await this.goals.read(task.projectId, task.goalId) : null;
        const brief = `${task.brief}${goal ? `\n\nGoal: ${goal.name}. Why it matters: ${goal.motivation}` : ''}\n\nTask type: ${task.type}.`;
        return { brief, taskContext: { taskId: task.id, type: task.type, needs: task.needs, goal: goal ? { id: goal.id, name: o.redactor.text(goal.name), motivation: o.redactor.text(goal.motivation).slice(0, 600) } : null }, assembled: brief };
      }, review: task => this.reviews.start(task), job: task => this.jobs.start(task), eligible: async (task, tasks) => await this.daily.eligible(task, tasks) && await this.goals.eligible(task, tasks), event: (projectId, event) => delivery.toCoordinator(projectId, event) });
    this.deploys = new ProjectDeployService({ discoverBaseline: async id => {
      const repo = worktrees.repository(await this.#project(id)); if (!await git.remoteUrl(repo)) return null;
      const tags = (await git.run(repo, ['ls-remote', '--tags', 'origin', 'refs/tags/deployed/*'], { timeoutMs: GIT_NETWORK_TIMEOUT_MS })).stdout.trim().split('\n').map(line => line.split(/\s+/u)).filter((row): row is [string, string] => !!row[0]?.match(/^[a-f0-9]{40}$/u) && !!row[1]);
      const latest = tags.filter(([, ref]) => !ref.endsWith('^{}')).sort((a, b) => b[1].localeCompare(a[1]))[0];
      return latest ? tags.find(([, ref]) => ref === `${latest[1]}^{}`)?.[0] ?? latest[0] : null;
    }, hub: o.hub, tasks: this.tasks, jobs: this.jobs, deviceId: o.deviceId, redactor: o.redactor, now, settings: id => this.admission.settings(id), environment: projectEnvironment,
      health: async (id, checks, trigger, deployId) => { if (!o.deployHealth && checks.length) throw new Error('Health checks are unavailable at the state point.'); return o.deployHealth?.(id, checks, trigger, deployId) ?? []; },
      diff: async (id, before, after) => { const repo = worktrees.repository(await this.#project(id)); return (await git.run(repo, ['diff', '--name-only', before, after])).stdout.trim().split('\n').filter(Boolean); },
      onMain: async (id, commit) => { const main = await this.jobs.mainHead(id), repo = worktrees.repository(await this.#project(id)); if ((await git.run(repo, ['merge-base', '--is-ancestor', commit, main], { permitted: [1, 128] })).code !== 0) throw refuse(`Commit ${commit} is not on origin/main. Deploys build only from main.`, 409); },
      resolution: async (id, thread, deployId, clear) => { const index = (await o.hub.thread(thread.threadId))?.document; if (!index) return; await delivery.toThreadOwner(id, index.id, index.ownerDeviceId, { type: 'deploy-resolution', deployId, landingCommit: thread.landingCommit, clear }, derivedId('tcmd', deployId, thread.threadId, String(clear))); },
      event: (id, event) => delivery.toCoordinator(id, event), changed: () => { void this.#sweepTasks(true).catch(() => undefined); } });
    this.tracker = new PullRequestTracker({ withdrawDecision: (id, questionId, reason) => this.decisions.withdraw(id, questionId, reason), settings: id => this.admission.settings(id), automaticFix: (id, kind) => this.threads.automaticFix(id, kind), automaticFixLimit: (id, kind) => this.threads.automaticFixLimit(id, kind), comments: (thread, since) => this.#github.reviewComments(thread, since), threads: this.store, github, git, worktrees, project: (projectId) => this.#project(projectId),
      toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event),
      transition: async (threadId, apply) => { const runner = this.threads.runner(threadId); if (runner) await runner.transition(apply); else await apply(); },
      hub: o.hub, deviceId: o.deviceId, assertMerge: (id, tid) => this.daily.assertMerge(id, tid),
      redactor: o.redactor, now, pollMs: timers.prPollMs, periodic: timers.periodic });
    const verification = new PullRequestVerification({ projectEnvironment, sessionEnd: evidence => this.ledgers.sessionEnd(evidence), hub: o.hub, homes: o.homes, git, launcher, deviceId: o.deviceId, deviceName: o.deviceName, facts, redactor: o.redactor, now, settings: o.settings, accounts: o.accounts, runtimes: o.runtimes, timeoutMs: timers.testTimeoutMs,
      memory: project => o.memory.project(project, o.deviceId, () => { throw new Error(THREAD_MEMORY_READ_ONLY); }, { kind: 'verification' }) });
    publication.bindBackup(id => this.store.local(id), (id, pushedCommit) => this.store.updateLocal(id, local => ({ ...local, pushedCommit })));
    this.landings = new ThreadLandingService({ ...(o.landingJev ? { jev: o.landingJev } : {}),  homes: o.homes, git, github, publication, hub: o.hub, store: this.store, verification,
      ...(o.leases ? { leases: o.leases } : {}), deviceId: o.deviceId, redactor: o.redactor, now, settings: id => this.admission.settings(id), configuration: o.settings,
      ...(o.decisionClient ? { decisionClient: o.decisionClient } : {}), projectEnvironment, assertLanding: (id, tid) => this.daily.assertMerge(id, tid),
      retry: async (_projectId, threadId) => { const runner = this.threads.runner(threadId); if (runner && !runner.busy) await runner.requestTurn('publish', 'Retry the checked landing.'); } });
    this.mergeGate = new ProjectMergeGate({ hub: o.hub, store: this.store, tracker: this.tracker, github, verification, deviceId: o.deviceId, redactor: o.redactor, now,
      settings: id => this.admission.settings(id), configuration: o.settings, ...(o.decisionClient ? { decisionClient: o.decisionClient } : {}), project: id => this.#project(id), repository: project => worktrees.repository(project),
      event: (id, event) => delivery.toCoordinator(id, event), assertMerge: (id, tid) => this.daily.assertMerge(id, tid), message: (id, tid, text, messageId) => this.threads.message(id, tid, 'coordinator', text, false, messageId) });
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
      jobRun: envelope => this.jobs.accept(envelope.body.runId, envelope.sourceDeviceId),
      threadStart: (envelope) => this.#threadStart(envelope),
      threadCommand: (envelope) => this.#threadCommand(envelope),
    }, dropped: (lost) => this.#lostEnvelope(lost) });
    this.#attach = new ThreadAttach({ deviceId: o.deviceId, deviceName: o.deviceName, store: this.store, coordinators: coordinatorStore, hub: o.hub, roster: o.roster,
      runner: (threadId) => this.threads.runner(threadId), project: (projectId) => this.#project(projectId), accounts: o.accounts, transcripts: this.transcripts });
    this.views = new ProjectViews({ mergesHeld: async (id, tid) => await this.daily.mergesHeld(id) && !(await this.daily.allowedMergeThreads(id)).includes(tid), deviceId: o.deviceId, deviceName: o.deviceName, hub: o.hub, projects: o.projects, store: this.store, ledgers: this.ledgers,
      githubNotice: async projectId => { const budget = await (await github.open(projectId)).rateLimit(); return budget && budget.remaining / budget.limit < 0.2 && budget.resetAt > now() ? 'GitHub has less than 20% of its request budget remaining. Pull requests refresh every five minutes until it resets.' : undefined; },
      coordinators: this.coordinators, transcripts: this.transcripts, worktrees, accounts: o.accounts, runtimes: o.runtimes, settings: o.settings, roster: o.roster, placement, now });
    this.notifications = new ProjectNotifications({ deviceId: o.deviceId, ledgers: this.ledgers, store: this.store, hub: o.hub, projects: o.projects, redactor: o.redactor, now });
    this.usage = new ProjectUsage({ deviceId: o.deviceId, hub: o.hub, ledgers: this.ledgers, store: this.store, now, timezone: async projectId => (await this.admission.settings(projectId)).nightlyWindow.timezone });
    this.ready = Promise.all([this.apps.ready, recoverProjects({ paths: this.paths, ledgers: this.ledgers, store: this.store, coordinators: this.coordinators,
      toCoordinator: (projectId, event) => delivery.toCoordinator(projectId, event), redactor: o.redactor, now })]).then(async () => { await this.usage.rebuild(); await this.notifications.rebuild(); });
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
  async #capture(project: Project, source: { scope: MemoryCapture['scope']; runtime: string; model: string; accountId: string; sessionId?: string | undefined; threadId?: string }): Promise<void> {
    if (!source.sessionId || !(await this.admission.settings(project.id)).memory.capture) return;
    if (!['claude', 'codex'].includes(source.runtime)) return;
    const accountHome = this.#o.homes.at('homes', source.runtime, source.accountId);
    const journal = (await listNativeSessions({ runtime: nativeFormat(source.runtime), root: accountHome })).find(journal => journal.nativeId === source.sessionId);
    if (!journal) return;
    const task = source.threadId ? (await this.tasks.list(project.id)).find(task => task.threadId === source.threadId) : undefined;
    const context = { projectId: project.id, scope: source.scope, runtime: source.runtime, model: source.model, sessionId: source.sessionId, transcriptPath: journal.file,
      ...(source.threadId ? { threadId: source.threadId } : {}), ...(task ? { taskId: task.id } : {}) };
    await this.captures.capture(context, accountHome, async (capture, text) => {
      if (this.#o.sendCapture) await this.#o.sendCapture({ schema: 'project-memory-request-v1', projectId: project.id,
        scope: { kind: source.threadId ? 'thread' : 'coordinator', id: source.threadId ?? project.id }, operation: 'capture', capture, text });
      else this.captures.accept(capture, text);
    });
  }
  /** Coordinator tool handlers (brief 7.1), built on first use because the thread service and the tracker come after the coordinators. Memory is read-only. */
  #coordinatorTools(): CoordinatorToolHandlers {
    return this.#tools ??= { ...coordinatorToolHandlers({ deviceId: this.#o.deviceId, deviceName: this.#o.deviceName, threads: this.threads, tasks: this.tasks, goals: this.goals, daily: this.daily, jobs: this.jobs, store: this.store, decisions: this.decisions,
      handoffWrite: async (projectId, turn, input) => {
        if (!this.journal) throw new Error('Coordinator handoffs are unavailable.');
        const ledger = this.ledgers.coordinator(projectId);
        const ownerEventIds = ledger.events().flatMap(event => { if (event.type !== 'coordinator-event') return []; const data = ledger.payload(event as typeof event & { type: 'coordinator-event' }); return data.kind === 'user-message' ? [data.id] : []; });
        const handoff = await this.journal.writeHandoff({ schema: 'project-journal-request-v1', operation: 'handoff-write', projectId, id: derivedId('handoff', projectId, this.#o.deviceId, String(turn)), turn, input });
        this.coordinators.store.updateLocal(projectId, local => ({ ...local, handoffSaved: { id: handoff.id, turn, ownerDigest: createHash('sha256').update(JSON.stringify([...new Set(ownerEventIds)].sort())).digest('hex') } }));
        return handoff;
      },
      setupPropose: (id, trigger, input) => this.proposeSetup(id, trigger, input),
      settingsUpdate: (id, input, requestId) => this.coordinatorSettings(id, input, requestId),
      library: this.#o.library, pullRequests: this.tracker, github: this.#github, terminalRead: this.#o.terminalRead, hub: this.#o.hub, ledgers: this.ledgers, roster: this.#o.roster, now: () => this.#timers.now(),
      memory: async (projectId, scope) => this.#o.memory.project(await this.#project(projectId), this.#o.deviceId, () => { throw new Error(COORDINATOR_MEMORY_READ_ONLY); },
        { kind: 'coordinator', ...(scope?.provenance ? { provenance: scope.provenance } : {}) }) }),
      capture: async (scope, payload) => {
        const session = this.coordinators.get(scope.projectId).state().session;
        if (scope.kind !== 'coordinator' || !session || payload?.sessionId && payload.sessionId !== session.nativeSessionId) throw new Error('Capture needs this coordinator’s current session.');
        await this.#capture(await this.#project(scope.projectId), { scope: 'coordinator', runtime: session.runtime, model: session.model, accountId: session.accountId, sessionId: session.nativeSessionId });
      } };
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
    if (!deviceAllowsWork(this.#o.homes)) throw refuse('This device serves apps only; project work runs on a working device.', 409);
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
    void this.ready.then(async () => {
      if (this.#closing) return;
      await this.#restoreAttachedGrants();
      this.journal?.start(this.#timers.periodic);
      if (!deviceAllowsWork(this.#o.homes)) { this.inbox.start(); return; }
      this.threads.begin();
      this.coordinators.begin();
      void this.threads.sweep().catch(() => undefined);
      void this.#sweepTasks().catch(() => undefined);
      void this.outbox.drain();
      this.inbox.start();
      if (!this.#timers.periodic) return;
      this.tracker.start();
      this.#sweepTimer = setInterval(() => { void this.threads.sweep().then(() => this.#sweepTasks()).then(() => this.tracker.poll()).catch(() => undefined); this.coordinators.sweep(); }, this.#timers.queueSweepMs); this.#sweepTimer.unref();
    }, () => undefined);
  }
  /**
   * One round of the periodic work (tests and the UI refresh): PR poll, index flush, queue and waiting sweeps, coordinator re-checks
   * (D70), then the outbox drain and the inbox poll, which never fail (a hub outage leaves both for the next round).
   */
  async pulse(): Promise<void> {
    await this.ready;
    if (!deviceAllowsWork(this.#o.homes)) { await this.inbox.poll(); return; }
    await this.tracker.poll();
    await this.#publisher.flush().catch(() => undefined);
    await this.threads.sweep();
    await this.#sweepTasks();
    this.coordinators.sweep();
    await this.outbox.drain();
    await this.inbox.poll();
  }
  /** The hub stored an envelope for this device (the hub's relay route, or this device's own outbox): poll the inbox now. */
  relayArrived(): void {
    if (!this.#started || this.#closing) return;
    void this.ready.then(() => { if (!this.#closing) this.inbox.kick(); }, () => undefined);
  }
  #sweepTasks(changed = false): Promise<void> {
    if (this.#taskSweep) { if (changed) this.#taskSweepAgain = true; return this.#taskSweep; }
    this.#taskSweep = (async () => {
      try {
        do { this.#taskSweepAgain = false; await this.#runTaskSweep(); } while (this.#taskSweepAgain && !this.#closing);
      } finally { this.#taskSweep = undefined; }
    })();
    return this.#taskSweep;
  }
  async #runTaskSweep(): Promise<void> {
    if (!this.#started || this.#closing || !deviceAllowsWork(this.#o.homes) || this.#o.workRefusal?.()) return;
    try {
      for (const { project } of await this.#o.projects.list()) {
        if (this.#closing) break;
        await this.jevDecisions.flushUses(project.id);
        const ledger = this.ledgers.coordinator(project.id);
        if (this.#o.hub.putSessionCache && this.#cachePublished.get(project.id) !== ledger.lastId()) {
          const version = ledger.lastId();
          await this.#o.hub.putSessionCache({ schema: 'project-session-cache-v1', revision: 0, projectId: project.id, deviceId: this.#o.deviceId,
            lastEventId: version, updatedAt: new Date(this.#timers.now()).toISOString(), records: sessionCacheSnapshot(cacheRecords(ledger)) });
          this.#cachePublished.set(project.id, version);
        }
        if ((await this.admission.settings(project.id)).status === 'active') await this.memoryProgramme?.sweep(project);
        await this.usage.refresh(project.id); await this.notifications.flush();
        await this.#exportToVault(project).catch(() => undefined);
        if ((await this.#o.hub.coordinator(project.id))?.document.deviceId === this.#o.deviceId) { await this.#withdrawSignIns(project.id); if ((await this.admission.settings(project.id)).status === 'active') await this.reviews.sweep(project.id); await this.daily.sweep(project.id); await this.dispatcher.sweep(project.id); await this.goals.sweep(project.id); await this.deploys.sweep(project.id); } else await this.jobs.sweep(project.id);
        if ((await this.admission.settings(project.id)).status === 'active') await this.memoryProgramme?.sweep(project);
      }
      this.mergeGate.sweep(); await this.landings.sweep();
    } catch (error) { if (!(error instanceof HubUnavailable)) throw error; }
  }
  /** Phase 5: the project's definition and coordinator notebook follow every change into its vault folder; the vault pushes them. */
  /**
   * Phase 5: the project's definition and coordinator notebook follow this hub's changes into its vault folder; the vault pushes them.
   * Only what changed here since the last export or restore is written, so another hub's newer definition is never overwritten with
   * an older one, and a folder this hub has neither restored nor written stays untouched until the owner restores it.
   */
  async #exportToVault(project: Project, write = true): Promise<void> {
    const store = this.#o.hubMemory, vault = store?.vault, folder = vault?.folder(project.id); if (!store || !vault || !folder) return;
    const [settings, goals, jobs, dailies, notebook] = await Promise.all([this.admission.settings(project.id), this.goals.list(project.id), this.daily.jobs(project.id), this.daily.dailies(project.id), this.#o.hub.notebook(project.id)]);
    const definition = this.#o.redactor.text(vaultDefinitionText(vaultDefinition(project, settings, goals, jobs, dailies))), notes = notebook ? this.#o.redactor.text(notebook.document.content) : undefined;
    const marker = join(store.root(project.id), 'vault-export.json'), digest = (text?: string) => text === undefined ? null : createHash('sha256').update(text).digest('hex');
    const prior = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) as { definition: string | null; notebook: string | null } : null;
    if (write) {
      const stored = vault.vault.read(folder, 'project.json');
      // Before the first export, wait until the vault has seen GitHub once, and leave a definition another hub wrote for Restore.
      const status = vault.vault.status();
      if (!prior && (status.remote && !status.lastSyncAt || stored !== null && stored !== definition)) return;
      const files: Partial<Record<'project.json' | 'notebook.md', string>> = {};
      if (prior?.definition !== digest(definition)) files['project.json'] = definition;
      if (notes !== undefined && prior?.notebook !== digest(notes)) files['notebook.md'] = notes;
      if (Object.keys(files).length) vault.vault.writeFiles(folder, files, `owner: ${project.name.replace(/[\r\n]/gu, ' ')} definition and notebook`);
    }
    atomicWrite(marker, `${JSON.stringify({ definition: digest(definition), notebook: digest(notes) })}\n`);
  }
  /** Phase 5.6: recreates this project's work from its vault folder (after a pull). False when the vault has no definition for it. */
  async restoreFromVault(projectId: string): Promise<boolean> {
    const vault = this.#o.hubMemory?.vault; if (!vault) throw refuse('The vault belongs to the hub.', 404);
    const folder = vault.folder(projectId); if (!folder) throw refuse('Only a project with a GitHub origin has a vault folder.', 409);
    await vault.vault.pull();
    const text = vault.vault.read(folder, 'project.json'); if (!text) return false;
    await restoreFromVault(this, projectId, folder, JSON.parse(text), vault.vault.read(folder, 'notebook.md'));
    // What this hub now has came from the vault: later exports write only what changes here after this point.
    await this.#exportToVault(await this.#project(projectId), false);
    return true;
  }
  /** B3: a question asking the owner to sign in to an account is withdrawn once that account is Ready, so no stale blocker stays open. */
  async #withdrawSignIns(projectId: string): Promise<void> {
    const waiting = (await this.#o.hub.decisions(projectId)).filter(decision => decision.accountId && !decision.answer && !decision.withdrawnAt);
    if (!waiting.length) return;
    const ready = new Set((await this.#o.accounts.list()).filter(view => view.statuses.some(status => status.auth === 'ready')).map(view => view.account.id));
    for (const decision of waiting) if (ready.has(decision.accountId!)) await this.decisions.withdraw(projectId, decision.id, 'The account now reports Ready.');
  }
  /** Resolves when no start, sweep, thread step or coordinator turn is in flight or scheduled (test seam; checks every 20 ms, twice in a row). */
  async idle(projectId?: string): Promise<void> {
    await this.ready;
    for (let quiet = 0; quiet < 2;) {
      await delay(20); quiet = this.#taskSweep || this.notifications.busy() || this.usage.busy() || this.reviews.busy(projectId) || this.mergeGate.busy() || this.jobs.busy(projectId) || this.threads.busy(projectId) || this.dispatcher.busy(projectId) || this.coordinators.busy(projectId) || this.outbox.busy || this.inbox.busy ? 0 : quiet + 1;
    }
  }
  /** Stops timers, terminates every running turn (shutdown intent) and drains; thread states are never rewritten (D24). */
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      if (this.#sweepTimer) clearInterval(this.#sweepTimer);
      await this.ready.catch(() => undefined);
      for (const grant of this.#attachedGrants.values()) await grant.close(); this.#attachedGrants.clear();
      // No new envelope is handled while turns stop; the outbox closes last, its entries stay on disk for the next start.
      await this.inbox.close();
      // Coordinator turns first (their tools start and message threads), then runners: tracker transitions wait on runner chains (2.6.14).
      await this.coordinators.close();
      await this.memoryProgramme?.close();
      await this.captures.close();
      await this.mergeGate.close();
      await this.reviews.close();
      await this.threads.close();
      await this.dispatcher.close();
      await this.jobs.close();
      // A sweep may await a running job/session. Cancel those owners first, then drain before state publishers close.
      await this.#taskSweep?.catch(() => undefined);
      await this.journal?.close();
      await this.apps.close();
      await this.tracker.close();
      await this.notifications.close();
      await this.usage.close();
      await this.#publisher.close();
      await this.outbox.close();
    })();
  }

  // Browser and API operations. Refusals throw Error(sentence) with a status.
  list(): Promise<ProjectWorkListView> { return this.views.list(); }
  async goalList(projectId: string) { await this.#project(projectId); return this.goals.view(projectId); }
  async goalViews(projectId: string) {
    const [goals, tasks, work, daily] = await Promise.all([this.goalList(projectId), this.taskList(projectId), this.view(projectId), this.daily.view(projectId)]);
    return projectGoalViews(projectId, goals.goals, tasks.tasks, work.threads, daily);
  }
  async goalEditor(projectId: string, goalId?: string) {
    await this.#project(projectId); return goalEditorView(projectId, goalId ? await this.goals.read(projectId, goalId) : undefined);
  }
  async saveGoalEditor(projectId: string, goalId: string | undefined, raw: unknown) {
    const request = goalEditorRequest(raw, goalId);
    return goalId ? this.updateGoal(projectId, goalId, request) : this.createGoal(projectId, request);
  }
  async jobsView(projectId: string) {
    await this.#project(projectId);
    const [raw, settings, goals] = await Promise.all([this.daily.view(projectId), this.admission.settings(projectId), this.goalList(projectId)]);
    return projectJobsView(raw, settings, goals.goals);
  }
  async routineEditor(projectId: string, kind: 'job' | 'daily', itemId?: string) {
    await this.#project(projectId);
    const [jobs, goals] = await Promise.all([this.daily.jobs(projectId), this.goalList(projectId)]);
    const option = async (value: string, label: string, validate: () => Promise<void>): Promise<RoutineEditorChoice> => {
      try { await validate(); return { value, label, disabled: false, refusal: null }; }
      catch (error) { const status = statusOf(error); if (typeof status !== 'number' || status < 400 || status >= 500) throw error;
        return { value, label, disabled: true, refusal: error instanceof Error ? error.message : 'Unavailable.' }; }
    };
    const goalOptions = (review: boolean) => Promise.all(goals.goals.map(({ goal }) => option(goal.id, goal.name, () => this.daily.validateEditorGoal(projectId, goal.id, review))));
    if (kind === 'job') {
      const item = jobs.find(row => row.id === itemId); if (itemId && !item) throw refuse('Job not found.', 404);
      const [ordinary, gates] = await Promise.all([goalOptions(false), Promise.all(jobs.filter(job => job.id !== itemId && job.run.kind === 'command')
        .map(job => option(job.id, job.name, () => this.daily.validateEditorGate(projectId, itemId ?? 'new_job', job.id))))]);
      return jobEditorView(projectId, item, { goals: ordinary, gates });
    }
    const item = (await this.daily.dailies(projectId)).find(row => row.id === itemId); if (itemId && !item) throw refuse('Daily item not found.', 404);
    const [ordinary, review] = await Promise.all([goalOptions(false), goalOptions(true)]);
    return dailyEditorView(projectId, item, jobs, { ordinary, review });
  }
  async saveRoutineEditor(projectId: string, itemId: string | undefined, raw: unknown, expectedKind?: 'job' | 'daily') {
    const request = RoutineEditorSaveRequestSchema.parse(raw);
    const kind = request.schema === 'job-editor-create-request-v1' || request.schema === 'job-editor-update-request-v1' ? 'job' : 'daily';
    if (expectedKind && kind !== expectedKind) throw refuse('The editor request does not match this definition.', 400);
    await this.#coordinatorHere(projectId);
    const item = itemId ? kind === 'job' ? (await this.#o.hub.job(itemId))?.document : (await this.#o.hub.daily(itemId))?.document : undefined;
    if (itemId && (!item || item.projectId !== projectId)) throw refuse(kind === 'job' ? 'Job not found.' : 'Daily item not found.', 404);
    const input = routineEditorRequest(request, item);
    switch (input.schema) {
      case 'job-create-request-v1': return this.daily.createJob(projectId, input);
      case 'job-update-request-v1': return this.daily.updateJob(projectId, itemId!, input);
      case 'daily-create-request-v1': return this.daily.createDaily(projectId, input);
      case 'daily-update-request-v1': return this.daily.updateDaily(projectId, itemId!, input);
    }
  }
  runningThreads(): string[] { return this.store.all().filter(thread => liveWork(thread.state)).map(thread => thread.id); }
  async prepareDailyWork(projectId: string): Promise<void> { await this.#coordinatorHere(projectId); }
  async setupEkoaCode(projectId: string, raw: unknown) {
    const input = EkoaCodeSetupRequestSchema.parse(raw), project = await this.#project(projectId), repository = parseGitHubRemote(project.remoteUrl ?? '');
    if (repository?.owner !== 'gongiskhan' || repository.repo !== 'ekoa-code' || project.githubTokenScope !== 'project' || project.testCommand !== EKOA_FAST_CHECKS || !project.allowedDevices?.includes(this.#o.deviceId) || project.allowedDevices.some(id => !project.paths[id]))
      throw refuse('Register the dedicated Ekoa Code clones on the allowed devices, with the project token and fast checks.', 409);
    const entry = (await this.#o.settings()).menu.find(row => row.id === input.modelId && row.enabled && row.runtime === 'claude' && row.efforts.includes('high') && /opus\s*5\.5/iu.test(row.label));
    if (!entry) throw refuse('Choose the account-discovered Claude Opus 5.5 model with high effort before setting up Ekoa Code.', 409);
    await this.#coordinatorHere(projectId);
    return this.tasks.exclusive(projectId, async () => applyEkoaCodeSetup(this, projectId, input, join(this.paths.project(projectId), 'ekoa-code-setup.json'), await this.admission.settings(projectId)));
  }
  async createGoal(projectId: string, raw: unknown) { await this.#coordinatorHere(projectId); return this.goals.create(projectId, raw); }
  async updateGoal(projectId: string, goalId: string, raw: unknown) { await this.#coordinatorHere(projectId); return this.goals.update(projectId, goalId, raw); }
  async pageView(projectId: string, resolvedDays = 14, viewer: Pick<ProjectPageRequest, 'timeZone' | 'locale' | 'ackKnown'> = {}) {
    const [work, tasks, goals, daily, roster] = await Promise.all([this.view(projectId), this.taskList(projectId), this.goalList(projectId), this.daily.view(projectId), this.#o.roster()]);
    const names = new Map(roster.devices.map(row => [row.device.id, row.device.name])); names.set(this.#o.deviceId, this.#o.deviceName);
    return projectPageView({ work, tasks: tasks.tasks, goals: goals.goals, daily }, resolvedDays, this.#timers.now(), { ...viewer, runtimeName: id => this.#o.runtimes.get(id)?.displayName ?? id, deviceName: id => names.get(id) ?? id });
  }
  async #chatSource(projectId: string, throughEventId?: number, work?: ProjectWorkView) {
    const [ledger, snapshot] = await Promise.all([this.coordinatorEvents(projectId), work ?? this.view(projectId)]);
    const records = ledger.events(), head = records.at(-1)?.id ?? 0, through = throughEventId ?? head;
    const events = ledger.redact(records.filter(event => event.id <= through && event.type !== 'journal-source' && event.type !== 'journal-document').map(event => ({ ...event, data: publicProjectData(ledger.data(event)) })));
    return { schema: 'project-chat-source-v1' as const, projectId, deviceId: this.#o.deviceId, head, threads: snapshot.threads, events };
  }
  async coordinatorComposer(projectId: string) { const page = await this.pageView(projectId); return projectCoordinatorComposerFromUi(projectId, this.#o.deviceId, page.header.current); }
  async chatView(projectId: string, raw?: unknown) {
    const input = projectChatRequest(raw); return projectChatView(await this.#chatSource(projectId, input.throughEventId), input);
  }
  async chatCardView(projectId: string, raw: unknown) {
    const input = ProjectChatCardViewRequestSchema.parse(raw), page = await this.pageView(projectId), source = await this.#chatSource(projectId, undefined, page.work);
    if (input.deviceId !== undefined && input.deviceId !== source.deviceId) throw Object.assign(new Error('The coordinator device changed. Read the chat again.'), { status: 409 });
    const items = chatItems(source.events, projectChatThreadTitles(source.threads)), item = items.find(row => row.id === input.itemId);
    if (!item || item.kind !== 'routed') throw Object.assign(new Error('Work card not found.'), { status: 404 });
    const startAll = chatProposalGroups(items, page.tasks).get(item.id) ?? [];
    const view = projectChatCardInteraction({ schema: 'project-chat-card-interaction-source-v1', projectId, item, tasks: page.tasks, threads: page.work.threads, cards: page.cards, startAll });
    return ProjectChatCardViewSchema.parse({ schema: 'project-chat-card-view-v1', projectId, deviceId: source.deviceId, request: { ...input, deviceId: source.deviceId }, view });
  }
  async taskPageView(projectId: string, taskId: string) {
    const [task, work] = await Promise.all([this.taskView(projectId, taskId), this.view(projectId)]);
    return projectTaskPageView(projectId, task.task, work.threads);
  }
  async taskQueueInteraction(projectId: string, raw?: unknown) {
    const input = projectTaskQueueRequest(raw), [goals, tasks, work, daily] = await Promise.all([this.goalList(projectId), this.taskList(projectId), this.view(projectId), this.daily.view(projectId)]);
    return projectTaskQueueInteraction({ projectId, tasks: tasks.tasks, queue: projectGoalViews(projectId, goals.goals, tasks.tasks, work.threads, daily).queue }, input);
  }
  async taskEditView(projectId: string, taskId: string) {
    const [view, goals] = await Promise.all([this.taskView(projectId, taskId), this.goalList(projectId)]);
    return projectTaskEditView(view.task, goals.goals);
  }
  async taskDraft(projectId: string, taskId: string, raw: unknown) {
    const draft = projectTaskDraft(projectId, taskId, raw); await this.taskView(projectId, taskId); return draft;
  }
  async taskCommand(projectId: string, taskId: string, raw: unknown) {
    const command = ProjectTaskCommandSchema.parse(raw);
    if (command.projectId !== projectId || command.taskId !== taskId) throw Object.assign(new Error('This command belongs to another task or project.'), { status: 409 });
    return command.operation === 'update' ? this.updateTask(projectId, taskId, command.body) : this.taskAction(projectId, taskId, command.body);
  }
  async taskEditor(projectId: string, deviceId = this.#o.deviceId, preview?: unknown) {
    const [page, configuration, roster] = await Promise.all([this.pageView(projectId), this.#o.settings(), this.#o.roster()]);
    const models = configuration.menu.filter(row => row.enabled).map(row => ({ id: row.id, label: `${this.#o.runtimes.get(row.runtime)?.displayName ?? row.runtime} ${row.label}`, efforts: row.efforts }));
    return taskEditorView({ work: page.work, deviceId, roster, models, tasks: page.tasks, goals: page.goals, coordinator: page.header.current }, preview);
  }
  async taskList(projectId: string) { await this.#project(projectId); return TaskListViewSchema.parse({ schema: 'task-list-view-v1', projectId, tasks: await this.tasks.list(projectId) }); }
  async taskView(projectId: string, taskId: string) { return TaskViewSchema.parse({ schema: 'task-view-v1', task: await this.tasks.read(projectId, taskId) }); }
  async createTask(projectId: string, raw: unknown) {
    await this.#coordinatorHere(projectId); const receipt = await this.tasks.create(projectId, TaskCreateRequestSchema.parse(raw));
    void this.#sweepTasks(true).catch(() => undefined); return receipt;
  }
  async updateTask(projectId: string, taskId: string, raw: TaskUpdateRequest) { return TaskViewSchema.parse({ schema: 'task-view-v1', task: await this.tasks.update(projectId, taskId, raw) }); }
  async taskAction(projectId: string, taskId: string, raw: unknown) {
    const task = await this.tasks.action(projectId, taskId, raw); void this.#sweepTasks(true).catch(() => undefined); return TaskViewSchema.parse({ schema: 'task-view-v1', task });
  }
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
  /** A queued remote start can precede its index; an owner stream waits only for a known dispatched task. */
  async threadStreamOwner(projectId: string, threadId: string): Promise<string | null> {
    const owner = await this.threadOwner(projectId, threadId); if (owner !== null) return owner;
    const pending = (await this.tasks.list(projectId)).some(task => task.threadId === threadId && ['queued', 'active'].includes(task.state));
    if (!pending) return null;
    for (let attempt = 0; attempt < 50; attempt++) {
      await delay(200);
      const arrived = await this.threadOwner(projectId, threadId); if (arrived !== null) return arrived;
    }
    throw refuse('This thread is still starting on its device. Try again shortly.', 409);
  }
  /** A read also needs the owner's local file, which can arrive after its dispatch index. */
  async threadReadOwner(projectId: string, threadId: string): Promise<string | null> {
    const owner = await this.threadStreamOwner(projectId, threadId);
    if (owner !== this.#o.deviceId) return owner;
    for (let attempt = 0; attempt < 50; attempt++) {
      const local = this.store.get(threadId);
      if (local) return local.projectId === projectId ? owner : null;
      await delay(200);
    }
    throw refuse("This thread's data has not arrived on its device. Try again shortly.", 409);
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
      text: input.text, clientMessageId: input.clientMessageId, ...(input.via ? { via: input.via } : {}) });
  }
  /** Installation control messages use durable owner delivery and retain the first event time across retries. */
  async sendOwnerMessage(projectId: string, raw: z.input<typeof ProjectSendRequestSchema>): Promise<void> {
    await this.ready; await this.#project(projectId);
    const { waitSeconds: _wait, ...input } = ProjectSendRequestSchema.parse(boundedRedaction(this.#o.redactor, raw)); void _wait;
    const path = this.#o.homes.at('project-work', projectId, 'owner-messages', `${input.clientMessageId}.json`);
    const saved = existsSync(path) ? readDocument(path, ProjectSendSavedSchema) : writeDocument(path, ProjectSendSavedSchema, { schema: 'project-send-saved-v1', projectId, input, at: new Date(this.#timers.now()).toISOString() });
    if (saved.projectId !== projectId || stableJson(saved.input) !== stableJson(input)) throw refuse('This message id already has different content.', 409);
    const event = { schema: 'coordinator-event-v1' as const, kind: 'user-message' as const, id: derivedId('cev', 'local-owner', projectId, input.clientMessageId), at: saved.at, text: input.text, clientMessageId: input.clientMessageId, ...(input.via ? { via: input.via } : {}) };
    const device = await this.coordinators.deviceOf(projectId);
    if (device !== null && device !== this.#o.deviceId) this.outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event });
    else { await this.coordinators.ensureAssigned(projectId); this.coordinators.get(projectId).enqueue(event); }
  }
  /** Owner-terminal results and Send to use the existing durable message delivery, with a stable id for retry. */
  async terminalMessage(projectId: string, target: { threadId?: string | undefined; coordinator?: true | undefined }, text: string, messageId: string): Promise<void> {
    await this.ready;
    if (target.threadId && !target.coordinator) { await this.threads.message(projectId, target.threadId, 'owner', text, false, messageId); return; }
    const at = this.#timers.now(), event = { schema: 'coordinator-event-v1' as const, kind: 'user-message' as const, id: `cev_${messageId}`.slice(0, 128),
      at: new Date(at).toISOString(), text, clientMessageId: messageId };
    const device = await this.coordinators.deviceOf(projectId);
    if (device !== null && device !== this.#o.deviceId) this.outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event });
    else { await this.coordinators.ensureAssigned(projectId); this.coordinators.get(projectId).enqueue(event); }
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
  /**
   * Whether the coordinator failed two turns in a row and waits for the owner, from its local state here (with the last failed turn's
   * error as the reason), else from the status it published. Null when it is not stopped.
   */
  async coordinatorStop(projectId: string): Promise<{ reason?: string } | null> {
    await this.#project(projectId);
    const deviceId = await this.coordinators.deviceOf(projectId); if (deviceId === null) return null;
    if (deviceId !== this.#o.deviceId) {
      const published = (await this.#o.hub.coordinatorStatus(projectId))?.document;
      return published?.deviceId === deviceId && published.failedTurnsInARow >= 2 ? {} : null;
    }
    if (this.coordinators.get(projectId).state().failedTurnsInARow < 2) return null;
    const ledger = this.ledgers.coordinator(projectId);
    const last = ledger.events().findLast(event => event.type === 'coordinator-turn-end');
    const reason = last ? ledger.payload(last as ProjectLedgerEvent & { type: 'coordinator-turn-end' }).error : undefined;
    return reason ? { reason } : {};
  }
  /** The coordinator ledger position here, for `coordinatorTurnAfter`. */
  coordinatorPosition(projectId: string): number { return this.ledgers.coordinator(projectId).lastId(); }
  /** The first coordinator turn on this device after a ledger position: how it ended (a launch refused before it started ends too), else whether it started. */
  coordinatorTurnAfter(projectId: string, position: number): { kind: 'started' | 'completed' } | { kind: 'failed'; error: string } | null {
    const ledger = this.ledgers.coordinator(projectId); let started = false;
    for (const event of ledger.events()) {
      if (event.id <= position) continue;
      if (event.type === 'coordinator-turn-start') started = true;
      if (event.type !== 'coordinator-turn-end') continue;
      const end = ledger.payload(event as ProjectLedgerEvent & { type: 'coordinator-turn-end' });
      return end.status === 'failed' || end.status === 'timed-out' ? { kind: 'failed', error: end.error ?? end.status } : { kind: 'completed' };
    }
    return started ? { kind: 'started' } : null;
  }
  /** Whether this device runs the project's coordinator. */
  async coordinatorHere(projectId: string): Promise<boolean> { return await this.coordinators.deviceOf(projectId) === this.#o.deviceId; }
  async stopCoordinator(projectId: string): Promise<void> { await (await this.#assignedHere(projectId))?.stop(); }
  /** The next coordinator turn starts a fresh session (D77). Before assignment there is no session, and Fresh assigns nothing (D206). */
  async freshCoordinator(projectId: string): Promise<void> { (await this.#assignedHere(projectId))?.fresh(); }
  async requestCoordinatorHandoff(projectId: string): Promise<void> {
    const assigned = await this.coordinators.ensureAssigned(projectId);
    if (assigned !== this.#o.deviceId) throw refuse(COORDINATOR_ELSEWHERE, 409);
    this.coordinators.get(projectId).requestHandoff();
  }
  async settingsView(projectId: string): Promise<z.infer<typeof ProjectWorkSettingsViewSchema>> {
    const project = await this.#project(projectId);
    return this.#settingsView(project, (await this.#o.hub.settings(projectId))?.document ?? null);
  }
  async coordinatorEditor(projectId: string, preview?: unknown) {
    const [view, configuration] = await Promise.all([this.view(projectId), this.#o.settings()]);
    return coordinatorEditor(view, configuration, id => this.#o.runtimes.get(id)?.displayName ?? id, preview);
  }
  async environmentEditor(projectId: string, raw?: unknown) { return environmentEditor((await this.settingsView(projectId)).settings, raw); }
  async saveEnvironmentEditor(projectId: string, raw: unknown) {
    const input = ProjectEnvironmentEditorSaveSchema.parse(raw);
    if (input.projectId !== projectId) throw refuse('The environment belongs to another project.', 400);
    return this.putSettings(projectId, input.settingsRequest);
  }
  async placementEditor(projectId: string, raw?: unknown) {
    const [view, configuration] = await Promise.all([this.settingsView(projectId), this.#o.settings()]);
    return placementEditor(view.settings, configuration, raw);
  }
  async savePlacementEditor(projectId: string, raw: unknown) {
    const input = ProjectPlacementEditorSaveSchema.parse(raw);
    if (input.projectId !== projectId) throw refuse('The placement choices belong to another project.', 400);
    return this.putSettings(projectId, input.settingsRequest);
  }
  async landingEditor(projectId: string, raw?: unknown) {
    await this.#project(projectId);
    const input = ProjectLandingEditorRequestSchema.parse(raw ?? { schema: 'project-landing-editor-request-v1', settings: (await this.settingsView(projectId)).settings });
    if (input.settings.projectId !== projectId) throw refuse('The landing settings belong to another project.', 400);
    return landingEditor(input);
  }
  async settingsEditor(projectId: string) {
    const [settings, view, roster] = await Promise.all([this.settingsView(projectId), this.view(projectId), this.#o.roster()]);
    return settingsEditorBase(settings, view, roster);
  }
  async saveSettingsEditor(projectId: string, raw: unknown) {
    const input = settingsEditorRequest(projectId, raw), saved = await this.putSettings(projectId, input.request);
    return settingsEditorSaved(input.base, saved, input.presence, input.statusOnly);
  }
  async saveLandingEditor(projectId: string, raw: unknown) {
    const input = ProjectLandingEditorSaveSchema.parse(raw);
    if (input.projectId !== projectId) throw refuse('The landing settings belong to another project.', 400);
    return this.putSettings(projectId, input.settingsRequest);
  }
  /** The existing two-step owner workflow: settings commit first, then optional Fresh on its assigned device. */
  async saveCoordinatorEditor(projectId: string, raw: unknown) {
    const input = ProjectCoordinatorEditorSaveSchema.parse(raw);
    if (input.projectId !== projectId) throw refuse('The coordinator choices belong to another project.', 400);
    if (input.fresh && !(await this.view(projectId)).coordinator.online) throw refuse('Fresh is unavailable while the coordinator is not online.', 409);
    const saved = await this.putSettings(projectId, input.settingsRequest);
    if (input.fresh) await this.freshCoordinator(projectId);
    return saved;
  }
  #settingsView(project: Project, stored: ProjectWorkSettings | null) {
    const shown = effectiveSettings(stored ?? defaultProjectWorkSettings(project.id), project);
    return ProjectWorkSettingsViewSchema.parse({ schema: 'project-work-settings-view-v1', settings: shown.settings, configuration: projectConfigurationInfo(), ...(shown.notice ? { notice: shown.notice } : {}) });
  }
  /** Settings 5.1 with a revision check; a conflict is the owner's reload sentence. */
  async putSettings(projectId: string, input: z.infer<typeof ProjectWorkSettingsRequestSchema>, clientRequestId?: string, by: 'owner' | 'coordinator' = 'owner'): Promise<z.infer<typeof ProjectWorkSettingsViewSchema>> {
    let project = await this.#project(projectId);
    const current = (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId);
    const settings = ProjectWorkSettingsSchema.parse({ ...current, ...input.settings, schema: 'project-work-settings-v5', projectId, revision: input.revision });
    const requestId = input.clientRequestId ?? clientRequestId;
    if (input.settings.memory && input.settings.memory.mode !== project.memory.mode && this.#o.switchMemory) {
      if (current.revision !== input.revision) throw refuse(SETTINGS_CHANGED, 409);
      project = await this.#o.switchMemory(projectId, input.settings.memory.mode, requestId ?? newId('memory_mode'));
    }
    try {
      const saved = (await this.#o.hub.putSettings(settings, input.revision, ...(requestId === undefined ? [] : [requestId]))).document;
      if (saved.revision < current.revision) return this.settingsView(projectId);
      const fields = ['maxRunningThreads', 'maxNewThreadsPerDay', 'startMode', 'prAutoFix.checks', 'prAutoFix.conflicts', 'prAutoFix.comments', 'instructions', 'placement.guidance'] as const;
      const changes = fields.filter(field => projectSettingValue(current, field) !== projectSettingValue(saved, field)).map(field => ({ field,
        from: settingText(projectSettingValue(current, field)), to: settingText(projectSettingValue(saved, field)) }));
      if (changes.length) await this.#settingsEvent(projectId, { schema: 'coordinator-event-v1', kind: 'settings-changed', by, changes,
        ...(current.instructions !== saved.instructions ? { instructions: saved.instructions } : {}), id: `cev_settings_${projectId}_${saved.revision}`, at: new Date(this.#timers.now()).toISOString() });
      if (saved.status === 'active' && current.status !== 'active') {
        this.coordinators.get(projectId).kick();
        void this.threads.sweep().then(() => this.#sweepTasks()).catch(() => undefined);
      }
      return this.#settingsView(project, saved);
    }
    catch (error) { if (statusOf(error) === 409) throw refuse(SETTINGS_CHANGED, 409); throw error; }
  }
  async #settingsEvent(projectId: string, event: CoordinatorEvent): Promise<void> {
    const device = await this.coordinators.deviceOf(projectId);
    if (device !== null && device !== this.#o.deviceId) this.outbox.enqueue(projectId, 'coordinator', { kind: 'coordinator-event', event });
    else if (device !== null) this.coordinators.get(projectId).enqueue(event);
  }
  async undoSetting(projectId: string, raw: unknown): Promise<z.infer<typeof ProjectWorkSettingsViewSchema>> {
    const project = await this.#project(projectId), input = ProjectSettingsUndoRequestSchema.parse(raw);
    const current = (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId);
    const value = projectSettingValue(current, input.change.field);
    if (value !== input.change.after && !(value === input.change.before && current.revision > input.expectedRevision)) throw refuse(SETTING_CHANGED_AGAIN, 409);
    const next = withProjectSetting({ ...current, revision: input.expectedRevision }, input.change.field, input.change.before);
    try {
      const saved = (await this.#o.hub.putSettings(next, input.expectedRevision, input.clientRequestId)).document;
      await this.#settingsEvent(projectId, { schema: 'coordinator-event-v1', kind: 'settings-changed', by: 'owner',
        changes: [{ field: input.change.field, from: settingText(input.change.after), to: settingText(input.change.before) }],
        ...(input.change.field === 'instructions' ? { instructions: saved.instructions } : {}),
        id: `cev_settings_${projectId}_${saved.revision}`, at: new Date(this.#timers.now()).toISOString() });
      return this.#settingsView(project, saved);
    } catch (error) { if (statusOf(error) === 409) throw refuse(SETTING_CHANGED_AGAIN, 409); throw error; }
  }
  async settingsChangeView(projectId: string, raw: unknown) {
    const input = ProjectSettingsChangeViewRequestSchema.parse(raw);
    if (input.change.projectId !== projectId) throw refuse('The settings change belongs to another project.', 400);
    await this.#project(projectId);
    const current = (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId);
    return settingsChangeView(current, input.change);
  }
  /** Persist the original request before applying it, so a lost reply retries the same revision without appending twice. */
  async coordinatorSettings(projectId: string, input: unknown, requestId: string): Promise<{ schema: 'project-settings-change-result-v1'; change: ProjectSettingsChange; repeated: boolean }> {
    await this.#project(projectId);
    const file = join(this.paths.project(projectId), 'settings-changes', `${IdSchema.parse(requestId)}.json`), repeated = existsSync(file);
    const plan = repeated ? readDocument(file, SettingsChangePlanSchema) : settingsChangePlan((await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId), input, requestId, new Date(this.#timers.now()).toISOString());
    if (!repeated) writeDocument(file, SettingsChangePlanSchema, plan);
    if (plan.change.changes.length) {
      const saved = (await this.#o.hub.putSettings(plan.settings, plan.expectedRevision, requestId)).document;
      await this.#settingsEvent(projectId, { schema: 'coordinator-event-v1', kind: 'settings-changed', by: 'coordinator',
        changes: plan.change.changes.map(change => ({ field: change.field, from: settingText(change.before), to: settingText(change.after) })),
        ...(plan.change.changes.some(change => change.field === 'instructions') ? { instructions: saved.instructions } : {}),
        id: `cev_settings_${projectId}_${saved.revision}`, at: plan.change.at });
    }
    return { schema: 'project-settings-change-result-v1', change: plan.change, repeated };
  }
  async requestSetup(projectId: string, raw: unknown) {
    const input = ProjectRunRequestSchema.parse(raw); await this.#coordinatorHere(projectId);
    const at = this.#timers.now(), id = derivedId('setuprequest', projectId, input.clientRequestId);
    this.coordinators.get(projectId).enqueue({ schema: 'coordinator-event-v1', kind: 'setup-requested', id, at: new Date(at).toISOString() });
    return { schema: 'empty-request-v1' as const };
  }
  async proposeSetup(projectId: string, trigger: string, raw: unknown) {
    const project = await this.#project(projectId), id = setupProposalId(projectId, trigger);
    if (await this.#o.hub.setupProposal(id)) throw refuse(SETUP_ALREADY_PROPOSED, 409);
    const { items } = SetupProposeInputSchema.parse(raw), at = new Date(this.#timers.now()).toISOString();
    const proposal = ProjectSetupProposalSchema.parse(this.#o.redactor.document({ schema: 'project-setup-proposal-v1', id, projectId, revision: 0, createdAt: at, items }));
    projectSetupPlan(proposal, items.map((item, index) => ({ index, value: item.value })), await this.admission.settings(projectId), project, at);
    return { schema: 'setup-proposal-result-v1' as const, proposal: (await this.#o.hub.putSetupProposal(proposal)).document };
  }
  async setupView(projectId: string, id: string) {
    const project = await this.#o.projects.get(projectId), proposal = (await this.#o.hub.setupProposal(id))?.document;
    if (!project || !proposal || proposal.projectId !== projectId) throw refuse('Setup proposal not found.', 404);
    return SetupProposalViewSchema.parse({ schema: 'setup-proposal-view-v1', proposal, presentation: projectSetupPresentation(proposal), projectRevision: project.revision, settingsRevision: (await this.#o.hub.settings(projectId))?.revision ?? 0 });
  }
  async setupAction(projectId: string, id: string, raw: unknown) {
    const input = SetupActionRequestSchema.parse(raw), before = (await this.#o.hub.settings(projectId))?.document ?? defaultProjectWorkSettings(projectId);
    await this.#o.hub.setupAction(projectId, id, input);
    const after = (await this.#o.hub.settings(projectId))?.document;
    if (after && before.instructions !== after.instructions) await this.#settingsEvent(projectId, { schema: 'coordinator-event-v1', kind: 'settings-changed', by: 'owner', id: `cev_settings_${projectId}_${after.revision}`, at: new Date(this.#timers.now()).toISOString(), instructions: after.instructions, changes: [{ field: 'instructions', from: before.instructions.slice(0, 400), to: after.instructions.slice(0, 400) }] });
    return this.setupView(projectId, id);
  }
  async notebookEditor(projectId: string) { return projectNotebookEditor(projectId, await this.notebookView(projectId)); }
  async notebookCommand(projectId: string, raw: unknown) {
    const command = ProjectNotebookCommandSchema.parse(raw);
    if (command.projectId !== projectId) throw Object.assign(new Error('This notebook command belongs to another project.'), { status: 409, code: 'wrong_resource' });
    try { return projectNotebookEditor(projectId, await this.putNotebook(projectId, command.body)); }
    catch (error) { if (statusOf(error) === 409) throw Object.assign(error as Error, { code: 'conflict' }); throw error; }
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
    const started = await this.threads.start({ projectId, title: input.title, task: input.task, taskContext: input.taskContext, ...(input.fromBranch ? { fromBranch: input.fromBranch } : {}), createdBy: 'owner', clientRequestId: input.clientRequestId, coordinatorDeviceId, note: input.note,
      fixed: { ...(input.isolation ? { isolation: input.isolation } : {}), ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.effort ? { effort: input.effort } : {}),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}), ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.deviceId ? { deviceId: input.deviceId } : {}) } });
    return ThreadCreatedViewSchema.parse({ schema: 'thread-created-view-v1', threadId: started.threadId, state: started.state, placement: started.placement });
  }
  async sessionTranscript(projectId: string, key: string, threadId?: string) {
    const project = await this.#project(projectId);
    if (!/^[a-f0-9]{64}$/u.test(key)) throw Object.assign(new Error('Session history not found.'), { status: 404 });
    if (threadId) this.#thread(projectId, threadId);
    const history = threadId ? this.store.local(threadId).sessionHistory ?? [] : this.coordinators.get(projectId).sessionHistory();
    const previous = history.find(row => row.key === key);
    if (!previous) throw Object.assign(new Error('Session history not found.'), { status: 404 });
    const transcript = await this.transcripts.read({ id: `history_${key}`, title: threadId ? this.store.get(threadId)!.title : `Coordinator: ${project.name}`,
      nativeSessionId: previous.nativeSessionId, placement: { runtime: previous.runtime, accountId: previous.accountId } }, project.name);
    if (!transcript) throw Object.assign(new Error(EARLIER_TRANSCRIPT_UNAVAILABLE), { status: 404 });
    return CursorTranscriptSchema.parse({ ...transcript, turns: transcript.turns.map(turn => ({ ...turn, presentation: transcriptTurnPresentation(turn, { userLabel: TRANSCRIPT_PROMPT, collapseLongUser: HISTORY_PROMPT_COLLAPSE_CHARACTERS }) })) });
  }
  threadView(projectId: string, threadId: string): Promise<ThreadView> { return this.views.thread(projectId, threadId); }
  async threadMessage(projectId: string, threadId: string, input: z.infer<typeof ThreadMessageRequestSchema>): Promise<{ repeated: boolean }> {
    const result = await this.threads.message(projectId, threadId, 'owner', input.text, input.interrupt, input.clientMessageId);
    return { repeated: result.repeated };
  }
  async threadAction(projectId: string, threadId: string, input: import('@jevellan/core').ThreadActionRequest): Promise<ThreadView> {
    await this.threads.action(projectId, threadId, input); await this.threads.refreshIndexes();
    return this.views.thread(projectId, threadId);
  }
  /** Stop from the thread page: `Stopped by you.` unless a reason is given; the coordinator is told (D28). */
  stopThread(projectId: string, threadId: string, input?: z.infer<typeof ThreadStopRequestSchema>): Promise<void> {
    return this.threads.stop(projectId, threadId, input?.reason || STOPPED_BY_YOU, true);
  }
  discardThread(projectId: string, threadId: string): Promise<void> { return this.threads.discard(projectId, threadId); }
  /** A steering line for the coordinator's next turn (bridge): the owner spoke to or took over one of its threads. */
  steeringNote(projectId: string, threadId: string, text: string): Promise<void> {
    return this.#delivery!.toCoordinator(projectId, { schema: 'coordinator-event-v1', kind: 'thread-user-message', id: newId('cev'), at: new Date().toISOString(), threadId, text: `${STEERING_PREFIX}${text}`.slice(0, 20000) });
  }
  #delivery: LocalDelivery | undefined;
  /** Takeover (bridge): interrupt a thread on this device at its next safe point so it rests; false when it was not working. */
  pauseThread(projectId: string, threadId: string): boolean {
    this.#thread(projectId, threadId); const runner = this.threads.runner(threadId);
    if (!runner) throw Object.assign(new Error('This thread runs on another device. Take it over there.'), { status: 409 });
    return runner.pause();
  }
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
  async landingWhy(projectId: string, threadId: string, saved = false) { await this.#project(projectId); return this.landings.whyView(projectId, threadId, saved); }
  async mergeWhy(projectId: string, threadId: string, input: unknown, saved = false) { await this.#project(projectId); return this.mergeGate.whyView(projectId, threadId, input, saved); }
  async landingWhyCorrection(projectId: string, threadId: string, raw: unknown) { await this.landingCorrection(projectId, threadId, raw); return this.landingWhy(projectId, threadId, true); }
  async mergeWhyCorrection(projectId: string, threadId: string, raw: unknown) {
    const input = MergeCorrectionInputSchema.parse(raw); await this.mergeCorrection(projectId, threadId, input);
    return this.mergeWhy(projectId, threadId, { schema: 'project-merge-why-request-v1', commit: input.commit }, true);
  }
  async landingRoute(projectId: string, threadId: string) { await this.#project(projectId); return this.landings.view(projectId, threadId); }
  async landingCorrection(projectId: string, threadId: string, input: unknown) { await this.#project(projectId); return this.landings.correct(projectId, threadId, input); }
  async mergeRoute(projectId: string, threadId: string) { await this.#project(projectId); return this.mergeGate.view(projectId, threadId); }
  async mergeCorrection(projectId: string, threadId: string, input: unknown) { await this.#project(projectId); return this.mergeGate.correct(projectId, threadId, input); }
  async jevDecisionPage(projectId: string, after?: string) { await this.#project(projectId); return this.jevDecisions.page(projectId, after); }
  async jevDecisionRead(projectId: string, id: string) { await this.#project(projectId); const record = this.jevDecisions.read(projectId, id); if (!record) throw refuse('Jev decision inputs not found.', 404); return record; }
  async decisionOwner(projectId: string, decisionId: string) {
    const decision = (await this.#o.hub.decision(decisionId))?.document;
    if (decision?.projectId === projectId && (decision.deploy || decision.intake)) return (await this.#o.hub.coordinator(projectId))?.document.deviceId ?? null;
    return decision?.projectId === projectId && (decision.merge || decision.landing) && decision.threadId ? this.threadOwner(projectId, decision.threadId) : null;
  }
  async refreshPullRequest(projectId: string, threadId: string): Promise<void> { this.#thread(projectId, threadId); await this.tracker.refresh(threadId); }
  async waitingView(projectId: string) { return waitingItemsView(await this.view(projectId)); }
  async respondWaiting(projectId: string, decisionId: string, input: ProjectWaitingRespondRequest) {
    const decision = (await this.#o.hub.decision(decisionId))?.document;
    if (!decision || decision.projectId !== projectId) throw refuse(QUESTION_NOT_FOUND, 404);
    const result = await this.answerDecision(projectId, decisionId, input.answer);
    const after = await this.view(projectId), titles = new Map(after.threads.map(thread => [thread.id, thread.title]));
    const feedback = result.closed === false ? null : { text: sentText(decision, id => titles.get(id)), known: after.decisions.open.map(item => item.id) };
    const page = await this.pageView(projectId, input.view.resolvedDays, { ...input.view, ...(feedback ? { ackKnown: feedback.known } : {}) });
    return ProjectWaitingResponseSchema.parse({ schema: 'project-waiting-response-v1', receipt: { schema: 'decision-answered-view-v1', ...result }, page, feedback });
  }
  answerDecision(projectId: string, decisionId: string, input: z.infer<typeof DecisionAnswerRequestSchema>): Promise<{ repeated: boolean; closed?: boolean }> {
    return this.decisions.answer(projectId, decisionId, input);
  }
  /**
   * Terminal takeover (brief phase 7), for the local control routes only: the answer carries the native session id and the account's
   * credentials, so it never goes through the redactor and never leaves the loopback socket.
   */
  /** The tools a terminal takeover gets (memory, GitHub reads, its terminal): never the thread's report or other turn tools. */
  #attachedScope(project: Project, threadId: string, runtime: 'claude' | 'codex'): BridgeScopeTools {
    const thread = this.store.get(threadId)!; const view = { runtime };
    const allowed = ['memory_search', 'memory_read', ...(project.memory.mode === 'hub' ? ['memory_write', 'memory_edit'] as const : []), 'jevellan_github', 'jevellan_terminal_read'] as const;
    const tools = new ProjectTools({ kind: 'thread', projectId: project.id, threadId, turn: thread.turns, isolation: thread.isolation, memoryMode: project.memory.mode,
      provenance: { source: 'thread', runtime: thread.placement.runtime, model: thread.placement.model, threadId } }, {
      isCurrent: () => this.store.get(threadId)?.state === 'attached',
      memory: scope => this.#o.memory.project(project, this.#o.deviceId, () => { throw new Error(THREAD_MEMORY_READ_ONLY); }, { kind: 'thread', id: threadId, provenance: scope.provenance }),
      call: (scope, name, input, signal) => {
        if (name === 'jevellan_github') return this.#github.read(scope, input, signal);
        if (name === 'jevellan_terminal_read' && this.#o.terminalRead) return this.#o.terminalRead(scope, input);
        throw refuse('This tool is not available during terminal takeover.', 403);
      },
      capture: async (_scope, payload) => {
        const current = this.store.get(threadId); if (current?.state !== 'attached') throw refuse('The terminal takeover has ended.', 401);
        const sessionId = payload?.sessionId ?? current.nativeSessionId;
        const home = this.#o.homes.account(view.runtime, current.placement.accountId);
        const journal = (await listNativeSessions({ runtime: nativeFormat(view.runtime), root: home })).find(row => row.nativeId === sessionId);
        if (!journal || journal.cwd === null || resolvedPath(journal.cwd) !== resolvedPath(current.cwd)) throw refuse('Capture needs this thread’s isolated session.', 403);
        await this.#capture(project, { scope: 'attached', threadId, runtime: view.runtime, model: current.placement.model, accountId: current.placement.accountId, sessionId });
      },
    }, this.#o.redactor);
    const scoped: BridgeScopeTools = { list: () => { tools.list(); return bridgeTools([...allowed]); },
      call: (name, input) => { if (!(allowed as readonly string[]).includes(name)) throw refuse('This tool is not available during terminal takeover.', 403); return tools.call(name, input); },
      capture: payload => tools.capture(payload), close: () => tools.close() };
    return scoped;
  }
  #grantPath(projectId: string, threadId: string): string { return this.#o.homes.at('project-work', projectId, 'attached-grants', `${threadId}.json`); }
  /** A daemon restart keeps a terminal session's tools: each thread still attached here gets its grant back; a handed-back thread's file goes. */
  async #restoreAttachedGrants(): Promise<void> {
    for (const thread of this.store.all()) {
      const path = this.#grantPath(thread.projectId, thread.id); if (!existsSync(path)) continue;
      try {
        const saved = readDocument(path, AttachedGrantSchema);
        if (thread.state !== 'attached' || saved.threadId !== thread.id || this.#attachedGrants.has(thread.id)) { if (thread.state !== 'attached') rmSync(path, { force: true }); continue; }
        const runtime = thread.placement.runtime === 'codex' ? 'codex' : 'claude';
        this.#attachedGrants.set(thread.id, this.#o.bridges.restoreTools(saved.key, this.#attachedScope(await this.#project(thread.projectId), thread.id, runtime)));
      } catch { /* An unreadable grant leaves that session without tools, as before. */ }
    }
  }
  async attach(threadId: string): Promise<ThreadAttachView> {
    await this.ready; const view = await this.#attach.attach(threadId), thread = this.store.get(threadId)!;
    try {
      const project = await this.#project(thread.projectId), settings = await this.admission.settings(project.id);
      const scoped = this.#attachedScope(project, threadId, view.runtime);
      const grant = this.#o.bridges.issueTools(scoped); this.#attachedGrants.set(threadId, grant);
      this.#o.homes.ensure('project-work', project.id, 'attached-grants');
      writeDocument(this.#grantPath(project.id, threadId), AttachedGrantSchema, { schema: 'attached-grant-v1', threadId, key: grant.key });
      const account = await this.#o.accounts.resolve(thread.placement.accountId), models = await this.#o.runtimes.get(view.runtime)?.listModels(account).catch(() => []);
      const contextWindow = models?.find(model => model.id === thread.placement.model)?.contextWindow;
      const roster = await this.#o.roster(), protectedPaths = thread.isolation === 'worktree' ? [...new Set([
        ...(await this.#o.projects.list()).flatMap(row => row.project.paths[this.#o.deviceId] ? [row.project.paths[this.#o.deviceId]!] : []),
        ...(roster.devices.find(row => row.device.id === this.#o.deviceId)?.device.protectedPaths ?? [])])] : [];
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const safetyCommand = [process.execPath, join(applicationRoot(), 'runtimes', 'codex', 'dist', 'safety-hook.js'), stableJson({ cwd: thread.cwd, daemonPid: process.pid, profile: 'thread', protectedPaths, privatePaths: [this.#o.homes.at('project-work', project.id, 'job-cache'), this.#o.homes.at('project-work', project.id, 'job-workspaces')] })].map(quote).join(' ');
      return { ...view, env: minimalEnvironment(view.runtime, account.home, view.runtime === 'claude' ? Object.fromEntries(Object.entries(view.env).filter(([key]) => ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(key))) : {},
        { JEVELLAN_STRETCH_TOKEN: grant.token, JEVELLAN_DAEMON_URL: this.daemonUrl, JEVELLAN_PROJECT_MEMORY_MODE: project.memory.mode }, {}),
        integration: { bridgeCommand: process.execPath, bridgeArgs: [join(applicationRoot(), 'bin', 'jevellan.mjs'), 'mcp-bridge'], safetyCommand,
          compactAtPercent: settings.compactAtPercent, ...(contextWindow ? { contextWindow } : {}) } };
    } catch (error) { await this.#attachedGrants.get(threadId)?.close(); this.#attachedGrants.delete(threadId); rmSync(this.#grantPath(thread.projectId, threadId), { force: true }); await this.#attach.detach(threadId); throw error; }
  }
  /**
   * Detach also frees the thread's account (phase 8): threads waiting for it and coordinators waiting as `Unavailable` are checked now,
   * not at the next sweep.
   */
  async detach(threadId: string): Promise<ThreadDetachView> {
    await this.ready;
    const attached = this.store.get(threadId);
    const capture = async (thread: NonNullable<typeof attached>) => {
      try { await this.#capture(await this.#project(thread.projectId), { scope: 'attached', threadId, runtime: thread.placement.runtime,
        model: thread.placement.model, accountId: thread.placement.accountId, sessionId: thread.nativeSessionId }); }
      catch (error) {
        // Capture advances its cursor only after acknowledgement. An outage must not strand the owner in takeover.
        try { this.ledgers.thread(thread.projectId, threadId).append({ type: 'notice', data: { schema: 'project-notice-v1', kind: 'error',
          text: this.#o.redactor.text(`Terminal memory capture could not finish; its journal remains available to retry. ${error instanceof Error ? error.message : 'Capture failed.'}`).slice(0, 1000) } }); }
        catch { /* Handback must still release the attachment if its ledger is unavailable. */ }
      }
    };
    if (attached?.state === 'attached') await capture(attached);
    await this.#attachedGrants.get(threadId)?.close(); this.#attachedGrants.delete(threadId);
    const detaching = this.store.get(threadId); if (detaching) rmSync(this.#grantPath(detaching.projectId, threadId), { force: true });
    const detached = await this.#attach.detach(threadId);
    const adopted = this.store.get(threadId);
    if (detached.adopted && adopted?.nativeSessionId !== attached?.nativeSessionId && adopted) await capture(adopted);
    const projectId = this.store.get(threadId)?.projectId;
    if (projectId) this.threads.freed(projectId);
    this.coordinators.sweep();
    return detached;
  }
}
