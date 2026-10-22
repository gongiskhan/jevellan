import { useContext } from 'react';
import { ThreadActions } from './thread-actions.js';
import { ProjectCardsContext } from './project-cards.js';
import {projectCardPresentation,projectChatCardPolicy,type ProjectWorkCard,type ProjectWorkTask,type ThreadIndex} from '@jevellan/core/client';
import * as copy from './project-work-copy.js';

/** Shared card renderer; labels, placement, queue position and eligibility come from the engine snapshot. */
export function ThreadCard({ projectId, thread, task, presentation, navigate, start, dismiss, busy, changed, onError }: {
  projectId: string; thread?: ThreadIndex | undefined; task?: ProjectWorkTask | undefined; presentation?: ProjectWorkCard | null | undefined;
  changed?(): void; onError?(error: unknown): void;
  navigate(path: string): void; start?(task: ProjectWorkTask): void; dismiss?(task: ProjectWorkTask): void; busy?: boolean;
}) {
  const cards = useContext(ProjectCardsContext);
  const model = presentation !== undefined ? presentation : projectCardPresentation(cards, thread?.id, task?.id);
  if (!model) return <p className="muted">{projectChatCardPolicy.labels.loading}</p>;
  return <article className="pw-thread-card" data-thread-id={thread?.id} data-task-id={task?.id}>
    <div className="pw-thread-card-heading"><a href={model.href} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(model.href); } }}>{model.title}</a>
      <span className={`chip ${model.group ? `pw-group-${model.group}` : ''}`}><span className="pw-card-dot" />{model.label}</span></div>
    {model.meta && <p className={model.kind === 'thread' ? 'muted pw-card-meta' : 'muted'}>{model.meta}</p>}
    {model.chips.map(chip => <span key={chip.text} className={`chip ${chip.tone === 'plain' ? '' : chip.tone}`}>{chip.text}</span>)}
    {model.pr && <p className="pw-card-pr"><a href={model.pr.url} target="_blank" rel="noreferrer">#{model.pr.number}</a>
      <span className={`chip ${model.pr.checks.tone}`}>{model.pr.checks.text}</span>
      {model.pr.conflicts && <span className="chip danger">{copy.CONFLICTS}</span>}</p>}
    {model.mergedOutcome && <span className="pw-outcome muted">{model.mergedOutcome}</span>}
    {model.threadActions && thread && <ThreadActions projectId={projectId} thread={thread} presentation={model.threadActions} changed={changed} onError={onError} />}
    {task && model.taskStart && <div className="actions">
      <button className="small" disabled={busy} onClick={() => start?.(task)}>{projectChatCardPolicy.labels.start}</button>
      {model.taskDismiss && <button className="secondary small" disabled={busy} onClick={() => dismiss?.(task)}>{projectChatCardPolicy.labels.dismiss}</button>}
    </div>}
  </article>;
}
