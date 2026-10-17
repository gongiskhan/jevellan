import { clientId } from './client-id.js';
import { useState } from 'react';
import { TaskViewSchema, ProjectWorkSettingsViewSchema, undoProjectSetting, type ProjectSettingsChange, type ProjectWorkSettings, type ProjectWorkTask, type ThreadIndex } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask } from './components.js';
import { ThreadCard } from './thread-card.js';
import * as copy from './project-work-copy.js';
import type { ChatItem } from './project-work-model.js';

export function ChatWorkCards({ item, projectId, tasks, threads, startAll, deviceName, navigate, changed, onError }: {
  item: Extract<ChatItem, { kind: 'routed' }>; projectId: string; tasks: readonly ProjectWorkTask[]; threads: readonly ThreadIndex[];
  startAll: string[]; deviceName(id: string): string; navigate(path: string): void; changed(): void; onError(error: unknown): void;
}) {
  const operation = useTask(onError);
  const act = async (task: ProjectWorkTask, dismiss = false, signal?: AbortSignal) => {
    if (task.state === 'draft') await api(`/api/projects/${projectId}/tasks/${task.id}/action`, TaskViewSchema, 'POST', {
      schema: 'task-action-request-v1', expectedRevision: task.revision, action: dismiss ? 'reject' : 'approve', ...(dismiss ? { reason: copy.DISMISSED_CHAT } : {}),
    }, { signal, waitForHub: true });
    else if (task.held) await api(`/api/projects/${projectId}/tasks/${task.id}/edit`, TaskViewSchema, 'POST', { schema: 'task-update-request-v1', expectedRevision: task.revision, held: false }, { signal, waitForHub: true });
  };
  const run = (task: ProjectWorkTask, dismiss = false) => void operation.run(async signal => { await act(task, dismiss, signal); changed(); });
  const rows = item.taskIds?.map(id => { const task = tasks.find(task => task.id === id); return { id, task, thread: threads.find(thread => thread.id === task?.threadId) }; })
    ?? [{ id: item.threadId!, task: tasks.find(task => task.threadId === item.threadId), thread: threads.find(thread => thread.id === item.threadId) }];
  return <div className="pw-chat-work-cards">
    {item.message && <p className="muted">{copy.SENT_MESSAGE_CARD}</p>}
    {rows.map(row => <ThreadCard key={row.id} projectId={projectId} task={row.task} thread={row.thread} position={row.task ? tasks.filter(task => task.state === 'queued').findIndex(task => task.id === row.task!.id) + 1 : undefined}
      deviceName={deviceName} navigate={navigate} busy={operation.busy} start={task => run(task)} dismiss={task => run(task, true)} />)}
    {startAll.length > 0 && <button className="secondary" disabled={operation.busy} onClick={() => void operation.run(async signal => {
      try { for (const id of startAll) { const task = tasks.find(task => task.id === id); if (task?.state === 'draft') await act(task, false, signal); } } finally { changed(); }
    })}>{copy.startAllCards(startAll.length)}</button>}
  </div>;
}

export function ChatSettingsChanges({ projectId, change, settings, changed, onError }: { projectId: string; change: ProjectSettingsChange; settings: ProjectWorkSettings; changed(): void; onError(error: unknown): void }) {
  const operation = useTask(onError), [undone, setUndone] = useState<string[]>([]), [ids] = useState(clientId);
  return <div className="pw-chat-settings">{change.changes.map(value => {
    const restored = undoProjectSetting(settings, value), disabled = !restored || undone.includes(value.field);
    return <div className="pw-chat-setting" key={value.field}><p>{copy.settingChangeLine(value)}</p>
      <button className="secondary small" title={disabled ? copy.CHANGED_AGAIN : undefined} disabled={disabled || operation.busy} onClick={() => void operation.run(async signal => {
        if (!restored) return;
        await api(`/api/projects/${projectId}/work-settings/undo`, ProjectWorkSettingsViewSchema, 'POST', { schema: 'project-settings-undo-request-v1', expectedRevision: settings.revision, clientRequestId: `undo_${ids}_${value.field.replaceAll('.', '_')}_${settings.revision}`, change: value }, { signal, waitForHub: true });
        setUndone(previous => [...previous, value.field]); changed();
      })}>{copy.UNDO_SETTING}</button></div>;
  })}</div>;
}
