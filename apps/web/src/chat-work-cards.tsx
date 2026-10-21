import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ProjectCardsContext, projectCardKey } from './project-cards.js';
import { TaskViewSchema, ProjectSettingsChangeViewSchema, ProjectWorkSettingsViewSchema, type ProjectSettingsChangeView, type ProjectSettingsChange, type ProjectWorkSettings, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask } from './components.js';
import { ThreadCard } from './thread-card.js';
import * as copy from './project-work-copy.js';
import type { ChatItem } from './project-work-model.js';

export function ChatWorkCards({ item, projectId, tasks, threads, startAll, navigate, changed, onError }: {
  item: Extract<ChatItem, { kind: 'routed' }>; projectId: string; tasks: readonly ProjectWorkTask[]; threads: readonly ThreadIndex[];
  startAll: string[]; navigate(path: string): void; changed(): void; onError(error: unknown): void;
}) {
  const operation = useTask(onError), cards = useContext(ProjectCardsContext);
  const act = async (task: ProjectWorkTask, dismiss = false, signal?: AbortSignal) => {
    const model = cards.get(projectCardKey('task', task.id)), request = dismiss ? model?.taskDismiss : model?.taskStart;
    if (request) await api(request.path, TaskViewSchema, 'POST', request.body, { signal, waitForHub: true });
  };
  const run = (task: ProjectWorkTask, dismiss = false) => void operation.run(async signal => { await act(task, dismiss, signal); changed(); });
  const rows = item.taskIds?.map(id => { const task = tasks.find(task => task.id === id); return { id, task, thread: threads.find(thread => thread.id === task?.threadId) }; })
    ?? [{ id: item.threadId!, task: tasks.find(task => task.threadId === item.threadId), thread: threads.find(thread => thread.id === item.threadId) }];
  return <div className="pw-chat-work-cards">
    {item.message && <p className="muted">{copy.SENT_MESSAGE_CARD}</p>}
    {rows.map(row => <ThreadCard key={row.id} projectId={projectId} task={row.task} thread={row.thread}
      navigate={navigate} changed={changed} onError={onError} busy={operation.busy} start={task => run(task)} dismiss={task => run(task, true)} />)}
    {startAll.length > 0 && <button className="secondary" disabled={operation.busy} onClick={() => void operation.run(async signal => {
      try { for (const id of startAll) { const task = tasks.find(task => task.id === id); if (task) await act(task, false, signal); } } finally { changed(); }
    })}>{copy.startAllCards(startAll.length)}</button>}
  </div>;
}

export function ChatSettingsChanges({ projectId, change, settings, changed, onError }: { projectId: string; change: ProjectSettingsChange; settings: ProjectWorkSettings; changed(): void; onError(error: unknown): void }) {
  const operation = useTask(onError), [model, setModel] = useState<ProjectSettingsChangeView>();
  const error = useRef(onError); error.current = onError;
  const path = `/api/projects/${projectId}/config/change-view`, serialized = JSON.stringify(change);
  const read = useCallback(async (signal: AbortSignal) => {
    setModel(await api(path, ProjectSettingsChangeViewSchema, 'POST', { schema: 'project-settings-change-view-request-v1', change: JSON.parse(serialized) }, { signal, waitForHub: true }));
  }, [path, serialized]);
  useEffect(() => {
    const controller = new AbortController(); void read(controller.signal).catch(reason => { if (!controller.signal.aborted) error.current(reason); });
    return () => controller.abort();
  }, [read, settings.revision]);
  return <div className="pw-chat-settings">{!model ? <p role="status">{copy.LOADING}</p> : model.items.map(row => <div className="pw-chat-setting" key={row.field}><p>{row.line}</p>
    <button className="secondary small" title={row.refusal ?? undefined} disabled={!row.undo || operation.busy} onClick={() => void operation.run(async signal => {
      const request = row.undo; if (!request) return;
      await api(request.path, ProjectWorkSettingsViewSchema, 'POST', request.body, { signal, waitForHub: true });
      await read(signal); changed();
    })}>{model.undoLabel}</button></div>)}</div>;
}
