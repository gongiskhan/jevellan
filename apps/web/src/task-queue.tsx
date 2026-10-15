import { useState } from 'react';
import { useSessionDrag } from './session-drag.js';
import { TaskTypeSchema, TaskViewSchema, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core/client';
import type { GoalEntry } from './project-goals.js';
import { api } from './api.js';
import { Confirm, Markdown, Modal, useTask } from './components.js';

export function TaskQueue({ projectId, tasks, goals = [], threads = [], grouped = false, navigate, changed, onError }: { projectId: string; tasks: readonly ProjectWorkTask[]; goals?: readonly GoalEntry[]; threads?: readonly ThreadIndex[]; grouped?: boolean; navigate(path: string): void; changed(): void; onError(error: unknown): void }) {
  const operation = useTask(onError), [editing, setEditing] = useState<ProjectWorkTask>(), [rejecting, setRejecting] = useState<ProjectWorkTask>();
  const [grouping, setGrouping] = useState(() => { try { return localStorage.getItem('jevellan.queue-grouping') === 'goals' ? 'goals' : 'order'; } catch { return 'order'; } });
  const choose = (value: string) => { setGrouping(value); try { localStorage.setItem('jevellan.queue-grouping', value); } catch { /* Storage may be unavailable. */ } };
  const open = tasks.filter(task => ['draft', 'queued', 'active', 'in-review'].includes(task.state));
  const action = (task: ProjectWorkTask, value: 'approve' | 'reject' | 'cancel' | 'now' | 'later') => void operation.run(async signal => {
    await api(`/api/projects/${projectId}/tasks/${task.id}/action`, TaskViewSchema, 'POST', { schema: 'task-action-request-v1', expectedRevision: task.revision, action: value }, { signal, waitForHub: true }); changed(); setRejecting(undefined);
  });
  const move = (task: ProjectWorkTask, position: 'top' | 'bottom' | { before: string } | { after: string }) => void operation.run(async signal => {
    await api(`/api/projects/${projectId}/tasks/${task.id}/edit`, TaskViewSchema, 'POST', { schema: 'task-update-request-v1', expectedRevision: task.revision, position }, { signal, waitForHub: true }); changed();
  });
  const { list, drag } = useSessionDrag({ disabled: operation.busy, handleSelector: '.pw-task summary', start: () => undefined,
    drop: (id, target, after) => { const task = tasks.find(row => row.id === id); if (task && ['draft', 'queued'].includes(task.state)) move(task, after ? { after: target } : { before: target }); } });
  const groups = grouped && grouping === 'goals' ? [...goals.filter(entry => entry.goal.state !== 'done').map(entry => ({ label: entry.goal.name, rows: open.filter(task => task.goalId === entry.goal.id && !task.dailyId) })), { label: 'Asks', rows: open.filter(task => !task.goalId && !task.dailyId) }, { label: 'Daily', rows: open.filter(task => !!task.dailyId) }] : [{ label: '', rows: open }];
  return <>
    {grouped && <div className="pw-group-control" role="group" aria-label="Queue grouping"><button className="secondary small" aria-pressed={grouping === 'order'} onClick={() => choose('order')}>Order</button><button className="secondary small" aria-pressed={grouping === 'goals'} onClick={() => choose('goals')}>Goals</button></div>}
    <div ref={list} className="pw-task-list">
    {open.length === 0 && <p className="pw-empty">Nothing in the queue. Ask the coordinator or add a task.</p>}
    {groups.map(group => <section className="pw-task-group" key={group.label}>{group.label && <h4>{group.label}</h4>}{group.label && !group.rows.length && <p className="pw-empty">Nothing open for this goal.</p>}{group.rows.map(task => { const index = open.indexOf(task), goal = goals.find(entry => entry.goal.id === task.goalId)?.goal, thread = threads.find(row => row.id === task.threadId); return <article className={`pw-task${drag?.id === task.id ? ' pw-task-dragging' : ''}${drag?.target === task.id ? ' pw-task-drop' : ''}`} key={task.id}
      data-session-id={['draft', 'queued'].includes(task.state) ? task.id : undefined}>
      <details><summary><strong>{task.title}</strong> <span className="chip">{task.held ? 'On hold · ' : task.now ? 'Now · ' : ''}{task.state === 'in-review' ? 'In review' : task.state[0]!.toUpperCase() + task.state.slice(1)}</span>{goal && goal.state !== 'active' && <span className="chip">Goal paused</span>}</summary>
        <p className="muted">{task.type} · {goal?.name ?? (task.goalId ? 'Goal task' : 'Asks')}{task.ownerRanked ? ' · Ordered by you' : ''}</p>
        {goal && goal.state !== 'active' && <p className="pw-field-note">Goal paused</p>}
        {thread && <p className="muted">{thread.modelLabel} · {thread.effort} effort · {thread.ownerDeviceId}</p>}
        <Markdown>{task.brief}</Markdown>
        {task.needs.length > 0 && <p>Needs: {task.needs.join(', ')}</p>}
        {task.after.some(id => !['done', 'cancelled'].includes(tasks.find(row => row.id === id)?.state ?? 'queued')) && <p>Waiting on: {task.after.filter(id => !['done', 'cancelled'].includes(tasks.find(row => row.id === id)?.state ?? 'queued')).map(id => tasks.find(row => row.id === id)?.title ?? id).join(', ')}</p>}
        {task.endNote && <p>{task.endNote}</p>}
        <div className="actions">
          <button type="button" className="secondary small" onClick={() => navigate(`/projects/${projectId}/tasks/${task.id}`)}>Open task</button>
          {task.threadId && <button type="button" className="secondary small" onClick={() => navigate(`/projects/${projectId}/threads/${task.threadId}`)}>Open thread</button>}
          {task.state === 'draft' && <><button type="button" className="small" disabled={operation.busy} onClick={() => action(task, 'approve')}>Approve</button><button type="button" className="secondary small" disabled={operation.busy} onClick={() => setRejecting(task)}>Reject</button></>}
          {['draft', 'queued'].includes(task.state) && <>
            <button type="button" className="secondary small" disabled={operation.busy} onClick={() => action(task, task.now && !task.held ? 'later' : 'now')}>{task.now && !task.held ? 'Later' : 'Start now'}</button>
            {!task.threadId && !task.dispatchText && <button type="button" className="secondary small" onClick={() => setEditing(task)}>Edit</button>}
            <button type="button" className="secondary small" disabled={operation.busy || !!task.dispatchText && !task.threadId} onClick={() => action(task, 'cancel')}>Cancel</button>
            <button type="button" className="secondary small" disabled={operation.busy} onClick={() => move(task, 'top')}>Move to top</button>
            <button type="button" className="secondary small" disabled={operation.busy} onClick={() => move(task, 'bottom')}>Move to bottom</button>
            <button type="button" className="secondary small" aria-label={`Move ${task.title} earlier`} disabled={operation.busy || index === 0} onClick={() => move(task, { before: open[index - 1]!.id })}>↑</button>
            <button type="button" className="secondary small" aria-label={`Move ${task.title} later`} disabled={operation.busy || index === open.length - 1} onClick={() => move(task, { after: open[index + 1]!.id })}>↓</button>
          </>}
        </div>
      </details>
    </article>; })}</section>)}
    </div>
    {rejecting && <Confirm title={`Reject "${rejecting.title}"?`} action="Reject" danger busy={operation.busy} confirm={() => action(rejecting, 'reject')} close={() => setRejecting(undefined)}><p>Rejected tasks stay in the project history.</p></Confirm>}
    {editing && <EditTask task={editing} goals={goals} close={() => setEditing(undefined)} onError={onError} saved={changed} />}
  </>;
}
function EditTask({ task, goals, close, onError, saved }: { task: ProjectWorkTask; goals: readonly GoalEntry[]; close(): void; onError(error: unknown): void; saved(): void }) {
  const [goalId, setGoalId] = useState(task.goalId ?? '');
  const [title, setTitle] = useState(task.title), [brief, setBrief] = useState(task.brief), [type, setType] = useState(task.type), operation = useTask(onError);
  return <Modal title="Edit task" close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    await api(`/api/projects/${task.projectId}/tasks/${task.id}/edit`, TaskViewSchema, 'POST', { schema: 'task-update-request-v1', expectedRevision: task.revision, title, brief, type, goalId: goalId || null }, { signal, waitForHub: true }); saved(); close();
  }); }}>
    <label>Title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>Brief<textarea required maxLength={20000} rows={8} value={brief} onChange={event => setBrief(event.target.value)} /></label>
    <label>Type<select value={type} onChange={event => setType(TaskTypeSchema.parse(event.target.value))}>{TaskTypeSchema.options.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>Goal<select value={goalId} onChange={event => setGoalId(event.target.value)}><option value="">Asks</option>{goals.map(entry => <option key={entry.goal.id} value={entry.goal.id}>{entry.goal.name}</option>)}</select></label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form></Modal>;
}
