import { useState } from 'react';
import { useSessionDrag } from './session-drag.js';
import { ProjectTaskDraftSchema, ProjectTaskIntentRequestSchema, projectTaskQueueInteraction, projectTaskQueueDrop, projectTaskEditView, TaskTypeSchema, TaskViewSchema, type ProjectTaskContext, type ProjectTaskQueueInteraction, type ProjectWorkTask, type ProjectTaskQueueView } from '@jevellan/core/client';
import type { GoalEntry } from './project-goals.js';
import { api } from './api.js';
import { Confirm, Markdown, Modal, useTask } from './components.js';

type QueueRow = ProjectTaskQueueInteraction['rows'][number];
type QueueAction = QueueRow['actions'][number];
async function submitTaskIntent(projectId: string, raw: unknown, signal: AbortSignal) {
  const input = ProjectTaskIntentRequestSchema.parse(raw), path = `/api/projects/${projectId}/tasks/${input.context.taskId}`;
  const draft = await api(path + '/draft', ProjectTaskDraftSchema, 'POST', input, { signal, waitForHub: true });
  return api(path + '/command', TaskViewSchema, 'POST', draft.command, { signal, waitForHub: true });
}

export function TaskQueue({ projectId, tasks, goals = [], view, scope = 'all', grouped = false, navigate, changed, onError }: { projectId: string; tasks: readonly ProjectWorkTask[]; goals?: readonly GoalEntry[]; view: ProjectTaskQueueView; scope?: 'all' | 'proposed'; grouped?: boolean; navigate(path: string): void; changed(): void; onError(error: unknown): void }) {
  const operation = useTask(onError), [editing, setEditing] = useState<ProjectWorkTask>(), [rejecting, setRejecting] = useState<{ row: QueueRow; action: QueueAction }>();
  const [grouping, setGrouping] = useState(() => { try { return localStorage.getItem('jevellan.queue-grouping') === 'goals' ? 'goals' : 'order'; } catch { return 'order'; } });
  const choose = (value: string) => { setGrouping(value); try { localStorage.setItem('jevellan.queue-grouping', value); } catch { /* Storage may be unavailable. */ } };
  const model = projectTaskQueueInteraction({ projectId, tasks, queue: view }, { schema: 'project-task-queue-request-v1', scope, grouped, grouping });
  const execute = (context: ProjectTaskContext, intent: unknown, closeReject = true) => void operation.run(async signal => {
    await submitTaskIntent(projectId, { schema: 'project-task-intent-v1', context, intent }, signal); changed(); if (closeReject) setRejecting(undefined);
  });
  const { list, drag } = useSessionDrag({ disabled: operation.busy, handleSelector: '.pw-task summary', start: () => undefined,
    drop: (id, target, after) => { const input = projectTaskQueueDrop(model, id, target, after); if (input) void operation.run(async signal => { await submitTaskIntent(projectId, input, signal); changed(); }); } });
  const confirmation = rejecting?.action.confirmation;
  return <>
    {model.showGrouping && <div className="pw-group-control" role="group" aria-label="Queue grouping">{model.groupChoices.map(choice => <button key={choice.value} className="secondary small" aria-pressed={choice.selected} onClick={() => choose(choice.value)}>{choice.label}</button>)}</div>}
    <div ref={list} className="pw-task-list">
    {model.order.length === 0 && <p className="pw-empty">{model.emptyText}</p>}
    {model.groups.map(group => <section className="pw-task-group" key={group.label}>{group.label && <h4>{group.label}</h4>}{group.label && !group.taskIds.length && <p className="pw-empty">{model.groupEmptyText}</p>}{group.taskIds.map(id => {
      const task = tasks.find(row => row.id === id)!, row = view.rows.find(row => row.taskId === id)!, policy = model.rows.find(row => row.taskId === id)!;
      return <article className={`pw-task${drag?.id === task.id ? ' pw-task-dragging' : ''}${drag?.target === task.id ? ' pw-task-drop' : ''}`} key={task.id} data-session-id={policy.dragEligible ? task.id : undefined}>
      <details><summary><strong>{task.title}</strong> <span className="chip">{row.stateLabel}</span>{row.goalNotice && <span className="chip">{row.goalNotice}</span>}</summary>
        <p className="muted">{row.meta}</p>
        {row.goalNotice && <p className="pw-field-note">{row.goalNotice}</p>}
        {row.threadLine && <p className="muted">{row.threadLine}</p>}
        <Markdown>{task.brief}</Markdown>
        {policy.needsLine && <p>{policy.needsLine}</p>}
        {row.waitingLine && <p>{row.waitingLine}</p>}
        {policy.endNote && <p>{policy.endNote}</p>}
        <div className="actions">
          <button type="button" className="secondary small" onClick={() => navigate(policy.taskLink.href)}>{policy.taskLink.label}</button>
          {policy.threadLink && <button type="button" className="secondary small" onClick={() => navigate(policy.threadLink!.href)}>{policy.threadLink.label}</button>}
          {policy.actions.map(action => <button key={action.id} type="button" className={action.primary ? 'small' : 'secondary small'} aria-label={action.ariaLabel ?? undefined} disabled={!action.enabled || action.busyDisabled && operation.busy} onClick={() => {
            if (action.kind === 'edit') setEditing(task);
            else if (action.confirmation) setRejecting({ row: policy, action });
            else if (action.intent) execute(policy.context, action.intent, action.intent.kind !== 'move');
          }}>{action.label}</button>)}
        </div>
      </details>
    </article>; })}</section>)}
    </div>
    {rejecting && confirmation && <Confirm title={confirmation.title} action={confirmation.action} danger={confirmation.danger} busy={operation.busy} confirm={() => execute(rejecting.row.context, rejecting.action.intent)} close={() => setRejecting(undefined)}><p>{confirmation.consequence}</p></Confirm>}
    {editing && <EditTask task={editing} goals={goals} close={() => setEditing(undefined)} onError={onError} saved={changed} />}
  </>;
}
function EditTask({ task, goals, close, onError, saved }: { task: ProjectWorkTask; goals: readonly GoalEntry[]; close(): void; onError(error: unknown): void; saved(): void }) {
  const view = projectTaskEditView(task, goals), [fields, setFields] = useState(() => view.defaults), operation = useTask(onError);
  return <Modal title={view.labels.title} close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    await submitTaskIntent(task.projectId, { schema: 'project-task-intent-v1', context: view.context, intent: { kind: 'edit', fields } }, signal); saved(); close();
  }); }}>
    <label>{view.labels.titleField}<input required maxLength={view.limits.title} value={fields.title} onChange={event => setFields(prior => ({ ...prior, title: event.target.value }))} /></label>
    <label>{view.labels.briefField}<textarea required maxLength={view.limits.brief} rows={8} value={fields.brief} onChange={event => setFields(prior => ({ ...prior, brief: event.target.value }))} /></label>
    <label>{view.labels.typeField}<select value={fields.type} onChange={event => setFields(prior => ({ ...prior, type: TaskTypeSchema.parse(event.target.value) }))}>{view.types.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>{view.labels.goalField}<select value={fields.goalId} onChange={event => setFields(prior => ({ ...prior, goalId: event.target.value }))}>{view.goals.map(goal => <option key={goal.id} value={goal.id}>{goal.label}</option>)}</select></label>
    <div className="actions"><button disabled={operation.busy}>{view.labels.save}</button><button type="button" className="secondary" onClick={close}>{view.labels.cancel}</button></div>
  </form></Modal>;
}
