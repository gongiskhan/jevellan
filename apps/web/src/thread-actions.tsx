import { createContext, useContext, useState } from 'react';
import { MergeResultViewSchema, ThreadViewSchema, type ThreadActionRequest, type ThreadIndex } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, useTask } from './components.js';
import { mergeBlock, PROJECT_WORK_UPDATED } from './project-work-model.js';
import * as copy from './project-work-copy.js';

export const ThreadMergeHoldContext = createContext<{ held: boolean; allowed: readonly string[] } | undefined>(undefined);

/** The same owner actions in chat cards, Overview and the thread header. */
export function ThreadActions({ projectId, thread, changed, onError, hold }: { projectId: string; thread: ThreadIndex; hold?: boolean | undefined; changed?: (() => void) | undefined; onError?: ((error: unknown) => void) | undefined }) {
  const projectHold = useContext(ThreadMergeHoldContext);
  const held = hold ?? (projectHold ? projectHold.held && !projectHold.allowed.includes(thread.id) : thread.landing === 'held');
  const [error, setError] = useState(''), [confirm, setConfirm] = useState<'merge' | 'resolve'>();
  const operation = useTask(failure => { setError(failure instanceof Error ? failure.message : String(failure)); onError?.(failure); });
  const refresh = () => { changed?.(); window.dispatchEvent(new Event(PROJECT_WORK_UPDATED)); };
  const act = (action: ThreadActionRequest['action']) => void operation.run(async signal => {
    setError(''); await api(`/api/projects/${projectId}/threads/${thread.id}/actions`, ThreadViewSchema, 'POST', { schema: 'thread-action-request-v1', clientRequestId: clientId(), action }, { signal, waitForHub: true });
    setConfirm(undefined); refresh();
  });
  const open = thread.pr?.state === 'open', resting = !['queued', 'preparing', 'running', 'publishing', 'attached'].includes(thread.state);
  const block = held ? copy.MERGE_HELD : thread.pr ? mergeBlock(thread.pr) : null;
  return <>
    <div className="actions pw-thread-actions">
      {resting && thread.fixable?.checks && <button className="secondary small" disabled={operation.busy} onClick={() => act('fix-checks')}>{copy.FIX_CHECKS}</button>}
      {resting && thread.fixable?.conflicts && <button className="secondary small" disabled={operation.busy} onClick={() => act('resolve-conflicts')}>{copy.RESOLVE_CONFLICTS}</button>}
      {resting && !!thread.fixable?.comments && <button className="secondary small" disabled={operation.busy} onClick={() => act('address-comments')}>{copy.addressComments(thread.fixable.comments)}</button>}
      {open && <button className="small" disabled={operation.busy || !!block || !resting} title={block ?? undefined} onClick={() => setConfirm('merge')}>{copy.MERGE}</button>}
      {thread.pr && <a className="button-link secondary small" href={thread.pr.url} target="_blank" rel="noreferrer">{copy.OPEN_ON_GITHUB}</a>}
      {thread.fixable?.publish && <button className="secondary small" disabled={operation.busy} title={copy.PUBLISH_HELP} onClick={() => act('publish')}>{copy.PUBLISH}</button>}
      {!open && ['idle', 'waiting-for-you', 'failed'].includes(thread.state) && !thread.resolution && <button className="secondary small" disabled={operation.busy} onClick={() => thread.fixable?.publish ? setConfirm('resolve') : act('resolve')}>{copy.RESOLVE}</button>}
      {thread.resolution && ['idle', 'failed'].includes(thread.state) && <button className="secondary small" disabled={operation.busy} onClick={() => act('reopen')}>{copy.REOPEN}</button>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {confirm && <Confirm title={confirm === 'merge' ? copy.mergeTitle(thread.pr!.number) : copy.RESOLVE} action={confirm === 'merge' ? copy.MERGE : copy.RESOLVE} busy={operation.busy} close={() => setConfirm(undefined)} confirm={() => {
      if (confirm === 'resolve') { act('resolve'); return; }
      void operation.run(async signal => {
        const result = await api(`/api/projects/${projectId}/threads/${thread.id}/pr/merge`, MergeResultViewSchema, 'POST', empty, { signal });
        if (!result.merged) { setError(result.message ?? copy.MERGE_FAILED); return; }
        setConfirm(undefined); refresh();
      });
    }}><p>{confirm === 'resolve' ? copy.RESOLVE_COMMITS_CONFIRM : copy.mergeBody(thread.title, copy.BASE_BRANCH)}</p>{error && <p className="error">{error}</p>}</Confirm>}
  </>;
}
