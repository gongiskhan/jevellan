import { createHash } from 'node:crypto';
import { GoalCreateRequestSchema, GoalListViewSchema, GoalUpdateRequestSchema, GoalViewSchema, ProjectGoalSchema, ProjectRefillStateSchema, stableJson,
  type CoordinatorEvent, type ProjectGoal, type ProjectHub, type ProjectWorkTask, type ProjectWorkSettings, type SecretRedactor } from '@jevellan/core';
import { derivedId } from './decision-items.js';
import { projectDay } from './project-day.js';
import { goalCompletionRefusal, type ProjectTasks } from './tasks.js';
const refuse = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
export class ProjectGoals {
  constructor(readonly o: { hub: Pick<ProjectHub, 'goals' | 'goal' | 'putGoal' | 'refill' | 'putRefill'>; tasks: ProjectTasks; redactor: SecretRedactor; now(): number;
    settings(projectId: string): Promise<ProjectWorkSettings>; event(projectId: string, event: CoordinatorEvent): Promise<void>; changed?(projectId: string): void;
    available(projectId: string): Promise<boolean>; windowOpen?(projectId: string): Promise<boolean>;
    /** The owner's display id of a goal (bridge), for refusals he reads. */
    displayId?(projectId: string, goalId: string): string | undefined }) {}
  async list(projectId: string): Promise<ProjectGoal[]> {
    const goals: ProjectGoal[] = []; let after: string | undefined;
    do { const page = await this.o.hub.goals(projectId, after); goals.push(...page.records); after = page.next ?? undefined; } while (after);
    return goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async read(projectId: string, goalId: string): Promise<ProjectGoal> {
    const goal = (await this.o.hub.goal(goalId))?.document; if (!goal || goal.projectId !== projectId) return refuse('Goal not found.', 404); return goal;
  }
  async day(projectId: string): Promise<string> {
    const settings = await this.o.settings(projectId); return projectDay(this.o.now(), settings.nightlyWindow.enabled ? settings.nightlyWindow.time : '00:00', settings.nightlyWindow.timezone);
  }
  counts(goal: ProjectGoal, tasks: readonly ProjectWorkTask[], day: string) {
    const own = tasks.filter(task => task.goalId === goal.id);
    return { queued: own.filter(task => task.state === 'queued').length, active: own.filter(task => task.state === 'active').length,
      inReview: own.filter(task => task.state === 'in-review').length,
      refillsToday: own.filter(task => task.source === 'refill' && (task.projectDay ?? task.createdAt.slice(0, 10)) === day).length };
  }
  async view(projectId: string) {
    const [goals, tasks, day] = await Promise.all([this.list(projectId), this.o.tasks.list(projectId), this.day(projectId)]);
    return GoalListViewSchema.parse({ schema: 'goal-list-view-v1', projectId, goals: goals.map(goal => ({ schema: 'goal-view-v1', goal, counts: this.counts(goal, tasks, day) })) });
  }
  async create(projectId: string, raw: unknown) {
    const input = GoalCreateRequestSchema.parse(raw), { clientRequestId, schema: _schema, ...fields } = input; void _schema;
    const id = derivedId('goal', projectId, clientRequestId), digest = createHash('sha256').update(stableJson(input)).digest('hex');
    const current = (await this.o.hub.goal(id))?.document;
    if (current) { if (current.projectId !== projectId || current.requestDigest !== digest) return refuse('This request ID already created a different goal.'); return GoalViewSchema.parse({ schema: 'goal-view-v1', goal: current, counts: this.counts(current, await this.o.tasks.list(projectId), await this.day(projectId)) }); }
    const at = new Date(this.o.now()).toISOString(), goal = (await this.o.hub.putGoal(ProjectGoalSchema.parse(this.o.redactor.document({ schema: 'project-goal-v1', id, projectId, revision: 0, ...fields, requestDigest: digest, createdAt: at, updatedAt: at })), 0)).document;
    this.o.changed?.(projectId); return GoalViewSchema.parse({ schema: 'goal-view-v1', goal, counts: this.counts(goal, [], await this.day(projectId)) });
  }
  async update(projectId: string, goalId: string, raw: unknown) {
    const { schema: _schema, expectedRevision, ...patch } = GoalUpdateRequestSchema.parse(raw); void _schema;
    return this.o.tasks.withGoalQueue(projectId, goalId, async cancel => {
      let current = await this.read(projectId, goalId); if (current.revision !== expectedRevision) return refuse('This goal changed. Reload before editing.');
      current = await this.#complete(current, cancel);
      const newCompletion = patch.state === 'done' && (current.state !== 'done' || !current.doneCleanup);
      let doneCleanup = current.doneCleanup;
      if (newCompletion) {
        const queued = (await this.o.tasks.list(projectId)).filter(task => task.goalId === goalId && ['queued', 'draft'].includes(task.state));
        const refusal = goalCompletionRefusal(queued); if (refusal) return refuse(refusal);
        doneCleanup = { schema: 'goal-done-cleanup-v1', id: derivedId('gdone', projectId, goalId, String(expectedRevision)), requestedAt: new Date(this.o.now()).toISOString(), taskIds: queued.map(task => task.id), state: 'pending', cancelledCount: 0 };
      }
      let goal = await this.#save(ProjectGoalSchema.parse({ ...current, ...patch, ...(doneCleanup ? { doneCleanup } : {}) }));
      goal = await this.#complete(goal, cancel);
      return GoalViewSchema.parse({ schema: 'goal-view-v1', goal, counts: this.counts(goal, await this.o.tasks.list(projectId), await this.day(projectId)) });
    });
  }
  async #save(goal: ProjectGoal) {
    const saved = (await this.o.hub.putGoal(ProjectGoalSchema.parse(this.o.redactor.document({ ...goal, updatedAt: new Date(this.o.now()).toISOString() })), goal.revision)).document;
    this.o.changed?.(goal.projectId); return saved;
  }
  async #complete(goal: ProjectGoal, cancel: (id: string, reason: string) => Promise<ProjectWorkTask>): Promise<ProjectGoal> {
    const cleanup = goal.doneCleanup; if (!cleanup || cleanup.state !== 'pending') return goal;
    let cancelledCount = 0;
    for (const id of cleanup.taskIds) if ((await cancel(id, `Goal ${goal.name} is done.`)).state === 'cancelled') cancelledCount++;
    return this.#save({ ...goal, doneCleanup: { ...cleanup, state: 'complete', cancelledCount } });
  }
  async recoverDone(projectId: string): Promise<void> {
    for (const goal of (await this.list(projectId)).filter(goal => goal.doneCleanup?.state === 'pending')) {
      await this.o.tasks.withGoalQueue(projectId, goal.id, async cancel => { await this.#complete(await this.read(projectId, goal.id), cancel); });
    }
  }
  async validate(projectId: string, goalId: string | null, source: ProjectWorkTask['source'], refillEventId?: string): Promise<'draft' | 'queued'> {
    if (goalId === null) { if (source === 'refill') return refuse('A refill task must serve a listed goal.', 400); return 'queued'; }
    const goal = await this.read(projectId, goalId);
    // A paused or done goal takes no new tasks from the coordinator (bridge); the owner may still add one on purpose.
    if (goal.state !== 'active' && source !== 'owner') return refuse(`${this.o.displayId?.(projectId, goal.id) ?? `Goal "${goal.name}"`} is ${goal.state}.`);
    if (source === 'refill') {
      if (await this.o.windowOpen?.(projectId)) return refuse('Goals wait for the nightly window to finish.');
      const refill = (await this.o.hub.refill(projectId))?.document, tasks = await this.o.tasks.list(projectId), day = await this.day(projectId);
      if (refill?.eventId !== refillEventId || !refill?.goals.some(item => item.goalId === goalId)) return refuse('This goal was not requested for refill in the current turn.', 403);
      if (!this.needsRefill(goal, tasks, day)) return refuse('This goal does not currently need refill.');
      if (tasks.some(task => task.goalId === goalId && task.refillEventId === refillEventId)) return refuse('Only one task per goal can answer a refill event.');
    }
    return ['refill', 'finding'].includes(source) && goal.autonomy === 'propose' ? 'draft' : 'queued';
  }
  async eligible(task: ProjectWorkTask, tasks: readonly ProjectWorkTask[]): Promise<boolean> {
    // Enabled Nightly definitions are explicit owner work; goal refill and coding-task pause/caps do not skip them.
    if (task.source === 'daily') {
      if (!task.goalId) return true;
      const goal = (await this.o.hub.goal(task.goalId))?.document;
      return goal?.projectId !== task.projectId || goal.doneCleanup?.state !== 'pending' || !goal.doneCleanup.taskIds.includes(task.id);
    }
    if (!task.goalId) return true;
    const goal = await this.read(task.projectId, task.goalId); if (goal.state !== 'active') return false;
    if (task.kind !== 'session') return true;
    const own = tasks.filter(other => other.id !== task.id && other.goalId === goal.id);
    return !own.some(other => other.kind === 'session' && (other.state === 'active' || other.state === 'queued' && !!other.dispatchText)) && own.filter(other => other.state === 'in-review').length < goal.openPrCap;
  }
  needsRefill(goal: ProjectGoal, tasks: readonly ProjectWorkTask[], day: string): boolean {
    const own = tasks.filter(task => task.goalId === goal.id), counts = this.counts(goal, tasks, day);
    return goal.state === 'active' && !own.some(task => ['draft', 'queued', 'active'].includes(task.state)) && counts.inReview < goal.openPrCap && counts.refillsToday < goal.dailyRefillCap;
  }
  async sweep(projectId: string): Promise<void> {
    await this.recoverDone(projectId);
    await this.o.tasks.exclusive(projectId, async () => {
      await this.o.tasks.assertWriter(projectId);
      if ((await this.o.settings(projectId)).status !== 'active') return;
      if (await this.o.windowOpen?.(projectId)) return;
      const last = await this.o.hub.refill(projectId);
      // Re-delivery is harmless: the coordinator durably deduplicates IDs, including after a crash before enqueue.
      if (last) await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'goal-refill', id: last.document.eventId, at: last.document.lastAt, goals: last.document.goals });
      const settings = await this.o.settings(projectId);
      if (!settings.refill.enabled || last && this.o.now() - Date.parse(last.document.lastAt) < settings.refill.minIntervalMinutes * 60_000 || await this.o.windowOpen?.(projectId) || !await this.o.available(projectId)) return;
      const [goals, tasks, day] = await Promise.all([this.list(projectId), this.o.tasks.list(projectId), this.day(projectId)]);
      const wanted = goals.filter(goal => this.needsRefill(goal, tasks, day)).slice(0, 100).map(goal => ({ goalId: goal.id, name: goal.name, refillsToday: this.counts(goal, tasks, day).refillsToday, cap: goal.dailyRefillCap }));
      if (!wanted.length) return;
      const at = new Date(this.o.now()).toISOString(), eventId = derivedId('cev', 'goal-refill', projectId, at);
      const saved = (await this.o.hub.putRefill(ProjectRefillStateSchema.parse({ schema: 'project-refill-state-v1', projectId, revision: last?.revision ?? 0, lastAt: at, eventId, goals: wanted }), last?.revision ?? 0)).document;
      await this.o.event(projectId, { schema: 'coordinator-event-v1', kind: 'goal-refill', id: eventId, at, goals: saved.goals });
    });
  }
}
