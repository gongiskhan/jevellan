import { useEffect, useRef, useState } from 'react';
import { ProjectRouteWhyViewSchema, routeWhyPollPolicy, type ProjectRouteCorrectionAction, type ProjectRouteWhyView } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal, useTask } from './components.js';
import { Icon } from './icons.js';
import { RouteWhyDetails } from './route-why-details.js';

export function MergeWhy({ projectId, threadId, commit, compact = false, buttonLabel = 'Why' }: { projectId: string; threadId: string; commit: string; compact?: boolean; buttonLabel?: string }) {
  const [open, setOpen] = useState(false), [view, setView] = useState<ProjectRouteWhyView>(), [notice, setNotice] = useState(''), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const path = `/api/projects/${projectId}/threads/${threadId}/pr/why-view`, resource = `${path}:${commit}`, current = useRef(resource); current.current = resource;
  const operation = useTask(failure => setError(failure instanceof Error ? failure.message : 'The correction could not be saved.'));
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, delay = routeWhyPollPolicy.mergeMs;
    setView(previous => previous?.projectId === projectId && previous.threadId === threadId && previous.commit === commit ? previous : undefined); setNotice(''); setError('');
    const refresh = async () => {
      try {
        const model = await api(path, ProjectRouteWhyViewSchema, 'POST', { schema: 'project-merge-why-request-v1', commit }, { signal: controller.signal, waitForHub: true });
        if (!controller.signal.aborted) { delay = model.pollHintMs ?? routeWhyPollPolicy.mergeMs; setView(model); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The merge route could not be read.'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, delay); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [path, projectId, threadId, commit, reload]);
  const shown = view?.projectId === projectId && view.threadId === threadId && view.commit === commit ? view : undefined;
  const correct = (action: ProjectRouteCorrectionAction) => {
    const requested = resource;
    void operation.run(async signal => {
      setError(''); const model = await api(action.request.path, ProjectRouteWhyViewSchema, 'POST', action.request.body, { signal, waitForHub: true });
      if (current.current === requested) { setView(model); setNotice(model.savedNotice ?? ''); }
    });
  };
  return <>{shown?.shadowLine && <span className="chip">{shown.shadowLine}</span>}
    <button type="button" className={compact ? 'icon-button' : 'text-button'} aria-label={buttonLabel} title={buttonLabel} onClick={() => { setOpen(true); setReload(value => value + 1); }}>{compact ? <Icon name="why" size={15} /> : buttonLabel}</button>
    {!compact && shown?.correctionActions.map(action => <button key={action.id} type="button" className="text-button" disabled={operation.busy} onClick={() => correct(action)}>{action.label}</button>)}
    {!open && notice && <span role="status">{notice}</span>}
    {open && <Modal title={shown?.title ?? 'Why this merge route'} close={() => setOpen(false)}>
      {error && <p role="alert">{error}</p>}{!shown && !error && <p>Loading…</p>}
      {shown && <RouteWhyDetails view={shown} busy={operation.busy} correct={correct} notice={notice} />}
    </Modal>}
  </>;
}
