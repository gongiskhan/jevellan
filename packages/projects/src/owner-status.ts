import { ownerLocal, type CoordinatorView, type GoalLine, type ProjectDecision, type ProjectDeploy, type ProjectDaily, type ProjectGoal, type ProjectJob, type ProjectJobRun, type ProjectStatusView,
  type ProjectWindow, type ProjectWorkSettings, type ProjectWorkTask, type RunView, type ThreadIndex, type WaitingItemView, type WaitingKind } from '@jevellan/core';
import type { OwnerShortIds } from './owner-ids.js';

/** What a thread is to the owner (bridge specification, run view states); `null` hides it from status. */
export function threadRunState(thread: Pick<ThreadIndex, 'state' | 'landing' | 'landingStage' | 'resolution' | 'delivery' | 'pr'>, deployed: boolean): RunView['state'] {
  if (thread.state === 'attached') return 'held';
  if (thread.state === 'waiting-for-you') return 'waiting';
  if (thread.state === 'publishing' || thread.landingStage) return 'landing';
  if (thread.state === 'queued') return 'queued';
  if (thread.state === 'preparing' || thread.state === 'running') return 'running';
  if (thread.state === 'in-review') return 'waiting';
  if (thread.state === 'failed') return 'failed';
  if (thread.state === 'stopped') return thread.resolution?.by === 'owner' ? 'cancelled' : 'stopped';
  if (thread.state === 'done') return thread.resolution?.by === 'deploy' || deployed ? 'deployed' : thread.landing || thread.pr?.state === 'merged' ? 'landed' : 'idle';
  return 'idle';
}

/** The waiting-item kind of a decision item, from the fields the engine already sets on it. */
export function waitingKind(decision: Pick<ProjectDecision, 'deploy' | 'accountId' | 'options' | 'question'>): WaitingKind {
  if (decision.deploy) return decision.deploy.action === 'retry' ? 'deploy_failed' : decision.deploy.action === 'rollback' ? 'rollback_question' : 'deploy';
  if (decision.accountId) return 'login';
  return decision.options.length ? 'decision' : 'question';
}

export type StatusInput = {
  project: { id: string; name: string }; now: Date; settings: ProjectWorkSettings; coordinator: CoordinatorView; coordinatorStalled: boolean;
  threads: readonly ThreadIndex[]; tasks: readonly ProjectWorkTask[]; goals: readonly ProjectGoal[]; decisions: readonly ProjectDecision[];
  jobs: readonly ProjectJob[]; dailies: readonly ProjectDaily[]; runs: readonly ProjectJobRun[]; windows: readonly ProjectWindow[]; deploys: readonly ProjectDeploy[];
  budgets: ProjectStatusView['budgets']; deviceName: (deviceId: string) => string; deployPaused: boolean;
  /** Owner holds from takeover (phase 5); empty until then. */
  holds?: ReadonlyMap<string, NonNullable<RunView['held']>>;
  goalFilter?: string;
};

const TWELVE_HOURS = 12 * 3600_000;
const byCreated = <T extends { createdAt: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * The status of a project (bridge specification, `status`): what waits on the owner, what runs, lands, is queued or finished recently,
 * plus goals, budgets, deploy, the night and quiet hours. Order is fixed here so every client shows the same thing.
 */
export function projectStatus(input: StatusInput, ids: OwnerShortIds): ProjectStatusView {
  const { project, now, settings } = input; const projectId = project.id; const timeZone = settings.nightlyWindow.timezone;
  const goalIds = ids.assign(projectId, 'G', byCreated(input.goals).map(goal => goal.id));
  const taskIds = ids.assign(projectId, 'T', byCreated(input.tasks).map(task => task.id));
  const taskByThread = new Map(input.tasks.flatMap(task => task.threadId ? [[task.threadId, task] as const] : []));
  const threadIds = ids.assign(projectId, 'T', byCreated(input.threads.filter(thread => !taskByThread.has(thread.id))).map(thread => thread.id));
  const threadShort = (thread: ThreadIndex) => { const task = taskByThread.get(thread.id); return task ? taskIds.get(task.id)! : threadIds.get(thread.id)!; };
  const runIds = ids.assign(projectId, 'J', [...input.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(run => run.id));
  const open = input.decisions.filter(decision => !decision.answeredAt && !decision.withdrawnAt);
  const waitingIds = ids.assign(projectId, 'W', byCreated(open).map(decision => decision.id));
  const goalById = new Map(input.goals.map(goal => [goal.id, goal]));
  const jobById = new Map(input.jobs.map(job => [job.id, job]));
  const dailyByJob = new Map(input.dailies.flatMap(daily => daily.target.kind === 'job' ? [[daily.target.jobId, daily] as const] : []));
  const deployedThreads = new Set(input.deploys.filter(deploy => deploy.state === 'deployed').flatMap(deploy => deploy.threads.map(row => row.threadId)));
  const pendingDeploy = [...input.deploys].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find(deploy => deploy.state === 'open' || deploy.state === 'approved' || deploy.state === 'running');
  const undeployed = new Set(pendingDeploy?.threads.map(row => row.threadId) ?? []);

  const labelOfTask = (task: ProjectWorkTask | undefined): RunView['label'] => {
    if (task?.goalId && goalById.has(task.goalId)) return { type: 'goal', name: goalById.get(task.goalId)!.name, goalId: task.goalId };
    if (task?.jobId && jobById.has(task.jobId)) return { type: 'job', name: jobById.get(task.jobId)!.name };
    if (task?.dailyId) { const daily = input.dailies.find(row => row.id === task.dailyId); if (daily) return { type: 'job', name: daily.name }; }
    return { type: 'manual', name: 'manual' };
  };
  const waitingFor = new Map(open.flatMap(decision => decision.threadId ? [[decision.threadId, waitingIds.get(decision.id)!] as const] : []));

  const threadRuns: RunView[] = input.threads.map(thread => {
    const task = taskByThread.get(thread.id); const held = input.holds?.get(thread.id);
    const state = held ? 'held' : threadRunState(thread, deployedThreads.has(thread.id) && !undeployed.has(thread.id));
    const usage = thread.usage ? { inputTokens: thread.usage.inputTokens, outputTokens: thread.usage.outputTokens, cacheReadTokens: thread.usage.cacheReadTokens, costUsdEstimate: thread.usage.costUnknownTurns ? null : thread.usage.costUsd } : undefined;
    const landing = thread.landing ? { commit: thread.landing.commit.slice(0, 7), at: thread.landing.at, method: thread.landing.method } : undefined;
    const detail = state === 'landing' ? thread.stateReason ?? (thread.landingStage ? `landing, ${thread.landingStage}` : 'landing') : state === 'failed' || state === 'stopped' ? thread.stateReason : undefined;
    return { schema: 'run-view-v1', id: threadShort(thread), internalId: thread.id, kind: 'thread', label: labelOfTask(task), title: thread.title, state,
      ...(detail ? { detail: detail.slice(0, 400) } : {}),
      runtime: thread.runtime, model: thread.modelLabel, effort: thread.effort, account: thread.accountLabel, device: input.deviceName(thread.ownerDeviceId),
      startedAt: thread.createdAt, ...(thread.endedAt ? { endedAt: thread.endedAt } : {}), ...(usage ? { usage } : {}),
      ...(waitingFor.has(thread.id) ? { waitingItem: waitingFor.get(thread.id)! } : {}), ...(held ? { held } : {}), ...(landing ? { landing } : {}) } satisfies RunView;
  });
  const jobRuns: RunView[] = input.runs.map(run => {
    const job = jobById.get(run.jobId); const daily = dailyByJob.get(run.jobId);
    const state: RunView['state'] = run.conclusion === null ? 'running' : run.conclusion === 'passed' ? 'idle' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed';
    const name = daily?.name ?? job?.name ?? 'job';
    return { schema: 'run-view-v1', id: runIds.get(run.id)!, internalId: run.id, kind: 'job', label: { type: 'job', name }, title: name, state,
      ...(run.summary ? { detail: run.summary.slice(0, 400) } : {}), ...(run.conclusion ? { detail: `${run.conclusion}${run.summary ? `: ${run.summary.split('\n')[0]!.slice(0, 300)}` : ''}` } : {}),
      runtime: null, model: null, effort: null, account: null, device: input.deviceName(run.deviceId), startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}) } satisfies RunView;
  });
  const queuedTasks = input.tasks.filter(task => task.state === 'queued' && !task.threadId).sort((a, b) => Number(b.now) - Number(a.now) || a.rank.localeCompare(b.rank));
  const queued: RunView[] = queuedTasks.map((task, index) => ({ schema: 'run-view-v1', id: taskIds.get(task.id)!, internalId: task.id, kind: 'thread', label: labelOfTask(task), title: task.title, state: 'queued',
    ...(task.held ? { detail: 'held until you start it' } : {}), runtime: null, model: null, effort: null, account: null, device: null, startedAt: null, position: index + 1, priority: task.now ? 'urgent' : 'normal' }));

  const proposed = input.tasks.filter(task => task.state === 'draft');
  const proposedIds = ids.assign(projectId, 'W', byCreated(proposed).map(task => `draft-${task.id}`.slice(0, 128)));
  const waiting: WaitingItemView[] = [
    ...byCreated(open).map(decision => ({ schema: 'waiting-item-view-v1' as const, id: waitingIds.get(decision.id)!, internalId: decision.id, kind: waitingKind(decision),
      from: decision.from === 'coordinator' ? 'C' : decision.threadId ? (threadRuns.find(run => run.internalId === decision.threadId)?.id ?? 'C') : 'C',
      text: decision.question, options: decision.options.map(option => option.label), freeText: decision.options.length === 0, urgent: decision.urgent === true,
      createdAt: decision.createdAt, updatedAt: decision.answeredAt ?? decision.createdAt, state: 'open' as const })),
    ...byCreated(proposed).map(task => ({ schema: 'waiting-item-view-v1' as const, id: proposedIds.get(`draft-${task.id}`.slice(0, 128))!, internalId: task.id, kind: 'other' as const, from: 'C',
      text: `Proposed task ${taskIds.get(task.id)} "${task.title}" waits for your start.`, options: ['Start', 'Reject'], freeText: false, urgent: false, createdAt: task.createdAt, updatedAt: task.updatedAt, state: 'open' as const })),
  ];

  const recent = (run: RunView) => run.endedAt !== undefined && now.getTime() - new Date(run.endedAt).getTime() <= TWELVE_HOURS;
  const order: Record<RunView['state'], number> = { waiting: 0, held: 1, running: 2, landing: 3, queued: 4, landed: 5, deployed: 6, failed: 7, stopped: 8, cancelled: 9, idle: 10 };
  const all = [...threadRuns, ...jobRuns];
  const running = all.filter(run => ['held', 'running', 'landing'].includes(run.state)).sort((a, b) => order[a.state] - order[b.state] || (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const threadQueued = threadRuns.filter(run => run.state === 'queued');
  const landed = threadRuns.filter(run => run.state === 'landed').sort((a, b) => (b.landing?.at ?? '').localeCompare(a.landing?.at ?? ''));
  const finished = all.filter(run => ['deployed', 'failed', 'stopped', 'cancelled', 'idle'].includes(run.state) && recent(run)).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));

  const today = ownerLocal(now, timeZone).day;
  const goals: GoalLine[] = byCreated(input.goals).filter(goal => goal.state !== 'done').map(goal => {
    const mine = (run: RunView) => run.label.goalId === goal.id;
    const goalDailies = input.dailies.filter(daily => daily.goalId === goal.id && daily.enabled);
    const lastWindow = [...input.windows].sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
    const due: GoalLine['due'] = [];
    if (lastWindow?.state === 'finished') for (const daily of goalDailies) {
      const ranInWindow = input.tasks.some(task => task.dailyId === daily.id && task.nightlyWindowId === lastWindow.id) || input.runs.some(run => dailyByJob.get(run.jobId)?.id === daily.id && run.startedAt >= lastWindow.openedAt);
      if (!ranInWindow) due.push({ type: 'daily_item', ref: daily.id, text: `${daily.name} (not run last night)` });
    }
    const counts = { running: running.filter(mine).length, queued: [...queued, ...threadQueued].filter(mine).length, waiting: threadRuns.filter(run => mine(run) && run.state === 'waiting').length,
      landedToday: threadRuns.filter(run => mine(run) && run.landing && ownerLocal(run.landing.at, timeZone).day === today).length };
    if (goal.state === 'active' && counts.running + counts.queued === 0) due.push({ type: 'idle_goal', ref: goal.id, text: 'nothing queued or running' });
    return { id: goalIds.get(goal.id)!, internalId: goal.id, title: goal.name, state: goal.state, counts, due };
  });

  const coordinatorState = input.coordinatorStalled ? 'stalled' : input.coordinator.state === 'running' ? 'running' : input.coordinator.state === 'unavailable' ? 'crashed'
    : input.coordinator.state === 'none' ? 'starting' : 'idle';
  const session = input.coordinator.session ?? input.coordinator.planned;
  const deployLine = settings.deploy.jobId || input.deploys.length ? {
    mode: settings.deploy.mode, paused: input.deployPaused, undeployed: pendingDeploy?.threads.length ?? 0,
    ...(pendingDeploy && open.some(decision => decision.deploy?.deployId === pendingDeploy.id) ? { message: waitingIds.get(open.find(decision => decision.deploy?.deployId === pendingDeploy.id)!.id)! } : {}),
  } : null;
  const nightly = settings.nightlyWindow;
  const quiet = settings.notifications.quietHours;
  let filtered: ProjectStatusView['goalFilter'];
  const view: ProjectStatusView = { schema: 'project-status-view-v1', projectId, project: project.name, at: now.toISOString(), timeZone,
    coordinator: { state: coordinatorState, model: session?.modelLabel ?? null, effort: session?.effort ?? null, account: input.coordinator.session?.accountLabel ?? null },
    budgets: input.budgets, deploy: deployLine,
    night: nightly.enabled ? `next at ${nightly.time}` : null,
    quietHours: quiet.enabled ? { enabled: true, start: quiet.start, end: quiet.end } : null,
    goals, waiting, running, queued: [...threadQueued, ...queued], landed, finished };
  if (input.goalFilter) {
    const wanted = input.goalFilter.trim().toLowerCase();
    const goal = goals.find(line => line.id.toLowerCase() === wanted || line.internalId === input.goalFilter || line.title.toLowerCase() === wanted)
      ?? goals.find(line => line.title.toLowerCase().includes(wanted));
    if (!goal) throw Object.assign(new Error(`No goal matches "${input.goalFilter}". Goals: ${goals.map(line => `${line.id} ${line.title}`).join(', ') || 'none'}.`), { status: 404, code: 'goal_not_found' });
    filtered = { id: goal.id, title: goal.title, state: goal.state };
    const mine = (run: RunView) => run.label.goalId === goal.internalId;
    const goalThreads = new Set(threadRuns.filter(mine).map(run => run.internalId));
    return { ...view, goalFilter: filtered, goals: [goal], deploy: null, night: null, quietHours: null,
      waiting: view.waiting.filter(item => open.some(decision => decision.id === item.internalId && decision.threadId && goalThreads.has(decision.threadId))),
      running: view.running.filter(mine), queued: view.queued.filter(mine), landed: view.landed.filter(mine), finished: view.finished.filter(mine) };
  }
  return view;
}
