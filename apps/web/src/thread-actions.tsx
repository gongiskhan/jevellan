import { useContext, useEffect, useState } from 'react';
import { MergeResultViewSchema, ProjectThreadActionsViewSchema, ThreadViewSchema, type ProjectThreadActionsView, type ThreadActionItem, type ThreadActionRequest, type ThreadIndex } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, useTask } from './components.js';
import { PROJECT_WORK_UPDATED } from './project-work-model.js';
import { ProjectCardsContext, projectCardKey } from './project-cards.js';
import * as copy from './project-work-copy.js';

type ConfirmationItem = Exclude<ThreadActionItem, { kind: 'link' }>;

/** Executes the engine's owner-action view; mutation services still enforce their own current guards. */
export function ThreadActions({ projectId, thread, presentation, changed, onError }: { projectId: string; thread: ThreadIndex; presentation?: ProjectThreadActionsView | undefined; changed?: (() => void) | undefined; onError?: ((error: unknown) => void) | undefined }) {
  const cards = useContext(ProjectCardsContext), model = presentation ?? cards.get(projectCardKey('thread', thread.id))?.threadActions;
  const [error, setError] = useState(''), [confirm, setConfirm] = useState<ConfirmationItem>();
  const [mergeConfirmation, setMergeConfirmation] = useState<ProjectThreadActionsView['mergeConfirmation']>(), [loadingMerge, setLoadingMerge] = useState(false);
  const operation = useTask(failure => { setError(failure instanceof Error ? failure.message : String(failure)); onError?.(failure); });
  useEffect(() => {
    setMergeConfirmation(undefined);
    if (confirm?.kind !== 'merge') { setLoadingMerge(false); return; }
    const controller = new AbortController();
    api(`/api/projects/${projectId}/threads/${thread.id}/actions-view`, ProjectThreadActionsViewSchema, 'GET', undefined, { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setMergeConfirmation(next.mergeConfirmation); }, () => undefined)
      .finally(() => { if (!controller.signal.aborted) setLoadingMerge(false); });
    return () => controller.abort();
  }, [confirm?.kind, projectId, thread.id]);
  const refresh = () => { changed?.(); window.dispatchEvent(new Event(PROJECT_WORK_UPDATED)); };
  const act = (action: ThreadActionRequest['action']) => void operation.run(async signal => {
    setError(''); await api(`/api/projects/${projectId}/threads/${thread.id}/actions`, ThreadViewSchema, 'POST', { schema: 'thread-action-request-v1', clientRequestId: clientId(), action }, { signal, waitForHub: true });
    setConfirm(undefined); refresh();
  });
  if (!model) return null;
  const confirmation = confirm?.kind === 'merge' ? mergeConfirmation ?? confirm.confirmation : confirm?.confirmation;
  return <>
    <div className="actions pw-thread-actions">
      {model.items.map(item => item.kind === 'link'
        ? <a key={item.id} className="button-link secondary small" href={item.href} target="_blank" rel="noreferrer">{item.label}</a>
        : <button key={item.id} className={item.secondary ? 'secondary small' : 'small'} disabled={operation.busy || !item.enabled} title={item.refusal ?? item.help ?? undefined} onClick={() => {
          if (item.confirmation) { setLoadingMerge(item.kind === 'merge'); setConfirm(item); }
          else if (item.kind === 'mutation') act(item.id);
        }}>{item.label}</button>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {confirm && confirmation && <Confirm title={confirmation.title} action={confirmation.actionLabel} busy={operation.busy || loadingMerge} close={() => setConfirm(undefined)} confirm={() => {
      if (confirm.kind === 'mutation') { act(confirm.id); return; }
      void operation.run(async signal => {
        const result = await api(`/api/projects/${projectId}/threads/${thread.id}/pr/merge`, MergeResultViewSchema, 'POST', empty, { signal });
        if (!result.merged) { setError(result.message ?? copy.MERGE_FAILED); return; }
        setConfirm(undefined); refresh();
      });
    }}><p>{confirmation.body}</p>{error && <p className="error">{error}</p>}</Confirm>}
  </>;
}
