import { useEffect, useState } from 'react';
import { ProjectTaskPageViewSchema, projectTaskPagePolicy, projectTaskPageBack, type ProjectTaskPageView } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { Markdown, type PageProps } from './components.js';
import { MergeWhy } from './merge-route.js';

export function TaskPage({ projectId, taskId, navigate, onError }: PageProps & { projectId: string; taskId: string }) {
  const [view, setView] = useState<ProjectTaskPageView>();
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        setView(await api(`/api/projects/${projectId}/tasks/${taskId}/page-view`, ProjectTaskPageViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }));
      } catch (error) { if (!isCancelled(error)) onError(error); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, projectTaskPagePolicy.pollHintMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [projectId, taskId, onError]);
  const back = projectTaskPageBack(projectId), pr = view?.pullRequest;
  return <section className="pw-section"><button className="text-button" onClick={() => navigate(back.href)}>{back.label}</button>
    {!view ? <p>{projectTaskPagePolicy.loadingLabel}</p> : <><h2>{view.task.title}</h2><p className="muted">{view.meta}</p><Markdown>{view.task.brief}</Markdown>
      {view.task.endNote && <p>{view.task.endNote}</p>}
      {pr && <article className="pw-pr"><a href={pr.url} target="_blank" rel="noopener noreferrer">{pr.label}</a>
        <div className="pw-pr-actions"><MergeWhy projectId={projectId} threadId={pr.threadId} commit={pr.headSha} /></div></article>}
      {view.threadLink && <button className="secondary small" onClick={() => navigate(view.threadLink!.href)}>{view.threadLink.label}</button>}
    </>}
  </section>;
}
