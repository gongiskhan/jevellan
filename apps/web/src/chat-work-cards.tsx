import { useCallback, useEffect, useRef, useState } from 'react';
import { TaskViewSchema, ProjectSettingsChangeViewSchema, ProjectWorkSettingsViewSchema, type ProjectSettingsChangeView, type ProjectSettingsChange, type ProjectWorkSettings, type ProjectChatCardContext, type ProjectChatCardInteraction } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask } from './components.js';
import { ThreadCard } from './thread-card.js';
import * as copy from './project-work-copy.js';
import type { ChatItem } from './project-work-model.js';

export function ChatWorkCards({ item, projectId, cardContext, startAll, navigate, changed, onError }: {
  item: Extract<ChatItem, { kind: 'routed' }>; projectId: string; cardContext: ProjectChatCardContext;
  startAll: string[]; navigate(path: string): void; changed(): void; onError(error: unknown): void;
}) {
  const operation = useTask(onError), model = cardContext.interaction(item, startAll), batch = model.batch;
  const perform = async (command: ProjectChatCardInteraction['rows'][number]['start'], signal: AbortSignal) => {
    if (command) await api(`/api/projects/${command.projectId}/tasks/${command.taskId}/command`, TaskViewSchema, 'POST', command, { signal, waitForHub: true });
  };
  const run = (command: ProjectChatCardInteraction['rows'][number]['start']) => void operation.run(async signal => { await perform(command, signal); changed(); });
  return <div className="pw-chat-work-cards">
    {model.messageText && <p className="muted">{model.messageText}</p>}
    {model.rows.map(row => <ThreadCard key={row.id} projectId={projectId} task={row.task ?? undefined} thread={row.thread ?? undefined} presentation={row.card}
      navigate={navigate} changed={changed} onError={onError} busy={operation.busy} start={() => run(row.start)} dismiss={() => run(row.dismiss)} />)}
    {batch && <button className="secondary" disabled={operation.busy} onClick={() => void operation.run(async signal => {
      try { for (const command of batch.commands) await perform(command, signal); } finally { changed(); }
    })}>{batch.label}</button>}
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
