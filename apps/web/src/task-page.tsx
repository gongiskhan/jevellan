import { useEffect, useState } from 'react';
import { ProjectWorkViewSchema, TaskViewSchema, type ProjectWorkTask, type ProjectWorkView } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { Markdown, type PageProps } from './components.js';
import { MergeWhy } from './merge-route.js';

export function TaskPage({ projectId, taskId, navigate, onError }: PageProps & { projectId: string; taskId: string }) {
  const [task, setTask] = useState<ProjectWorkTask>(), [project, setProject] = useState<ProjectWorkView>();
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [read, work] = await Promise.all([api(`/api/projects/${projectId}/tasks/${taskId}`, TaskViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }), api(`/api/projects/${projectId}/work`, ProjectWorkViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })]);
        setTask(read.task); setProject(work);
      } catch (error) { if (!isCancelled(error)) onError(error); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectId, taskId, onError]);
  const thread = project?.threads.find(row => row.id === task?.threadId);
  return <section className="pw-section"><button className="text-button" onClick={() => navigate(`/projects/${projectId}`)}>Back to project</button>
    {!task ? <p>Loading task…</p> : <><h2>{task.title}</h2><p className="muted">{task.type} · {task.state}</p><Markdown>{task.brief}</Markdown>
      {task.endNote && <p>{task.endNote}</p>}
      {thread?.pr && <article className="pw-pr"><a href={thread.pr.url} target="_blank" rel="noopener noreferrer">#{thread.pr.number} · {thread.pr.state}</a>
        <div className="pw-pr-actions"><MergeWhy projectId={projectId} threadId={thread.id} commit={thread.pr.headSha} /></div></article>}
      {task.threadId && <button className="secondary small" onClick={() => navigate(`/projects/${projectId}/threads/${task.threadId}`)}>Open thread</button>}
    </>}
  </section>;
}
