import { ThreadActions } from './thread-actions.js';
import { boardGroup, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core/client';
import * as copy from './project-work-copy.js';

/** One live card shared by the chat and Overview. It reads the work view, never a stale tool-result snapshot. */
export function ThreadCard({ projectId, thread, task, position, deviceName, navigate, start, dismiss, busy, changed, onError }: {
  projectId: string; thread?: ThreadIndex | undefined; task?: ProjectWorkTask | undefined; position?: number | undefined;
  changed?(): void; onError?(error: unknown): void;
  deviceName?(id: string): string; navigate(path: string): void; start?(task: ProjectWorkTask): void; dismiss?(task: ProjectWorkTask): void; busy?: boolean;
}) {
  if (!thread && !task) return <p className="muted">{copy.LOADING_TASK_CARD}</p>;
  const title = thread?.title ?? task!.title, href = thread ? `/projects/${projectId}/threads/${thread.id}` : `/projects/${projectId}/tasks/${task!.id}`;
  const label = thread ? copy.BOARD_LABELS[boardGroup(thread)] : task!.state === 'draft' ? copy.PROPOSED_CARD : task!.held ? copy.HELD_CARD : copy.QUEUED_CARD;
  return <article className="pw-thread-card" data-thread-id={thread?.id} data-task-id={task?.id}>
    <div className="pw-thread-card-heading"><a href={href} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(href); } }}>{title}</a>
      <span className={`chip ${thread ? `pw-group-${boardGroup(thread)}` : ''}`}><span className="pw-card-dot" />{label}</span></div>
    {thread ? <p className="muted pw-card-meta">{copy.cardPlacement(thread.modelLabel, thread.effort, thread.accountLabel, deviceName?.(thread.ownerDeviceId) ?? thread.ownerDeviceId)}</p>
      : task!.state === 'queued' && position ? <p className="muted">{copy.queueCardPosition(position)}</p> : null}
    {thread?.state === 'attached' && <span className="chip">{copy.IN_TERMINAL}</span>}
    {thread?.landing && <span className="chip">{copy.LANDING_LABELS[thread.landing]}</span>}
    {thread?.pr && <p className="pw-card-pr"><a href={thread.pr.url} target="_blank" rel="noreferrer">#{thread.pr.number}</a>
      <span className={`chip ${thread.pr.checks === 'passing' ? 'ok' : thread.pr.checks === 'failing' ? 'danger' : 'muted'}`}>{copy.CARD_CHECKS[thread.pr.checks]}</span>
      {thread.pr.mergeable === 'conflict' && <span className="chip danger">{copy.CONFLICTS}</span>}</p>}
    {thread?.pr?.state === 'merged' && <span className="pw-outcome muted">{copy.mergedOutcome(thread.pr.number)}</span>}
    {thread && <ThreadActions projectId={projectId} thread={thread} changed={changed} onError={onError} />}
    {task && !thread && (task.state === 'draft' || task.held) && <div className="actions">
      <button className="small" disabled={busy} onClick={() => start?.(task)}>{copy.START_CARD}</button>
      {task.state === 'draft' && <button className="secondary small" disabled={busy} onClick={() => dismiss?.(task)}>{copy.DISMISS_CARD}</button>}
    </div>}
  </article>;
}
