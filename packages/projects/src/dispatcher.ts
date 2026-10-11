import { HubUnavailable, ProjectWorkTaskSchema, stableJson, type CoordinatorEvent, type ProjectWorkTask, type TaskPlacementContext } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { ProjectTasks, taskOrder, taskRankBetween, taskThreadState } from './tasks.js';
import type { ThreadService } from './threads.js';

export class ProjectDispatcher {
  readonly #running = new Map<string, Promise<void>>();
  constructor(readonly o: { tasks: ProjectTasks; threads: Pick<ThreadService, 'start' | 'list' | 'sweepQueue'>; deviceId: string;
    text(task: ProjectWorkTask): Promise<{ brief: string; assembled: string; taskContext?: TaskPlacementContext }>;
    review?(task: ProjectWorkTask): Promise<void>;
    job?(task: ProjectWorkTask): Promise<void>;
    eligible?(task: ProjectWorkTask, tasks: readonly ProjectWorkTask[]): Promise<boolean>;
    event(projectId: string, event: CoordinatorEvent): Promise<void> }) {}
  busy(projectId?: string): boolean { return projectId ? this.#running.has(projectId) : this.#running.size > 0; }
  sweep(projectId: string): Promise<void> {
    const previous = this.#running.get(projectId); if (previous) return previous;
    const run = this.o.tasks.exclusive(projectId, () => this.#sweep(projectId)).finally(() => { if (this.#running.get(projectId) === run) this.#running.delete(projectId); });
    this.#running.set(projectId, run); return run;
  }
  async #sweep(projectId: string): Promise<void> {
    await this.o.tasks.assertWriter(projectId);
    const threads = await this.o.threads.list(projectId, 'all'), indexed = new Map(threads.map(thread => [thread.id, thread]));
    let tasks = await this.o.tasks.list(projectId);
    // Legacy queued threads keep their identities and placement; append once in their original order.
    const mapped = new Set(tasks.flatMap(task => task.threadId ? [task.threadId] : []));
    for (const thread of threads.filter(thread => thread.state === 'queued' && !mapped.has(thread.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
      const id = derivedId('task', 'queued-thread', projectId, thread.id), last = [...tasks].sort((a, b) => a.rank.localeCompare(b.rank)).at(-1)?.rank ?? null;
      const rank = taskRankBetween(last, null); if (!rank) throw new Error('Legacy queue ranks need rebalancing.');
      const existing = await this.o.tasks.o.hub.task(id);
      const task = existing?.document ?? await this.o.tasks.save(ProjectWorkTaskSchema.parse({ schema: 'project-work-task-v1', id, projectId, revision: 0,
        title: thread.title, brief: `Continue the existing thread "${thread.title}". Its complete brief stays with that thread.`, kind: 'session', type: 'feature', goalId: null, source: 'owner', state: 'queued',
        rank, ownerRanked: false, now: false, after: [], needs: [], dailyId: null, jobId: null, threadId: thread.id, jobRunId: null, fixed: {}, createdAt: thread.createdAt, updatedAt: this.o.tasks.at() }));
      tasks.push(task); mapped.add(thread.id);
    }
    for (let index = 0; index < tasks.length; index++) {
      let task = tasks[index]!; let thread = task.threadId ? indexed.get(task.threadId) : undefined; if (!thread) continue;
      const visited = new Set<string>();
      while (thread.restartedAs && !visited.has(thread.id)) {
        visited.add(thread.id); const restarted = indexed.get(thread.restartedAs);
        if (!restarted) break;
        const { endNote: _note, endedAt: _ended, ...previous } = task; void _note; void _ended;
        task = tasks[index] = await this.o.tasks.save({ ...previous, threadId: restarted.id, ...taskThreadState(restarted) }); thread = restarted;
      }
      if (thread.restartedAs && !indexed.has(thread.restartedAs)) continue;
      const state = taskThreadState(thread);
      if (stableJson(state) !== stableJson({ state: task.state, ...(task.endNote ? { endNote: task.endNote } : {}), ...(task.endedAt ? { endedAt: task.endedAt } : {}) })) {
        const { endNote: _note, endedAt: _ended, ...previous } = task; void _note; void _ended;
        tasks[index] = await this.o.tasks.save({ ...previous, ...state });
      }
    }
    for (let task of tasks.filter(task => task.state === 'queued').sort(taskOrder)) {
      if (task.after.some(id => !tasks.some(parent => parent.id === id && ['done', 'cancelled'].includes(parent.state)))) continue;
      if (this.o.eligible && !await this.o.eligible(task, tasks)) continue;
      if (task.kind === 'job' || task.nightlyReview) {
        try { if (task.nightlyReview) await this.o.review?.(task); else await this.o.job?.(task); tasks = await this.o.tasks.list(projectId); }
        catch (error) { if ((error as { status?: number }).status === undefined) throw error; const reason = this.o.tasks.o.redactor.text(error instanceof Error ? error.message : 'Job could not start.').slice(0, 400); await this.o.tasks.save({ ...task, state: 'failed', endNote: reason, endedAt: this.o.tasks.at() }); }
        continue;
      }
      if (task.threadId) {
        await this.o.threads.sweepQueue(projectId, [task.threadId]);
        // Remote dispatch is durably deduplicated by the existing relay command ID.
        const current = (await this.o.threads.list(projectId, 'all')).find(thread => thread.id === task.threadId);
        if (current && current.state !== 'queued') { task = await this.o.tasks.save({ ...task, ...taskThreadState(current) }); tasks = tasks.map(row => row.id === task.id ? task : row); continue; }
        break;
      }
      try {
        if (!task.dispatchText) {
          const text = await this.o.text(task); task = await this.o.tasks.save({ ...task, dispatchBrief: text.brief, dispatchText: text.assembled, ...(text.taskContext ? { dispatchContext: text.taskContext } : {}) });
        }
        const started = await this.o.threads.start({ projectId, title: task.title, task: task.dispatchBrief ?? task.dispatchText!, assembledTask: task.dispatchText!, taskContext: task.dispatchContext, fixed: task.fixed,
          ...(task.placementNote ? { note: task.placementNote } : {}), createdBy: task.source === 'owner' ? 'owner' : 'coordinator', coordinatorDeviceId: this.o.deviceId, clientRequestId: derivedId('treq', 'task', task.id) });
        task = await this.o.tasks.save({ ...task, threadId: started.threadId, state: started.state === 'queued' ? 'queued' : 'active', dispatchedAt: this.o.tasks.at() });
        tasks = tasks.map(row => row.id === task.id ? task : row);
        if (started.state === 'queued') break;
      } catch (error) {
        if (error instanceof HubUnavailable || (error as { status?: number }).status === undefined) throw error;
        if ((error as { resourceRefusal?: boolean }).resourceRefusal) {
          const { dispatchText: _text, dispatchBrief: _brief, ...pending } = task; void _text; void _brief; await this.o.tasks.save(pending); break;
        }
        const reason = this.o.tasks.o.redactor.text(error instanceof Error ? error.message : 'The task could not start.').slice(0, 400);
        const failed = await this.o.tasks.save({ ...task, state: 'failed', endNote: reason, endedAt: this.o.tasks.at() });
        await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'task-not-started', taskId: task.id, title: task.title, reason,
          id: derivedId('cev', 'task-not-started', task.id), at: failed.endedAt! });
      }
    }
  }
  async close(): Promise<void> { await Promise.allSettled([...this.#running.values()]); }
}
