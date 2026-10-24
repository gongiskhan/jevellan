import { createHash } from 'node:crypto';
import { DailyCreateRequestSchema, DailyUpdateRequestSchema, JobCreateRequestSchema, JobUpdateRequestSchema, ProjectDailyListViewSchema, ProjectDailySchema, ProjectJobSchema, ProjectRunRequestSchema,
  ReviewFollowupInputSchema, ProjectWindowSchema, ProjectWorkTaskSchema, stableJson, type CoordinatorEvent, type ProjectDaily, type ProjectHub, type ProjectJob, type ProjectWindow, type ProjectWorkSettings, type ProjectWorkTask, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import type { ProjectJobRunner } from './job-runner.js';
import { projectBoundary, projectDay, shiftProjectDate } from './project-day.js';
import { taskRankBetween, type ProjectTasks } from './tasks.js';
import { PROJECT_PAUSED } from './copy.js';
import { DailyEnabledRequestSchema, JobPausedRequestSchema } from '@jevellan/core';
import { jobRunRefusal } from './jobs-view.js';
const refuse = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
export const dailyDueOn = (daily: Pick<ProjectDaily, 'days'>, date: string): boolean => !daily.days || daily.days.includes((['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date(date + 'T12:00:00Z').getUTCDay()]!);
export const NIGHTLY_MERGE_HOLD = 'Merges are held while the nightly window runs.';
const ended = (task: ProjectWorkTask) => ['done', 'failed', 'cancelled', 'in-review'].includes(task.state);
export class ProjectDailyWork {
  constructor(readonly o: { hub: ProjectHub; tasks: ProjectTasks; runner: ProjectJobRunner; redactor: SecretRedactor; now(): number; deviceId: string; fixCutoffMinutes?: number;
    settings(projectId: string): Promise<ProjectWorkSettings>; validateGoal(projectId: string, goalId: string | null): Promise<void>;
    event(projectId: string, event: CoordinatorEvent): Promise<void>; changed(): void;
    memoryDream?(projectId: string, requestId: string): Promise<{ schema: 'memory-dream-run-receipt-v1'; id: string; accepted: true }>;
    landing?(threadId: string, held: boolean): void;
    memoryDreamLine?(projectId: string): string | undefined;
    /** Missed nights (bridge): a window opened late enough is skipped and recorded as missed instead; earlier late opens are catch-ups. */
    nightGuard?(projectId: string, date: string, latenessMs: number, items: readonly string[]): Promise<{ open: true } | { open: false; outcome: string }> }) {}
  async jobs(projectId: string): Promise<ProjectJob[]> {
    const rows: ProjectJob[] = []; let after: string | undefined;
    do { const page = await this.o.hub.jobs(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after); return rows;
  }
  async dailies(projectId: string): Promise<ProjectDaily[]> {
    const rows: ProjectDaily[] = []; let after: string | undefined;
    do { const page = await this.o.hub.dailies(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async windows(projectId: string): Promise<ProjectWindow[]> {
    const rows: ProjectWindow[] = []; let after: string | undefined;
    do { const page = await this.o.hub.windows(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }
  async window(projectId: string): Promise<ProjectWindow | null> { return (await this.windows(projectId)).find(row => row.state === 'open') ?? null; }
  async memoryFinished(projectId: string, windowId: string, line: string, failed: boolean): Promise<void> {
    await this.o.tasks.exclusive(projectId, async () => {
      const window = (await this.o.hub.window(windowId))?.document;
      if (!window || window.projectId !== projectId) return;
      const before = (window.outcome ?? '').replace(/(?:\n\n)?Memory dream:[\s\S]*$/u, '');
      const outcome = `${before.slice(0, Math.max(0, 7998 - line.length))}${before ? '\n\n' : ''}${line.slice(0, 8000)}`;
      if (outcome === window.outcome && (!failed || window.failed)) return;
      const saved = (await this.o.hub.putWindow({ ...window, outcome, memoryDreamPending: false, failed: failed || window.failed }, window.revision)).document;
      if (saved.state === 'finished') await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', windowId, 'memory', outcome), at: this.o.tasks.at(), outcome });
      this.o.changed();
    });
  }
  async mergesHeld(projectId: string): Promise<boolean> {
    const window = await this.window(projectId); if (window) return window.mergesHeld && this.o.now() < Date.parse(window.openedAt) + 7 * 3_600_000;
    // Fence merges at the configured time even while the coordinator is creating its durable window.
    const settings = await this.o.settings(projectId); if (settings.status !== 'active' || !settings.nightlyWindow.enabled) return false;
    const date = await this.day(projectId), boundary = await this.dayStart(projectId, date);
    return this.o.now() >= boundary && !(await this.o.hub.window(derivedId('window', projectId, date))) && (await this.dailies(projectId)).some(row => row.enabled && Date.parse(row.enabledSince ?? row.createdAt) <= boundary);
  }
  async allowedMergeThreads(_projectId: string, _tasks?: readonly ProjectWorkTask[]): Promise<string[]> { void _projectId; void _tasks; return []; }
  async assertMerge(projectId: string, threadId?: string): Promise<void> {
    const held = await this.mergesHeld(projectId) && (!threadId || !(await this.allowedMergeThreads(projectId)).includes(threadId));
    if (threadId) this.o.landing?.(threadId, held);
    if (held) refuse(NIGHTLY_MERGE_HOLD);
  }
  async #next(window: ProjectWindow, tasks: readonly ProjectWorkTask[]): Promise<string | undefined> {
    if (window.memoryDreamPending) return 'memory-dream';
    for (const plan of window.plans) {
      const task = tasks.find(row => row.id === plan.id); if (!task || !ended(task)) return plan.id;
    }
    return undefined;
  }
  async followup(projectId: string, raw: unknown) {
    const input = ReviewFollowupInputSchema.parse(raw);
    return this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId);
      const review = await this.o.tasks.read(projectId, input.reviewTaskId), run = review.reviewRun;
      if (!review.nightlyReview || !run || run.state !== 'completed') return refuse('Choose a follow-up only for a completed nightly review.');
      if (run.followupChosen) return { schema: 'review-followup-receipt-v1' as const, taskId: run.fixTaskId, repeated: true };
      let fixTaskId: string | null = null;
      if (input.task) {
        const goal = review.goalId ? (await this.o.hub.goal(review.goalId))?.document : null;
        if (!['Resilience', 'Hardening through code review'].includes(goal?.name ?? '')) return refuse('The review fix needs the Resilience goal.');
        fixTaskId = derivedId('task', 'review-fix', review.id);
        if (!(await this.o.hub.task(fixTaskId))) await this.o.tasks.save(ProjectWorkTaskSchema.parse(this.o.redactor.document({ schema: 'project-work-task-v1', id: fixTaskId, projectId, revision: 0,
          ...input.task, kind: 'session', type: 'finding', goalId: review.goalId, source: 'finding', state: 'queued', rank: taskRankBetween(null, (await this.o.tasks.list(projectId)).map(row => row.rank).sort()[0] ?? null), ownerRanked: false, now: true,
          after: [], needs: [], dailyId: null, jobId: null, threadId: null, jobRunId: null, fixed: { isolation: 'worktree' }, nightlyFixFor: review.id,
           projectDay: review.projectDay, createdAt: this.o.tasks.at(), updatedAt: this.o.tasks.at() })));
      }
      await this.o.tasks.save({ ...review, reviewRun: { ...run, followupChosen: true, fixTaskId } }); this.o.changed();
      return { schema: 'review-followup-receipt-v1' as const, taskId: fixTaskId, repeated: false };
    });
  }
  async day(projectId: string): Promise<string> { const s = await this.o.settings(projectId); return projectDay(this.o.now(), s.nightlyWindow.enabled ? s.nightlyWindow.time : '00:00', s.nightlyWindow.timezone); }
  async dayStart(projectId: string, day: string): Promise<number> { const s = await this.o.settings(projectId); return projectBoundary(day, s.nightlyWindow.enabled ? s.nightlyWindow.time : '00:00', s.nightlyWindow.timezone); }
  async view(projectId: string) {
    const [projectDay, dailies, jobs, runs, tasks, windows] = await Promise.all([this.day(projectId), this.dailies(projectId), this.jobs(projectId), this.o.runner.runs(projectId), this.o.tasks.list(projectId), this.windows(projectId)]);
    const window = windows.find(row => row.state === 'open') ?? windows[0] ?? null;
    const lastTask = tasks.filter(row => row.reviewRun?.state === 'completed').sort((a, b) => b.reviewRun!.sequence - a.reviewRun!.sequence || b.reviewRun!.completedAt!.localeCompare(a.reviewRun!.completedAt!))[0], lastRun = lastTask?.reviewRun;
    const lastReview = lastRun?.report ?? null, definition = dailies.find(daily => daily.target.kind === 'review-since-last'), baseline = definition?.target;
    const fromCommit = baseline?.kind === 'review-since-last' ? baseline.reviewFromCommit : undefined;
    return ProjectDailyListViewSchema.parse({ schema: 'project-daily-list-view-v1', projectId, projectDay, dailies, jobs, runs, tasks, window, lastReview, lastReviewedCommit: lastRun && lastTask?.dailyId === definition?.id && (lastRun.reviewFromVersion ?? 0) === definition?.reviewFromVersion ? lastRun.commit : fromCommit ?? lastReview?.commit ?? null, mergeAllowedThreads: await this.allowedMergeThreads(projectId, tasks),
      mergesHeld: await this.mergesHeld(projectId) });
  }
  /** Historical vault definitions remain readable; retired work is imported disabled and can never execute. */
  async restoreRetiredJob(projectId: string, raw: unknown): Promise<ProjectJob> {
    const input = JobCreateRequestSchema.parse(raw);
    if (input.run.kind !== 'github-workflow') throw new Error('Only a retired job uses historical restore.');
    const id = derivedId('pjob', projectId, input.clientRequestId), previous = (await this.o.hub.job(id))?.document;
    if (previous) return previous;
    const { schema: _schema, clientRequestId: _id, ...fields } = input; void _schema; void _id;
    await this.o.validateGoal(projectId, input.goalId);
    const at = this.o.tasks.at();
    return (await this.o.hub.putJob(ProjectJobSchema.parse({ ...fields, schema: 'project-job-v1', id, projectId, revision: 0, enabled: false, gate: null, createdAt: at, updatedAt: at }), 0)).document;
  }
  async createJob(projectId: string, raw: unknown): Promise<ProjectJob> {
    const input = JobCreateRequestSchema.parse(raw);
    if (input.run.kind === 'github-workflow') return refuse('GitHub workflow jobs retired on 19 October. Use a command job.', 400);
    const id = derivedId('pjob', projectId, input.clientRequestId), requestDigest = createHash('sha256').update(stableJson(input)).digest('hex');
    const current = (await this.o.hub.job(id))?.document; if (current) { if (current.projectId !== projectId || current.requestDigest !== requestDigest) return refuse('This request ID already created a different job.'); return current; }
    await this.o.validateGoal(projectId, input.goalId); await this.#gate(projectId, id, input.gate?.jobId);
    const { schema: _schema, clientRequestId: _request, ...fields } = input; void _schema; void _request;
    const at = this.o.tasks.at(), job = (await this.o.hub.putJob(ProjectJobSchema.parse(this.o.redactor.document({ ...fields, schema: 'project-job-v1', id, projectId, revision: 0, requestDigest, createdAt: at, updatedAt: at })), 0)).document; this.o.changed(); return job;
  }
  async updateJob(projectId: string, id: string, raw: unknown): Promise<ProjectJob> {
    const input = JobUpdateRequestSchema.parse(raw), current = (await this.o.hub.job(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Job not found.', 404);
    if (input.run.kind === 'github-workflow' && (input.enabled || current.run.kind !== 'github-workflow')) return refuse('GitHub workflow jobs retired on 19 October. Use a command job.', 400);
    await this.o.validateGoal(projectId, input.goalId); await this.#gate(projectId, id, input.gate?.jobId);
    const { schema: _schema, expectedRevision, ...fields } = input; void _schema;
    const job = (await this.o.hub.putJob(ProjectJobSchema.parse(this.o.redactor.document({ ...current, ...fields, updatedAt: this.o.tasks.at() })), expectedRevision)).document; this.o.changed(); return job;
  }
  async setPaused(projectId: string, id: string, raw: unknown): Promise<ProjectJob> {
    const input = JobPausedRequestSchema.parse(raw), current = (await this.o.hub.job(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Job not found.', 404);
    return this.updateJob(projectId, id, { schema: 'job-update-request-v1', expectedRevision: input.expectedRevision,
      name: current.name, goalId: current.goalId, run: current.run, gate: current.gate, enabled: current.enabled, interval: current.interval, paused: input.paused,
      pauseReason: input.paused ? input.pauseReason ?? current.pauseReason ?? null : null });
  }
  async #gate(projectId: string, id: string, parent?: string): Promise<void> {
    const visited = new Set([id]);
    while (parent) { if (visited.has(parent)) return refuse('Job gates cannot contain a cycle.', 400); visited.add(parent);
      const job = (await this.o.hub.job(parent))?.document; if (!job || job.projectId !== projectId) return refuse('A gate must be a job of this project.', 400); parent = job.gate?.jobId; }
  }
  validateEditorGate(projectId: string, id: string, parent: string): Promise<void> { return this.#gate(projectId, id, parent); }
  async validateEditorGoal(projectId: string, goalId: string, review: boolean): Promise<void> {
    if (review) await this.#dailyTarget(projectId, { goalId, target: { kind: 'review-since-last' } });
    else await this.o.validateGoal(projectId, goalId);
  }
  async createDaily(projectId: string, raw: unknown): Promise<ProjectDaily> {
    const input = DailyCreateRequestSchema.parse(raw), id = derivedId('daily', projectId, input.clientRequestId), requestDigest = createHash('sha256').update(stableJson(input)).digest('hex');
    const current = (await this.o.hub.daily(id))?.document; if (current) { if (current.projectId !== projectId || current.requestDigest !== requestDigest) return refuse('This request ID already created a different daily item.'); return current; }
    if ((await this.dailies(projectId)).length >= 50) return refuse('A project supports at most fifty daily items.');
    await this.#dailyTarget(projectId, input); const { schema: _schema, clientRequestId: _request, ...fields } = input; void _schema; void _request;
    const baseline = await this.#reviewBaseline(projectId, fields), at = this.o.tasks.at(), daily = (await this.o.hub.putDaily(ProjectDailySchema.parse(this.o.redactor.document({ ...fields, ...baseline, schema: 'project-daily-v1', id, projectId, revision: 0, requestDigest, createdAt: at, updatedAt: at, enabledSince: at })), 0)).document; this.o.changed(); return daily;
  }
  async updateDaily(projectId: string, id: string, raw: unknown): Promise<ProjectDaily> {
    const input = DailyUpdateRequestSchema.parse(raw), current = (await this.o.hub.daily(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Daily item not found.', 404);
    await this.#dailyTarget(projectId, input); const { schema: _schema, expectedRevision, ...fields } = input; void _schema;
    const baseline = await this.#reviewBaseline(projectId, fields, current);
    const daily = (await this.o.hub.putDaily(ProjectDailySchema.parse(this.o.redactor.document({ ...current, ...fields, days: fields.days, ...baseline, ...(!current.enabled && fields.enabled ? { enabledSince: this.o.tasks.at() } : {}), updatedAt: this.o.tasks.at() })), expectedRevision)).document; this.o.changed(); return daily;
  }
  async setEnabled(projectId: string, id: string, raw: unknown): Promise<ProjectDaily> {
    const input = DailyEnabledRequestSchema.parse(raw), current = (await this.o.hub.daily(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Daily item not found.', 404);
    return this.updateDaily(projectId, id, { schema: 'daily-update-request-v1', expectedRevision: input.expectedRevision,
      name: current.name, goalId: current.goalId, target: current.target, order: current.order, days: current.days, enabled: input.enabled,
      pauseReason: input.enabled ? null : input.pauseReason ?? current.pauseReason ?? null });
  }
  async #reviewBaseline(projectId: string, input: Pick<ProjectDaily, 'target' | 'enabled'>, current?: ProjectDaily) {
    if (input.target.kind !== 'review-since-last') return {};
    const before = current?.target.kind === 'review-since-last' ? current.target.reviewFromCommit : undefined;
    const firstEnable = current && !current.enabled && input.enabled && !(await this.o.tasks.list(projectId)).some(task => task.dailyId === current.id && task.reviewRun?.state === 'completed');
    const reviewFromOwner = !!input.target.reviewFromCommit && (current?.reviewFromOwner === true || input.target.reviewFromCommit !== before);
    const commit = firstEnable && !reviewFromOwner || !input.target.reviewFromCommit ? await this.o.runner.mainHead(projectId) : input.target.reviewFromCommit;
    return { target: { ...input.target, reviewFromCommit: commit }, reviewFromOwner, reviewFromVersion: (current?.reviewFromVersion ?? 0) + Number(commit !== before) };
  }
  async #dailyTarget(projectId: string, daily: Pick<ProjectDaily, 'goalId' | 'target'>): Promise<void> {
    await this.o.validateGoal(projectId, daily.goalId);
    if (daily.target.kind === 'review-since-last' && daily.goalId && !['Resilience', 'Hardening through code review'].includes((await this.o.hub.goal(daily.goalId))?.document.name ?? '')) return refuse('Review since last uses the Resilience goal.', 400);
    if (daily.target.kind === 'job' && (await this.o.hub.job(daily.target.jobId))?.document.run.kind === 'github-workflow') return refuse('GitHub workflow jobs retired on 19 October. Use a command job.', 400);
    if (daily.target.kind === 'job' && (await this.o.hub.job(daily.target.jobId))?.document.projectId !== projectId) return refuse('A daily job must belong to this project.', 400);
  }
  async #plan(projectId: string, id: string, day: string, daily: ProjectDaily | null, job: ProjectJob | null, rank: string): Promise<ProjectWorkTask> {
    const target = daily?.target, at = this.o.tasks.at(), review = target?.kind === 'review-since-last', session = target?.kind === 'session' ? target : null;
    return ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id, projectId, revision: 0, title: session?.title ?? daily?.name ?? job!.name,
      brief: session?.brief ?? (review ? 'Review every commit reaching main since the last completed review, including direct pushes.' : `Run the configured job "${job!.name}" and record its result.`), ...(review ? { nightlyReview: true } : {}), kind: session || review ? 'session' : 'job', type: session?.type ?? (review ? 'review' : 'ops'), goalId: daily?.goalId ?? job?.goalId ?? null,
      source: daily ? 'daily' : 'owner', state: 'queued', rank, ownerRanked: false, now: false, after: [], needs: [], dailyId: daily?.id ?? null,
      jobId: target?.kind === 'job' ? target.jobId : job?.id ?? null, threadId: null, jobRunId: null, fixed: {}, projectDay: day, createdAt: at, updatedAt: at });
  }
  async runDaily(projectId: string, id: string, raw: unknown) {
    const { clientRequestId } = ProjectRunRequestSchema.parse(raw);
    const definition = (await this.o.hub.daily(id))?.document;
    if (definition?.projectId === projectId && definition.target.kind === 'memory-dream') {
      if ((await this.o.settings(projectId)).status !== 'active') return refuse(PROJECT_PAUSED);
      if (!definition.enabled || !this.o.memoryDream) throw new Error('This memory dream is unavailable or disabled.');
      return this.o.memoryDream(projectId, clientRequestId);
    }
    return this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId); const taskId = derivedId('task', 'daily-now', projectId, id, clientRequestId), existing = (await this.o.hub.task(taskId))?.document;
      if (existing) return { schema: 'task-receipt-v1' as const, taskId, state: existing.state, repeated: true };
      const daily = (await this.o.hub.daily(id))?.document; if (!daily || daily.projectId !== projectId || !daily.enabled) return refuse('This daily item is unavailable or disabled.');
      const tasks = await this.o.tasks.list(projectId), pending = tasks.find(task => task.dailyId === id && ['queued', 'active'].includes(task.state));
      if (pending) return { schema: 'task-receipt-v1' as const, taskId: pending.id, state: pending.state, repeated: true };
      const settings = await this.o.settings(projectId); if (settings.status !== 'active') return refuse(PROJECT_PAUSED);
      if (daily.target.kind === 'job') await this.#ordinaryJob(projectId, daily.target.jobId);
      const job = daily.target.kind === 'job' ? (await this.o.hub.job(daily.target.jobId))?.document ?? null : null;
      if (daily.target.kind === 'job' && !job?.enabled) return refuse('This job is unavailable or disabled.');
      if (job) { const refusal = jobRunRefusal(settings, job); if (refusal) return refuse(refusal); }
      const rank = taskRankBetween(tasks.filter(task => ['draft', 'queued', 'active'].includes(task.state)).map(task => task.rank).sort().at(-1) ?? null, null);
      const task = await this.o.tasks.save(await this.#plan(projectId, taskId, await this.day(projectId), daily, job, rank)); this.o.changed();
      return { schema: 'task-receipt-v1' as const, taskId, state: task.state, repeated: false };
    });
  }
  async runJob(projectId: string, id: string, raw: unknown) {
    const { clientRequestId } = ProjectRunRequestSchema.parse(raw);
    await this.#ordinaryJob(projectId, id);
    return this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId); const taskId = derivedId('task', 'job-now', projectId, id, clientRequestId), existing = (await this.o.hub.task(taskId))?.document;
      if (existing) return { schema: 'task-receipt-v1' as const, taskId, state: existing.state, repeated: true };
      const job = (await this.o.hub.job(id))?.document; if (!job || job.projectId !== projectId || !job.enabled) return refuse('This job is unavailable or disabled.');
      const refusal = jobRunRefusal(await this.o.settings(projectId), job); if (refusal) return refuse(refusal, job.run.kind === 'github-workflow' ? 400 : 409);
      if (job.run.kind === 'github-workflow') return refuse('GitHub workflow jobs retired on 19 October. Use a command job.', 400);
      const tasks = await this.o.tasks.list(projectId), pending = tasks.find(task => task.jobId === id && ['queued', 'active'].includes(task.state));
      if (pending) return { schema: 'task-receipt-v1' as const, taskId: pending.id, state: pending.state, repeated: true };
      const task = await this.o.tasks.save(await this.#plan(projectId, taskId, await this.day(projectId), null, job, taskRankBetween(tasks.map(task => task.rank).sort().at(-1) ?? null, null))); this.o.changed();
      return { schema: 'task-receipt-v1' as const, taskId, state: task.state, repeated: false };
    });
  }
  async #ordinaryJob(projectId: string, id: string): Promise<void> {
    const deploy = (await this.o.settings(projectId)).deploy;
    if (id === deploy.jobId || id === deploy.desktopJobId) refuse('Deploy jobs run only from the owner’s deploy message.');
  }
  async eligible(task: ProjectWorkTask, tasks: readonly ProjectWorkTask[]): Promise<boolean> {
    const window = await this.window(task.projectId);
    if (window && task.nightlyWindowId === window.id && !task.nightlyFixFor && this.o.now() < Date.parse(window.openedAt) + 7 * 3_600_000) {
      const next = await this.#next(window, tasks);
      if (task.id !== next) return false;
    }
    if (task.kind === 'job' && !task.deployment) { let after: string | undefined; do { const page = await this.o.hub.deploys(task.projectId, after); if (page.records.some(row => ['approved', 'running'].includes(row.state) || row.monitor || row.rollbackPending && !row.rollback)) return false; after = page.next ?? undefined; } while (after); }
    return task.kind !== 'job' || !this.o.runner.busy(task.projectId) && !tasks.some(row => row.id !== task.id && row.kind === 'job' && row.state === 'active');
  }
  async sweep(projectId: string): Promise<void> {
    await this.o.runner.sweep(projectId);
    if ((await this.o.settings(projectId)).status !== 'active') return;
    await this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId);
      let window = await this.window(projectId); const tasks = await this.o.tasks.list(projectId);
      if (window) {
        for (const plan of window.plans) if (!tasks.some(row => row.id === plan.id)) { const saved = await this.o.tasks.save(plan); tasks.push(saved); }
        const expired = this.o.now() >= Date.parse(window.openedAt) + 7 * 3_600_000;
        if (expired || !await this.#next(window, tasks)) {
          if (expired) for (const task of tasks.filter(row => window!.taskIds.includes(row.id) && row.state === 'queued')) {
            const saved = await this.o.tasks.save({ ...task, state: 'cancelled', endedAt: this.o.tasks.at(), endNote: 'The seven-hour nightly window ended before this task started.' });
            tasks[tasks.findIndex(row => row.id === saved.id)] = saved;
          }
          if (expired) await this.o.runner.cancel(projectId);
          const review = tasks.find(row => window!.taskIds.includes(row.id) && row.nightlyReview), fix = tasks.find(row => row.id === review?.reviewRun?.fixTaskId);
          const failed = expired || !!window.failed || window.taskIds.some(id => tasks.some(row => row.id === id && ['failed', 'cancelled'].includes(row.state))) || !!fix && ['failed', 'cancelled'].includes(fix.state);
          const runs = await this.o.runner.runs(projectId), lines = [];
          if (expired) lines.push('The seven-hour nightly deadline ended this window. Unfinished fix work continues as a normal task.');
          if (window.openedLateReason) lines.push(`Opened late at ${window.openedAt}, scheduled ${window.scheduledAt}: ${window.openedLateReason}`);
          for (const plan of [...window.plans, ...(fix ? [fix] : [])]) {
            const task = tasks.find(row => row.id === plan.id), run = runs.find(row => row.taskId === plan.id);
            const timedOut = expired && task && ['active', 'queued'].includes(task.state);
            const reason = timedOut ? 'The seven-hour nightly deadline expired before this item completed.' : run?.conclusion && run.conclusion !== 'passed' ? run.summary : task?.endNote;
            lines.push(`${plan.title}: ${timedOut ? 'timed-out' : run?.conclusion ?? task?.state ?? 'not started'}${reason ? ` — ${reason}` : ''}${run ? `\nCommit: ${run.commit}${run.url ? `\nRun: ${run.url}` : ''}` : ''}\nTask: /projects/${projectId}/tasks/${plan.id}`);
            if (task?.reviewRun?.report) lines.push(`Review summary: ${task.reviewRun.report.summary}\nReviewed commit: ${task.reviewRun.commit}`);
            if (task?.nightlyFixFor && task.threadId) {
              const thread = (await this.o.hub.thread(task.threadId))?.document;
              const route = thread?.pr ? (await this.o.hub.mergeDocument(derivedId('mroute', thread.id, thread.pr.headSha)))?.document : null;
              lines.push(`Fix task: ${task.id}${thread?.pr ? `\nPull request: ${thread.pr.url}\nCommit: ${thread.pr.headSha}` : ''}${route?.schema === 'merge-route-v1' ? `\nRoute: ${route.route}${route.reason ? ` — ${route.reason}` : ''}` : '\nRoute: not recorded'}`);
            }
          }
          const dream = this.o.memoryDreamLine?.(projectId), previousDream = window.outcome?.match(/Memory dream:[\s\S]*$/u)?.[0]; if (dream || previousDream) lines.push(dream === 'Memory dream: not run.' && previousDream ? previousDream : dream ?? previousDream!);
          const outcome = lines.join('\n\n').slice(0, 8000), finishedAt = this.o.tasks.at();
          window = (await this.o.hub.putWindow({ ...window, state: 'finished', mergesHeld: false, finishedAt, outcome, failed }, window.revision)).document;
          await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', window.id), at: finishedAt, outcome }); this.o.changed();
        } else {
          const next = await this.#next(window, tasks);
          if (!window.jobPhaseStartedAt && window.plans.some(plan => plan.id === next && plan.kind === 'job')) window = (await this.o.hub.putWindow({ ...window, jobPhaseStartedAt: this.o.tasks.at() }, window.revision)).document;
          await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-opened', id: derivedId('cev', 'window-opened', window.id), at: window.openedAt, pending: window.taskIds.length }); return;
        }
      }
      const settings = await this.o.settings(projectId); if (settings.status !== 'active' || !settings.nightlyWindow.enabled) return;
      const last = (await this.windows(projectId)).find(row => row.state === 'finished');
      if (last) await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', last.id), at: last.finishedAt!, outcome: last.outcome ?? '' });
      const date = await this.day(projectId), boundary = await this.dayStart(projectId, date);
      if (this.o.now() < boundary) return;
      const id = derivedId('window', projectId, date), previous = (await this.o.hub.window(id))?.document;
      if (previous) {
        // A crash after the closing receipt must not lose the coordinator's notification.
        if (previous.state === 'finished') await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', previous.id), at: previous.finishedAt!, outcome: previous.outcome ?? '' });
        return;
      }
      const closingProjectDay = shiftProjectDate(date, -1), enabled = (await this.dailies(projectId)).filter(daily => daily.enabled && dailyDueOn(daily, date) && Date.parse(daily.enabledSince ?? daily.createdAt) <= boundary);
      if (!enabled.length) return;
      const pending = enabled.filter(daily => daily.target.kind !== 'memory-dream');
      const jobs = new Map((await this.jobs(projectId)).map(job => [job.id, job]));
      pending.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const plans: ProjectWorkTask[] = []; let rank = taskRankBetween(null, tasks.map(task => task.rank).sort()[0] ?? null);
      // Build in reverse to keep daily order ahead of all ordinary tasks, including Now.
      for (const daily of [...pending].reverse()) {
        const job = daily.target.kind === 'job' ? jobs.get(daily.target.jobId) ?? null : null;
        if (daily.target.kind === 'job' && !job) return refuse('A daily job definition is missing.');
        plans.unshift({ ...await this.#plan(projectId, derivedId('task', 'window', id, daily.id), closingProjectDay, daily, job, rank), nightlyWindowId: id }); rank = taskRankBetween(null, rank);
      }
      const guard = this.o.now() - boundary > 60_000 ? await this.o.nightGuard?.(projectId, date, this.o.now() - boundary, enabled.map(daily => daily.name)) : undefined;
      if (guard && !guard.open) {
        const at = this.o.tasks.at();
        await this.o.hub.putWindow(ProjectWindowSchema.parse({ schema: 'project-window-v1', id, projectId, revision: 0, date, closingProjectDay, state: 'finished', mergesHeld: false, openedAt: at, scheduledAt: new Date(boundary).toISOString(),
          finishedAt: at, taskIds: [], plans: [], outcome: guard.outcome, failed: true }), 0);
        this.o.changed(); return;
      }
      const openedAt = this.o.tasks.at(), scheduledAt = new Date(boundary).toISOString(), openedLateReason = this.o.now() - boundary > 60_000 ? `The hub did not process this boundary on time (${Math.floor((this.o.now() - boundary) / 60_000)} minutes late).` : undefined;
      window = (await this.o.hub.putWindow(ProjectWindowSchema.parse({ schema: 'project-window-v1', id, projectId, revision: 0, date, closingProjectDay, state: 'open', mergesHeld: true, openedAt, scheduledAt, ...(openedLateReason ? { openedLateReason } : {}), taskIds: plans.map(plan => plan.id), plans, memoryDreamPending: enabled.some(daily => daily.target.kind === 'memory-dream') }), 0)).document;
      for (const plan of plans) await this.o.tasks.save(plan);
      await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-opened', id: derivedId('cev', 'window-opened', id), at: openedAt, pending: plans.length }); this.o.changed();
    });
  }
}
