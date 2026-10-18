import { useEffect, useRef, useState } from 'react';
import { SetupProposalViewSchema } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { useTask } from './components.js';
import * as copy from './project-work-copy.js';
type View = ReturnType<typeof SetupProposalViewSchema.parse>;
export function SetupCard({ projectId, proposalId, changed, onError }: { projectId: string; proposalId: string; changed(): void; onError(error: unknown): void }) {
  const path = `/api/projects/${projectId}/setup-proposals/${proposalId}`, [view, setView] = useState<View>(), [values, setValues] = useState<string[]>([]), [selected, setSelected] = useState<number[]>([]), [reload, setReload] = useState(0), [stale, setStale] = useState(false);
  const error = useRef(onError); error.current = onError; const operation = useTask(onError);
  useEffect(() => {
    const controller = new AbortController();
    void api(path, SetupProposalViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(value => {
      setView(value); setValues(value.proposal.items.map(item => item.value)); setSelected(value.proposal.items.map((_, index) => index)); setStale(false);
    }).catch(reason => { if (!isCancelled(reason)) error.current(reason); });
    return () => controller.abort();
  }, [path, reload]);
  const act = (action: 'apply' | 'dismiss') => void operation.run(async signal => {
    if (!view) return;
    try {
      const next = await api(`${path}/actions`, SetupProposalViewSchema, 'POST', { schema: 'setup-action-request-v1', clientRequestId: `setup_${clientId()}`, expectedRevision: view.proposal.revision, action,
        ...(action === 'apply' ? { settingsRevision: view.settingsRevision, projectRevision: view.projectRevision, selected: selected.map(index => ({ index, value: values[index] })) } : {}) }, { signal, waitForHub: true });
      setView(next); changed();
    } catch (reason) { if (reason && typeof reason === 'object' && 'status' in reason && reason.status === 409) setStale(true); throw reason; }
  });
  const proposal = view?.proposal;
  return <article className="pw-setup-card" aria-label={copy.SUGGESTED_SETUP}><h3>{copy.SUGGESTED_SETUP}</h3>
    {!proposal ? <p role="status">{copy.LOADING}</p> : proposal.appliedAt ? <><p role="status">{copy.setupApplied(proposal.applied?.length ?? 0)}</p>
      {proposal.items.some((item, index) => proposal.applied?.includes(index) && ['variables', 'secrets'].includes(item.key)) && <p>{copy.SETUP_FILL_VALUES}</p>}</>
      : proposal.dismissedAt ? <p role="status">{copy.SETUP_DISMISSED}</p> : <>
        {proposal.items.map((item, index) => {
          const label = item.key === 'goal' ? copy.setupGoalLabel(values[index] ?? item.value) : copy.SETUP_LABELS[item.key];
          return <div className="pw-setup-item" key={index}><label className="check-label"><input type="checkbox" checked={selected.includes(index)} disabled={operation.busy} onChange={event => setSelected(rows => event.target.checked ? [...rows, index] : rows.filter(row => row !== index))} />{label}</label>
            <textarea aria-label={label} maxLength={16000} value={values[index] ?? ''} disabled={operation.busy} onChange={event => setValues(rows => rows.map((value, i) => i === index ? event.target.value : value))} />
            {item.note && <p className="muted">{item.note}</p>}</div>;
        })}
        {stale && <p className="notice" role="status">{copy.SETTINGS_CONFLICT} <button className="secondary" onClick={() => setReload(value => value + 1)}>{copy.RELOAD}</button></p>}
        <div className="actions"><button disabled={operation.busy || stale || !selected.length || selected.some(index => !values[index]?.trim())} onClick={() => act('apply')}>{copy.APPLY_SETUP}</button><button className="secondary" disabled={operation.busy || stale} onClick={() => act('dismiss')}>{copy.SETUP_NOT_NOW}</button></div>
      </>}
  </article>;
}
