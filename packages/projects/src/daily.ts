import { createHash } from 'node:crypto';
import { DailyCreateRequestSchema, DailyUpdateRequestSchema, JobCreateRequestSchema, JobUpdateRequestSchema, ProjectDailyListViewSchema, ProjectDailySchema, ProjectJobSchema, ProjectRunRequestSchema,
  ReviewFollowupInputSchema, ProjectWindowSchema, ProjectWorkTaskSchema, stableJson, type CoordinatorEvent, type ProjectDaily, type ProjectHub, type ProjectJob, type ProjectWindow, type ProjectWorkSettings, type ProjectWorkTask, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import type { ProjectJobRunner } from './job-runner.js';
import { projectBoundary, projectDay, shiftProjectDate } from './project-day.js';
import { taskRankBetween, type ProjectTasks } from './tasks.js';
const refuse = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
export const NIGHTLY_MERGE_HOLD = 'Merges are held while the nightly window runs.';
const ended = (task: ProjectWorkTask) => ['done', 'failed', 'cancelled', 'in-review'].includes(task.state);
export class ProjectDailyWork {
  constructor(readonly o: { hub: ProjectHub; tasks: ProjectTasks; runner: ProjectJobRunner; redactor: SecretRedactor; now(): number; deviceId: string;
    settings(projectId: string): Promise<ProjectWorkSettings>; validateGoal(projectId: string, goalId: string | null): Promise<void>;
    event(projectId: string, event: CoordinatorEvent): Promise<void>; changed(): void }) {}
  async jobs(projectId: string): Promise<ProjectJob[]> {
    const rows: ProjectJob[] = []; let after: string | undefined;
    do { const page = await this.o.hub.jobs(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after); return rows;
  }
  async dailies(projectId: string): Promise<ProjectDaily[]> {
    const rows: ProjectDaily[] = []; let after: string | undefined;
    do { const page = await this.o.hub.dailies(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows.sort((a, b) => Number(b.target.kind === 'review-since-last') - Number(a.target.kind === 'review-since-last') || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async windows(projectId: string): Promise<ProjectWindow[]> {
    const rows: ProjectWindow[] = []; let after: string | undefined;
    do { const page = await this.o.hub.windows(projectId, after); rows.push(...page.records); after = page.next ?? undefined; } while (after);
    return rows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }
  async window(projectId: string): Promise<ProjectWindow | null> { return (await this.windows(projectId)).find(row => row.state === 'open') ?? null; }
  async mergesHeld(projectId: string): Promise<boolean> {
    const window = await this.window(projectId); if (window) return window.mergesHeld && this.o.now() < Date.parse(window.openedAt) + 7 * 3_600_000;
    // Fence merges at the configured time even while the coordinator is creating its durable window.
    const settings = await this.o.settings(projectId); if (!settings.nightlyWindow.enabled) return false;
    const date = await this.day(projectId), boundary = await this.dayStart(projectId, date);
    return this.o.now() >= boundary && this.o.now() < boundary + 7 * 3_600_000 && !(await this.o.hub.window(derivedId('window', projectId, date))) && (await this.dailies(projectId)).some(row => row.enabled);
  }
  async allowedMergeThreads(projectId: string, tasks?: readonly ProjectWorkTask[]): Promise<string[]> {
    const window = await this.window(projectId); if (!window || this.o.now() >= Date.parse(window.openedAt) + 150 * 60_000) return [];
    const rows = tasks ?? await this.o.tasks.list(projectId), review = rows.find(row => window.taskIds.includes(row.id) && row.nightlyReview);
    const fix = review?.reviewRun?.fixTaskId ? rows.find(row => row.id === review.reviewRun!.fixTaskId && row.nightlyFixFor === review.id) : null;
    return fix?.threadId ? [fix.threadId] : [];
  }
  async assertMerge(projectId: string, threadId?: string): Promise<void> {
    if (await this.mergesHeld(projectId) && (!threadId || !(await this.allowedMergeThreads(projectId)).includes(threadId))) refuse(NIGHTLY_MERGE_HOLD);
  }
  #next(window: ProjectWindow, tasks: readonly ProjectWorkTask[]): string | undefined {
    for (const plan of window.plans) {
      const task = tasks.find(row => row.id === plan.id); if (!task || !ended(task)) return plan.id;
      if (task.nightlyReview && task.reviewRun?.state === 'completed' && this.o.now() < Date.parse(window.openedAt) + 150 * 60_000) {
        if (!task.reviewRun.followupChosen) return 'awaiting-review-followup';
        if (task.reviewRun.fixTaskId) {
          const fix = tasks.find(row => row.id === task.reviewRun!.fixTaskId);
          if (!fix || !['done', 'failed', 'cancelled'].includes(fix.state)) return task.reviewRun.fixTaskId;
        }
      }
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
      const window = review.nightlyWindowId ? (await this.o.hub.window(review.nightlyWindowId))?.document : null;
      const inWindow = window?.state === 'open' && this.o.now() < Date.parse(window.openedAt) + 150 * 60_000;
      let fixTaskId: string | null = null;
      if (input.task) {
        const goal = review.goalId ? (await this.o.hub.goal(review.goalId))?.document : null;
        if (goal?.name !== 'Hardening through code review') return refuse('The review fix needs the Hardening through code review goal.');
        fixTaskId = derivedId('task', 'review-fix', review.id);
        if (!(await this.o.hub.task(fixTaskId))) await this.o.tasks.save(ProjectWorkTaskSchema.parse(this.o.redactor.document({ schema: 'project-work-task-v1', id: fixTaskId, projectId, revision: 0,
          ...input.task, kind: 'session', type: 'finding', goalId: review.goalId, source: 'finding', state: 'queued', rank: taskRankBetween(null, (await this.o.tasks.list(projectId)).map(row => row.rank).sort()[0] ?? null), ownerRanked: false, now: true,
          after: [], needs: [], dailyId: null, jobId: null, threadId: null, jobRunId: null, fixed: { isolation: 'worktree' }, nightlyFixFor: review.id,
          ...(inWindow ? { nightlyWindowId: window.id } : {}), projectDay: review.projectDay, createdAt: this.o.tasks.at(), updatedAt: this.o.tasks.at() })));
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
    const lastReview = tasks.filter(row => row.reviewRun?.state === 'completed').sort((a, b) => b.reviewRun!.sequence - a.reviewRun!.sequence || b.reviewRun!.completedAt!.localeCompare(a.reviewRun!.completedAt!))[0]?.reviewRun?.report ?? null;
    return ProjectDailyListViewSchema.parse({ schema: 'project-daily-list-view-v1', projectId, projectDay, dailies, jobs, runs, tasks, window, lastReview, lastReviewedCommit: lastReview?.commit ?? null, mergeAllowedThreads: await this.allowedMergeThreads(projectId, tasks),
      mergesHeld: await this.mergesHeld(projectId) });
  }
  async createJob(projectId: string, raw: unknown): Promise<ProjectJob> {
    const input = JobCreateRequestSchema.parse(raw), id = derivedId('pjob', projectId, input.clientRequestId), requestDigest = createHash('sha256').update(stableJson(input)).digest('hex');
    const current = (await this.o.hub.job(id))?.document; if (current) { if (current.projectId !== projectId || current.requestDigest !== requestDigest) return refuse('This request ID already created a different job.'); return current; }
    await this.o.validateGoal(projectId, input.goalId); await this.#gate(projectId, id, input.gate?.jobId);
    const { schema: _schema, clientRequestId: _request, ...fields } = input; void _schema; void _request;
    const at = this.o.tasks.at(), job = (await this.o.hub.putJob(ProjectJobSchema.parse(this.o.redactor.document({ ...fields, schema: 'project-job-v1', id, projectId, revision: 0, requestDigest, createdAt: at, updatedAt: at })), 0)).document; this.o.changed(); return job;
  }
  async updateJob(projectId: string, id: string, raw: unknown): Promise<ProjectJob> {
    const input = JobUpdateRequestSchema.parse(raw), current = (await this.o.hub.job(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Job not found.', 404);
    await this.o.validateGoal(projectId, input.goalId); await this.#gate(projectId, id, input.gate?.jobId);
    const { schema: _schema, expectedRevision, ...fields } = input; void _schema;
    const job = (await this.o.hub.putJob(ProjectJobSchema.parse(this.o.redactor.document({ ...current, ...fields, updatedAt: this.o.tasks.at() })), expectedRevision)).document; this.o.changed(); return job;
  }
  async #gate(projectId: string, id: string, parent?: string): Promise<void> {
    const visited = new Set([id]);
    while (parent) { if (visited.has(parent)) return refuse('Job gates cannot contain a cycle.', 400); visited.add(parent);
      const job = (await this.o.hub.job(parent))?.document; if (!job || job.projectId !== projectId) return refuse('A gate must be a job of this project.', 400); parent = job.gate?.jobId; }
  }
  async createDaily(projectId: string, raw: unknown): Promise<ProjectDaily> {
    const input = DailyCreateRequestSchema.parse(raw), id = derivedId('daily', projectId, input.clientRequestId), requestDigest = createHash('sha256').update(stableJson(input)).digest('hex');
    const current = (await this.o.hub.daily(id))?.document; if (current) { if (current.projectId !== projectId || current.requestDigest !== requestDigest) return refuse('This request ID already created a different daily item.'); return current; }
    if ((await this.dailies(projectId)).length >= 50) return refuse('A project supports at most fifty daily items.');
    await this.#dailyTarget(projectId, input); const { schema: _schema, clientRequestId: _request, ...fields } = input; void _schema; void _request;
    const at = this.o.tasks.at(), daily = (await this.o.hub.putDaily(ProjectDailySchema.parse(this.o.redactor.document({ ...fields, schema: 'project-daily-v1', id, projectId, revision: 0, requestDigest, createdAt: at, updatedAt: at })), 0)).document; this.o.changed(); return daily;
  }
  async updateDaily(projectId: string, id: string, raw: unknown): Promise<ProjectDaily> {
    const input = DailyUpdateRequestSchema.parse(raw), current = (await this.o.hub.daily(id))?.document;
    if (!current || current.projectId !== projectId) return refuse('Daily item not found.', 404);
    await this.#dailyTarget(projectId, input); const { schema: _schema, expectedRevision, ...fields } = input; void _schema;
    const daily = (await this.o.hub.putDaily(ProjectDailySchema.parse(this.o.redactor.document({ ...current, ...fields, updatedAt: this.o.tasks.at() })), expectedRevision)).document; this.o.changed(); return daily;
  }
  async #dailyTarget(projectId: string, daily: Pick<ProjectDaily, 'goalId' | 'target'>): Promise<void> {
    await this.o.validateGoal(projectId, daily.goalId);
    if (daily.target.kind === 'review-since-last' && daily.goalId && (await this.o.hub.goal(daily.goalId))?.document.name !== 'Hardening through code review') return refuse('Review since last uses the Hardening through code review goal.', 400);
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
    return this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId); const taskId = derivedId('task', 'daily-now', projectId, id, clientRequestId), existing = (await this.o.hub.task(taskId))?.document;
      if (existing) return { schema: 'task-receipt-v1' as const, taskId, state: existing.state, repeated: true };
      const daily = (await this.o.hub.daily(id))?.document; if (!daily || daily.projectId !== projectId || !daily.enabled) return refuse('This daily item is unavailable or disabled.');
      const tasks = await this.o.tasks.list(projectId), pending = tasks.find(task => task.dailyId === id && ['queued', 'active'].includes(task.state));
      if (pending) return { schema: 'task-receipt-v1' as const, taskId: pending.id, state: pending.state, repeated: true };
      const job = daily.target.kind === 'job' ? (await this.o.hub.job(daily.target.jobId))?.document ?? null : null;
      if (daily.target.kind === 'job' && !job?.enabled) return refuse('This job is unavailable or disabled.');
      const rank = taskRankBetween(tasks.filter(task => ['draft', 'queued', 'active'].includes(task.state)).map(task => task.rank).sort().at(-1) ?? null, null);
      const task = await this.o.tasks.save(await this.#plan(projectId, taskId, await this.day(projectId), daily, job, rank)); this.o.changed();
      return { schema: 'task-receipt-v1' as const, taskId, state: task.state, repeated: false };
    });
  }
  async runJob(projectId: string, id: string, raw: unknown) {
    const { clientRequestId } = ProjectRunRequestSchema.parse(raw);
    return this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId); const taskId = derivedId('task', 'job-now', projectId, id, clientRequestId), existing = (await this.o.hub.task(taskId))?.document;
      if (existing) return { schema: 'task-receipt-v1' as const, taskId, state: existing.state, repeated: true };
      const job = (await this.o.hub.job(id))?.document; if (!job || job.projectId !== projectId || !job.enabled) return refuse('This job is unavailable or disabled.');
      const tasks = await this.o.tasks.list(projectId), pending = tasks.find(task => task.jobId === id && ['queued', 'active'].includes(task.state));
      if (pending) return { schema: 'task-receipt-v1' as const, taskId: pending.id, state: pending.state, repeated: true };
      const task = await this.o.tasks.save(await this.#plan(projectId, taskId, await this.day(projectId), null, job, taskRankBetween(tasks.map(task => task.rank).sort().at(-1) ?? null, null))); this.o.changed();
      return { schema: 'task-receipt-v1' as const, taskId, state: task.state, repeated: false };
    });
  }
  async eligible(task: ProjectWorkTask, tasks: readonly ProjectWorkTask[]): Promise<boolean> {
    const window = await this.window(task.projectId);
    if (window && this.o.now() < Date.parse(window.openedAt) + 7 * 3_600_000) {
      const next = this.#next(window, tasks);
      if (task.id !== next) return false;
    }
    return task.kind !== 'job' || !this.o.runner.busy(task.projectId) && !tasks.some(row => row.id !== task.id && row.kind === 'job' && row.state === 'active');
  }
  async sweep(projectId: string): Promise<void> {
    await this.o.runner.sweep(projectId);
    await this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId);
      let window = await this.window(projectId); const tasks = await this.o.tasks.list(projectId);
      if (window) {
        for (const plan of window.plans) if (!tasks.some(row => row.id === plan.id)) { const saved = await this.o.tasks.save(plan); tasks.push(saved); }
        const expired = this.o.now() >= Date.parse(window.openedAt) + 7 * 3_600_000;
        if (expired || !this.#next(window, tasks)) {
          if (expired) for (const task of tasks.filter(row => window!.taskIds.includes(row.id) && row.state === 'queued')) {
            const saved = await this.o.tasks.save({ ...task, state: 'cancelled', endedAt: this.o.tasks.at(), endNote: 'The seven-hour nightly window ended before this task started.' });
            tasks[tasks.findIndex(row => row.id === saved.id)] = saved;
          }
          if (expired) this.o.runner.cancel(projectId);
          const review = tasks.find(row => window!.taskIds.includes(row.id) && row.nightlyReview), fix = tasks.find(row => row.id === review?.reviewRun?.fixTaskId);
          const failed = expired || window.taskIds.some(id => tasks.some(row => row.id === id && ['failed', 'cancelled'].includes(row.state))) || !!fix && ['failed', 'cancelled'].includes(fix.state);
          const outcome = [...window.plans, ...(fix ? [fix] : [])].map(plan => `${plan.title}: ${tasks.find(row => row.id === plan.id)?.state ?? 'not started'}`).join('\n').slice(0, 8000), finishedAt = this.o.tasks.at();
          window = (await this.o.hub.putWindow({ ...window, state: 'finished', mergesHeld: false, finishedAt, outcome, failed }, window.revision)).document;
          await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', window.id), at: finishedAt, outcome }); this.o.changed();
        } else {
          await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-opened', id: derivedId('cev', 'window-opened', window.id), at: window.openedAt, pending: window.taskIds.length }); return;
        }
      }
      const settings = await this.o.settings(projectId); if (!settings.nightlyWindow.enabled) return;
      const last = (await this.windows(projectId)).find(row => row.state === 'finished');
      if (last) await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', last.id), at: last.finishedAt!, outcome: last.outcome ?? '' });
      const date = await this.day(projectId), boundary = await this.dayStart(projectId, date);
      if (this.o.now() < boundary || this.o.now() >= boundary + 7 * 3_600_000) return;
      const id = derivedId('window', projectId, date), previous = (await this.o.hub.window(id))?.document;
      if (previous) {
        // A crash after the closing receipt must not lose the coordinator's notification.
        if (previous.state === 'finished') await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-finished', id: derivedId('cev', 'window-finished', previous.id), at: previous.finishedAt!, outcome: previous.outcome ?? '' });
        return;
      }
      const closingProjectDay = shiftProjectDate(date, -1), pending = (await this.dailies(projectId)).filter(daily => daily.enabled);
      if (!pending.length) return;
      const plans: ProjectWorkTask[] = []; let rank = taskRankBetween(null, tasks.map(task => task.rank).sort()[0] ?? null);
      // Build in reverse to keep daily order ahead of all ordinary tasks, including Now.
      for (const daily of [...pending].reverse()) {
        const job = daily.target.kind === 'job' ? (await this.o.hub.job(daily.target.jobId))?.document ?? null : null;
        if (daily.target.kind === 'job' && !job) return refuse('A daily job definition is missing.');
        plans.unshift({ ...await this.#plan(projectId, derivedId('task', 'window', id, daily.id), closingProjectDay, daily, job, rank), nightlyWindowId: id }); rank = taskRankBetween(null, rank);
      }
      const openedAt = new Date(boundary).toISOString();
      window = (await this.o.hub.putWindow(ProjectWindowSchema.parse({ schema: 'project-window-v1', id, projectId, revision: 0, date, closingProjectDay, state: 'open', mergesHeld: true, openedAt, taskIds: plans.map(plan => plan.id), plans }), 0)).document;
      for (const plan of plans) await this.o.tasks.save(plan);
      await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'window-opened', id: derivedId('cev', 'window-opened', id), at: openedAt, pending: plans.length }); this.o.changed();
    });
  }
}
