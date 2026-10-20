import { useEffect, useRef, useState } from 'react';
import { ProjectRouteWhyViewSchema, type ProjectRouteCorrectionAction, type ProjectRouteWhyView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal, useTask } from './components.js';
import { RouteWhyDetails } from './route-why-details.js';
export function LandingWhy({ projectId, threadId }: { projectId: string; threadId: string }) {
  const [open, setOpen] = useState(false), [view, setView] = useState<ProjectRouteWhyView>(), [error, setError] = useState('');
  const path = `/api/projects/${projectId}/threads/${threadId}/landing/why-view`, current = useRef(path); current.current = path;
  const operation = useTask(failure => setError(failure instanceof Error ? failure.message : 'The correction could not be saved.'));
  useEffect(() => {
    if (!open) return; const controller = new AbortController(); setView(undefined); setError('');
    void api(path, ProjectRouteWhyViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true })
      .then(model => { if (!controller.signal.aborted) setView(model); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The landing route could not be read.'); });
    return () => controller.abort();
  }, [open, path]);
  const correct = (action: ProjectRouteCorrectionAction) => {
    const requested = path;
    void operation.run(async signal => { const model = await api(action.request.path, ProjectRouteWhyViewSchema, 'POST', action.request.body, { signal, waitForHub: true }); if (current.current === requested) { setView(model); setError(''); } });
  };
  return <><button className="text-button" onClick={() => setOpen(true)}>Why this landing</button>{open && <Modal title={view?.title ?? 'Why this landing'} close={() => setOpen(false)}>
    {error && <p role="status">{error}</p>}{!view && !error && <p>Loading…</p>}
    {view && <RouteWhyDetails view={view} busy={operation.busy} correct={correct} />}
  </Modal>}</>;
}
