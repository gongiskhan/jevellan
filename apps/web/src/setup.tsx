import { useEffect, useRef, useState } from 'react';
import { FirstRunViewSchema, FirstRunNavigationSchema, FIRST_RUN_LOADING, type FirstRunView } from '@jevellan/core/client';
import { api } from './api.js';
import { useTask, type PageProps } from './components.js';
import { JevConnection } from './jev-connection.js';
import { RuntimesPage } from './runtimes.js';
import { ProjectsPage } from './projects.js';
import { NewConversation } from './conversations.js';

/** The engine supplies progress and navigation; browser code binds transport and embedded renderers. */
export function SetupPage(props: PageProps & { path: string }) {
  const selected = new URLSearchParams(props.path.split('?')[1]).get('step');
  const [view, setView] = useState<FirstRunView>();
  const selection = useRef(selected), callbacks = useRef(props); callbacks.current = props;
  const task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    if (selection.current !== selected) { selection.current = selected; setView(undefined); }
    const query = selected === null ? '' : `?step=${encodeURIComponent(selected)}`;
    void api('/api/setup/progress' + query, FirstRunViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(next => { if (!controller.signal.aborted) setView(next); })
      .catch(error => { if (!controller.signal.aborted) callbacks.current.onError(error); });
    return () => controller.abort();
  }, [selected, props.data]);
  const next = () => void task.run(async signal => {
    if (!view?.actions.next) return;
    const result = await api(view.actions.next.request.path, FirstRunNavigationSchema, 'POST', view.actions.next.request.body, { signal, waitForHub: true });
    signal.throwIfAborted(); setView(result.view);
    if (result.allowed && result.path) props.navigate(result.path);
    else throw new Error(result.refusal!);
  });
  return !view ? <p role="status">{FIRST_RUN_LOADING}</p> : <section className="setup" aria-label="First-run setup">
    <ol className="setup-progress" aria-label="Setup progress">{view.steps.map(entry => <li key={entry.id} aria-current={entry.id === view.current.id ? 'step' : undefined}><span>{entry.number}</span>{entry.label}</li>)}</ol>
    <p className="setup-count">{view.positionLabel}</p><h1>{view.current.title}</h1><p className="intro">{view.current.explanation}</p>
    {view.current.id === 'jev' ? <JevConnection {...props} /> : view.current.id === 'account' ? <RuntimesPage {...props} embedded /> : view.current.id === 'project' ? <ProjectsPage {...props} embedded /> : <NewConversation {...props} embedded />}
    <div className="setup-actions">
      {view.actions.back && <button type="button" className="secondary" disabled={task.busy} onClick={() => props.navigate(view.actions.back!.path)}>{view.actions.back.label}</button>}
      {view.actions.skip && <button type="button" className="secondary" disabled={task.busy} onClick={() => props.navigate(view.actions.skip!.path)}>{view.actions.skip.label}</button>}
      {view.actions.next && <button type="button" disabled={task.busy || !view.actions.next.enabled} onClick={next}>{view.actions.next.label}</button>}
    </div>
    {view.hint && <p className="muted small-text">{view.hint}</p>}
  </section>;
}
