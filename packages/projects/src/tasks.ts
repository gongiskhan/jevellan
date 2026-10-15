import { createHash } from 'node:crypto';
import { ProjectWorkTaskSchema, TaskActionRequestSchema, TaskCreateRequestSchema, TaskUpdateRequestSchema, stableJson,
  type ProjectHub, type ProjectWorkTask, type SecretRedactor, type TaskCreateRequest, type TaskUpdateRequest, type ThreadIndex } from '@jevellan/core';
import { derivedId } from './decision-items.js';

const refuse = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
/** Variable precision hexadecimal fractions. Extending a tight interval changes only the moved row. */
export function taskRankBetween(before: string | null, after: string | null): string {
  const valid = (value: string) => /^[0-9a-f]{1,64}$/u.test(value);
  if (before !== null && !valid(before) || after !== null && !valid(after)) throw new Error('Unsupported queue rank.');
  let width = Math.max(1, before?.length ?? 0, after?.length ?? 0);
  const value = (rank: string | null, high: boolean) => rank === null ? (high ? 16n ** BigInt(width) : 0n) : BigInt(`0x${rank.padEnd(width, '0')}`);
  let low = value(before, false), high = value(after, true);
  if (low >= high) throw new Error('Queue neighbours are out of order.');
  while (high - low < 2n) { if (++width > 64) throw new Error('This queue interval is full. Choose another position.'); low *= 16n; high *= 16n; }
  return ((low + high) / 2n).toString(16).padStart(width, '0').replace(/0+$/u, '');
}
export const taskOrder = (a: ProjectWorkTask, b: ProjectWorkTask) => Number(b.now) - Number(a.now) || a.rank.localeCompare(b.rank) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
export const taskOpen = (task: ProjectWorkTask) => ['draft', 'queued', 'active', 'in-review'].includes(task.state);
export function taskThreadState(thread: ThreadIndex): Pick<ProjectWorkTask, 'state' | 'endNote' | 'endedAt'> {
  if (thread.state === 'queued') return { state: 'queued' };
  if (thread.state === 'in-review') return { state: 'in-review' };
  if (thread.state === 'done') return { state: 'done', ...(thread.endedAt ? { endedAt: thread.endedAt } : {}) };
  if (thread.state === 'stopped' || thread.state === 'failed') return { state: thread.state === 'failed' ? 'failed' : 'cancelled', endNote: (thread.stateReason ?? (thread.state === 'failed' ? 'Thread failed.' : 'Stopped by you.')).slice(0, 400), ...(thread.endedAt ? { endedAt: thread.endedAt } : {}) };
  return { state: 'active' };
}
type Hub = Pick<ProjectHub, 'tasks' | 'task' | 'putTask' | 'coordinator'>;
export class ProjectTasks {
  readonly #chains = new Map<string, Promise<unknown>>();
  constructor(readonly o: { hub: Hub; deviceId: string; redactor: SecretRedactor; now(): number;
    reviewed?(task: ProjectWorkTask, outcome: 'approved' | 'rejected'): Promise<void>;
    cancelThread?(task: ProjectWorkTask, reason: string, owner: boolean): Promise<void>;
    changed?(projectId: string): void;
    projectDay?(projectId: string): Promise<string>;
    validateGoal?(projectId: string, goalId: string | null, source: ProjectWorkTask['source'], refillEventId?: string): Promise<'draft' | 'queued'> }) {}
  exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(projectId) ?? Promise.resolve()).then(work), tail = result.then(() => undefined, () => undefined);
    this.#chains.set(projectId, tail); void tail.then(() => { if (this.#chains.get(projectId) === tail) this.#chains.delete(projectId); }); return result;
  }
  async list(projectId: string): Promise<ProjectWorkTask[]> {
    const tasks: ProjectWorkTask[] = []; let after: string | undefined;
    do { const page = await this.o.hub.tasks(projectId, after); tasks.push(...page.records); after = page.next ?? undefined; } while (after);
    return tasks.sort(taskOrder);
  }
  async read(projectId: string, taskId: string): Promise<ProjectWorkTask> {
    const task = (await this.o.hub.task(taskId))?.document; if (!task || task.projectId !== projectId) return refuse('Task not found.', 404); return task;
  }
  async assertWriter(projectId: string): Promise<void> { if ((await this.o.hub.coordinator(projectId))?.document.deviceId !== this.o.deviceId) refuse('The task queue is controlled on the coordinator device.'); }
  async save(task: ProjectWorkTask): Promise<ProjectWorkTask> {
    return (await this.o.hub.putTask(ProjectWorkTaskSchema.parse(this.o.redactor.document({ ...task, updatedAt: this.at() })), task.revision)).document;
  }
  at(): string { return new Date(this.o.now()).toISOString(); }
  #rank(ordered: ProjectWorkTask[], index: number): string {
    return taskRankBetween(ordered[index - 1]?.rank ?? null, ordered[index]?.rank ?? null);
  }
  create(projectId: string, raw: TaskCreateRequest, source: ProjectWorkTask['source'] = 'owner', authority: { ownerRequested?: boolean; id?: string; refillEventId?: string } = {}) {
    return this.exclusive(projectId, async () => {
      await this.assertWriter(projectId); const input = TaskCreateRequestSchema.parse(raw);
      if (source === 'owner-request' && !authority.ownerRequested) refuse("Only a task the owner asked for in this turn can be marked as the owner's request.", 403);
      if (input.now && !['owner', 'owner-request'].includes(source)) refuse('Only owner requests can be marked Now.', 403);
      const id = authority.id ?? derivedId('task', projectId, input.clientRequestId), digest = createHash('sha256').update(stableJson({ ...input, source })).digest('hex');
      const previous = (await this.o.hub.task(id))?.document;
      if (previous) { if (previous.projectId !== projectId || previous.requestDigest !== digest) refuse('This request ID already created a different task.'); return { schema: 'task-receipt-v1' as const, taskId: id, state: previous.state, repeated: true }; }
      const state = await this.o.validateGoal?.(projectId, input.goalId, source, authority.refillEventId) ?? 'queued';
      if (input.goalId !== null && !this.o.validateGoal) refuse('Goals are not available yet.', 400);
      const ordered = (await this.list(projectId)).filter(taskOpen).sort((a, b) => a.rank.localeCompare(b.rank));
      const { clientRequestId: _requestId, held, ...fields } = input; void _requestId;
      const at = this.at(), task = await this.save(ProjectWorkTaskSchema.parse({ ...fields, schema: 'project-work-task-v1', id, projectId, revision: 0,
        kind: 'session', source, state, rank: this.#rank(ordered, ordered.length), ownerRanked: false, dailyId: null, jobId: null, threadId: null, jobRunId: null,
        ...(held ? { held: true } : {}), createdAt: at, updatedAt: at, requestDigest: digest, ...(authority.refillEventId ? { refillEventId: authority.refillEventId } : {}), ...(this.o.projectDay ? { projectDay: await this.o.projectDay(projectId) } : {}) }));
      this.o.changed?.(projectId);
      return { schema: 'task-receipt-v1' as const, taskId: task.id, state: task.state, repeated: false };
    });
  }
  update(projectId: string, taskId: string, raw: TaskUpdateRequest, owner = true): Promise<ProjectWorkTask> {
    return this.exclusive(projectId, async () => {
      await this.assertWriter(projectId); const input = TaskUpdateRequestSchema.parse(raw), current = await this.read(projectId, taskId);
      if (current.revision !== input.expectedRevision) refuse('This task changed. Reload before editing.');
      if (!['draft', 'queued'].includes(current.state)) refuse('Only tasks that have not started can be edited.');
      if ((current.threadId || current.dispatchText) && Object.keys(input).some(key => !['schema', 'expectedRevision', 'position', 'now', 'held'].includes(key))) refuse('The task has a reserved start; only its queue position and Now can change.');
      if (!owner && input.now !== undefined) refuse('Only the owner can change Now.', 403);
      if (!owner && input.fixed !== undefined) refuse('Only the owner can change fixed placement.', 403);
      if (input.goalId !== undefined) await this.o.validateGoal?.(projectId, input.goalId, current.source);
      const { expectedRevision: _revision, schema: _schema, position, ...patch } = input; void _revision; void _schema;
      let rank = current.rank;
      if (position !== undefined) {
        if (!owner && current.ownerRanked) refuse('The owner placed this task; leave it where it is.', 403);
        const ordered = (await this.list(projectId)).filter(task => task.id !== taskId && taskOpen(task)).sort((a, b) => a.rank.localeCompare(b.rank));
        let index = position === 'top' ? 0 : ordered.length;
        if (typeof position === 'object') { const neighbour = 'before' in position ? position.before : position.after; index = ordered.findIndex(task => task.id === neighbour); if (index < 0) refuse('The queue neighbour was not found.', 400); if ('after' in position) index++; }
        rank = this.#rank(ordered, index);
      }
      const { held, ...rest } = patch, next = { ...current, ...rest, rank, ownerRanked: current.ownerRanked || owner && position !== undefined };
      if (held === false) delete next.held; else if (held) next.held = true;
      const task = await this.save(ProjectWorkTaskSchema.parse(next));
      this.o.changed?.(projectId); return task;
    });
  }
  action(projectId: string, taskId: string, raw: unknown, owner = true): Promise<ProjectWorkTask> {
    return this.exclusive(projectId, async () => {
      await this.assertWriter(projectId); const input = TaskActionRequestSchema.parse(raw), current = await this.read(projectId, taskId);
      if (current.revision !== input.expectedRevision) refuse('This task changed. Reload before acting.');
      if (!['draft', 'queued'].includes(current.state)) refuse('Use the thread controls for a task that has started.');
      if (current.dispatchText && !current.threadId && ['cancel', 'reject'].includes(input.action)) refuse('The task has a reserved start. Wait for its thread before stopping it.');
      if (['approve', 'reject'].includes(input.action) && current.state !== 'draft') refuse('Only a draft needs approval.');
      const ended = ['reject', 'cancel'].includes(input.action);
      if (ended && current.threadId) { if (!this.o.cancelThread) refuse('The queued thread cannot be stopped here.'); await this.o.cancelThread!(current, input.reason ?? 'Cancelled by you.', owner); }
      const task = await this.save({ ...current, ...(input.action === 'approve' ? { state: 'queued' as const } : {}),
        ...(ended ? { state: 'cancelled' as const, endedAt: this.at(), endNote: input.reason ?? (input.action === 'reject' ? 'Rejected by you.' : 'Cancelled by you.') } : {}),
        ...(['now', 'later'].includes(input.action) ? { now: input.action === 'now' } : {}), ...(input.action === 'now' ? { held: undefined } : {}) });
      if (['approve', 'reject'].includes(input.action)) await this.o.reviewed?.(task, input.action === 'approve' ? 'approved' : 'rejected');
      this.o.changed?.(projectId); return task;
    });
  }
}
