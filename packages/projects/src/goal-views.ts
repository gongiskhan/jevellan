import { z } from 'zod';
import { ProjectGoalViewsSchema, ProjectGoalEditorSchema, GoalEditorSaveRequestSchema, GoalCreateRequestSchema, GoalUpdateRequestSchema, newId,
  type ProjectDailyListViewSchema, type ProjectGoal, type ProjectGoalViews, type GoalListViewSchema, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core';
import { goalDue } from './goal-due.js';
import { goalCompletionRefusal } from './tasks.js';

type Entry = z.infer<typeof GoalListViewSchema>['goals'][number];
export function projectGoalViews(projectId: string, goals: readonly Entry[], tasks: readonly ProjectWorkTask[], threads: readonly ThreadIndex[], daily: z.infer<typeof ProjectDailyListViewSchema>) {
  const path = `/api/projects/${projectId}/goals`, open = tasks.filter(task => ['draft', 'queued', 'active', 'in-review'].includes(task.state));
  const scope = (rows: readonly ProjectWorkTask[]) => ({ order: rows.map(task => task.id), groups: [
    ...goals.filter(({ goal }) => goal.state !== 'done' || rows.some(task => task.goalId === goal.id && !task.dailyId)).map(({ goal }) => ({ label: goal.name, taskIds: rows.filter(task => task.goalId === goal.id && !task.dailyId).map(task => task.id) })),
    { label: 'Asks', taskIds: rows.filter(task => !task.goalId && !task.dailyId).map(task => task.id) },
    ...rows.some(task => task.goalId && !task.dailyId && !goals.some(({ goal }) => goal.id === task.goalId)) ? [{ label: 'Goal tasks', taskIds: rows.filter(task => task.goalId && !task.dailyId && !goals.some(({ goal }) => goal.id === task.goalId)).map(task => task.id) }] : [],
    { label: 'Daily', taskIds: rows.filter(task => !!task.dailyId).map(task => task.id) },
  ] });
  const rows = goals.map(({ goal, counts }) => {
    const actions: ProjectGoalViews['rows'][number]['actions'] = [];
    const update = (name: 'pause' | 'resume' | 'done', label: string, state: 'active' | 'paused' | 'done') => {
      const refusal = name === 'done' ? goalCompletionRefusal(tasks.filter(task => task.goalId === goal.id)) : null;
      actions.push({ kind: 'update', name, label, enabled: !refusal, refusal,
        request: { path: `${path}/${goal.id}/edit`, body: { schema: 'goal-update-request-v1', expectedRevision: goal.revision, state } },
        confirm: name === 'done' ? { title: `Mark "${goal.name}" done?`, action: 'Mark done', consequence: 'Queued and proposed tasks are cancelled. Running tasks finish. Its history stays.' } : null });
    };
    if (goal.state !== 'done') update(goal.state === 'active' ? 'pause' : 'resume', goal.state === 'active' ? 'Pause' : 'Reactivate', goal.state === 'active' ? 'paused' : 'active');
    actions.push({ kind: 'edit', name: 'edit', label: 'Edit', path: `${path}/${goal.id}/editor` });
    if (goal.state !== 'done') update('done', 'Mark done', 'done');
    const due = goalDue(goal, { running: counts.active, queued: counts.queued }, { tasks, dailies: daily.dailies, runs: daily.runs, windows: daily.window ? [daily.window] : [] });
    return { goalId: goal.id, name: goal.name, motivation: goal.motivation, health: goal.health,
      stateLabel: goal.state === 'done' ? 'Done' : goal.state === 'paused' ? 'Paused' : 'Active', autonomyLabel: goal.autonomy === 'propose' ? 'Propose tasks' : 'Queue tasks automatically',
      countsLine: `${counts.queued} queued · ${counts.active} running · ${counts.inReview} in review · ${counts.refillsToday} refilled today`,
      capsLine: `Refills a day: ${goal.dailyRefillCap} · Open pull requests: ${goal.openPrCap}`,
      due, dueLine: due.length ? `Due: ${due.map(row => row.text).join(' · ')}` : null, notice: goal.doneCleanup?.state === 'pending' ? 'Finishing cancellation of queued and proposed tasks.' : null, actions };
  });
  return ProjectGoalViewsSchema.parse({ schema: 'project-goal-views-v1', projectId, rows, createEditorPath: `${path}/editor`,
    emptyText: 'Add a goal to explain what matters and let the coordinator propose useful work.',
    queue: { schema: 'project-task-queue-view-v1', scopes: { all: scope(open), proposed: scope(open.filter(task => task.state === 'draft')) }, rows: open.map(task => {
      const goal = goals.find(row => row.goal.id === task.goalId)?.goal, thread = threads.find(row => row.id === task.threadId);
      const waiting = task.after.filter(id => !['done', 'cancelled'].includes(tasks.find(row => row.id === id)?.state ?? 'queued'));
      return { taskId: task.id, stateLabel: `${task.held ? 'On hold · ' : task.now ? 'Now · ' : ''}${task.state === 'in-review' ? 'In review' : task.state[0]!.toUpperCase() + task.state.slice(1)}`,
        meta: `${task.type} · ${goal?.name ?? (task.goalId ? 'Goal task' : 'Asks')}${task.ownerRanked ? ' · Ordered by you' : ''}`,
        goalNotice: !task.dailyId && goal && goal.state !== 'active' ? goal.state === 'done' ? 'Goal done' : 'Goal paused' : null,
        threadLine: thread ? `${thread.modelLabel} · ${thread.effort} effort · ${thread.ownerDeviceId}` : null,
        waitingLine: waiting.length ? `Waiting on: ${waiting.map(id => tasks.find(row => row.id === id)?.title ?? id).join(', ')}` : null };
    }) } });
}
const limit = (schema: z.ZodType, key: string) => {
  const value = (z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>)[key];
  if (typeof value !== 'number') throw new Error(`The goal schema has no ${key}.`); return value;
};
export function goalEditorView(projectId: string, goal?: ProjectGoal) {
  const fields = GoalCreateRequestSchema.shape, states = ['active', 'paused', ...(goal?.state === 'done' ? ['done'] : [])];
  return ProjectGoalEditorSchema.parse({ schema: 'project-goal-editor-v1', projectId, goalId: goal?.id ?? null, title: goal ? 'Edit goal' : 'New goal',
    defaults: { name: goal?.name ?? '', motivation: goal?.motivation ?? '', health: goal?.health ?? fields.health.parse(undefined), autonomy: goal?.autonomy ?? fields.autonomy.parse(undefined),
      state: goal?.state ?? fields.state.parse(undefined), dailyRefillCap: String(goal?.dailyRefillCap ?? fields.dailyRefillCap.parse(undefined)), openPrCap: String(goal?.openPrCap ?? fields.openPrCap.parse(undefined)) },
    choices: { states: states.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })), autonomy: [{ value: 'propose', label: 'Propose tasks' }, { value: 'auto', label: 'Queue tasks automatically' }] },
    constraints: { ...Object.fromEntries((['name', 'motivation', 'health'] as const).map(key => [key, { maxLength: limit(fields[key], 'maxLength') }])),
      ...Object.fromEntries((['dailyRefillCap', 'openPrCap'] as const).map(key => [key, { min: limit(fields[key], 'minimum'), max: limit(fields[key], 'maximum') }])) },
    request: { path: `/api/projects/${projectId}/goals/${goal ? `${goal.id}/` : ''}editor`, base: goal ? { schema: 'goal-editor-update-request-v1', expectedRevision: goal.revision } : { schema: 'goal-editor-create-request-v1', clientRequestId: newId('gform') } } });
}
export function goalEditorRequest(raw: unknown, goalId?: string) {
  const request = GoalEditorSaveRequestSchema.parse(raw);
  if ((request.schema === 'goal-editor-update-request-v1') !== !!goalId) throw Object.assign(new Error('The editor request does not match this goal.'), { status: 400 });
  const fields = { ...request.fields, dailyRefillCap: Number(request.fields.dailyRefillCap), openPrCap: Number(request.fields.openPrCap) };
  return request.schema === 'goal-editor-create-request-v1' ? GoalCreateRequestSchema.parse({ ...fields, schema: 'goal-create-request-v1', clientRequestId: request.clientRequestId })
    : GoalUpdateRequestSchema.parse({ ...fields, schema: 'goal-update-request-v1', expectedRevision: request.expectedRevision });
}
