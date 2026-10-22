import { useEffect, useRef, useState } from 'react';
import { SetupProposalEditorSchema, SetupEditorReceiptSchema, setupEditorPolicy, setupProposalEdit, setupProposalUi, setupProposalAttempt, setupProposalAccepted } from '@jevellan/core/client';
import { ApiError, api, isCancelled } from './api.js';
import { clientId } from './client-id.js';
import { useTask } from './components.js';
type Editor = ReturnType<typeof SetupProposalEditorSchema.parse>;
type Attempt = ReturnType<typeof setupProposalAttempt>;
export function SetupCard({ projectId, proposalId, changed, onError }: { projectId: string; proposalId: string; changed(): void; onError(error: unknown): void }) {
  const path = `/api/projects/${projectId}/setup-proposals/${proposalId}/editor`, [editor, setEditor] = useState<Editor>(), [reload, setReload] = useState(0);
  const current = useRef(path); current.current = path;
  const pending = useRef<Attempt | null>(null), error = useRef(onError); error.current = onError;
  const operation = useTask(onError), policy = editor?.policy ?? setupEditorPolicy();
  const model = editor?.projectId === projectId && editor.proposalId === proposalId ? setupProposalUi(editor, { ...editor.ui, busy: operation.busy }) : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void api(path, SetupProposalEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(value => {
      if (current.current !== path || controller.signal.aborted) return;
      if (value.projectId !== projectId || value.proposalId !== proposalId) throw new Error('The setup editor belongs to another proposal.');
      pending.current = null; setEditor(value);
    }).catch(reason => { if (!isCancelled(reason)) error.current(reason); });
    return () => controller.abort();
  }, [path, projectId, proposalId, reload]);
  const act = (action: 'apply' | 'dismiss') => void operation.run(async signal => {
    if (!model) return;
    const attempt = setupProposalAttempt(pending.current, model, action, `setup_${clientId()}`); pending.current = attempt;
    try {
      const receipt = await api(attempt.path, SetupEditorReceiptSchema, 'POST', attempt.command, { signal, waitForHub: true });
      const next = setupProposalAccepted(attempt, receipt, { projectId, proposalId });
      if (current.current !== path) return;
      pending.current = null; setEditor(next); changed();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && current.current === path) setEditor(value => value ? setupProposalUi(value, { ...value.ui, stale: reason.message }) : value);
      throw reason;
    }
  });
  const edit = (event: Parameters<typeof setupProposalEdit>[1]) => setEditor(value => value ? setupProposalEdit(value, event) : value);
  return <article className="pw-setup-card" aria-label={policy.title}><h3>{policy.title}</h3>
    {!model ? <p role="status">{policy.loading}</p> : model.state === 'applied' ? <><p role="status">{model.appliedLine}</p>{model.followUp && <p>{model.followUp}</p>}</>
      : model.state === 'dismissed' ? <p role="status">{policy.dismissedLabel}</p> : <>
        {model.items.map(item => <div className="pw-setup-item" key={item.index}><label className="check-label"><input type="checkbox" checked={item.selected} disabled={model.ui.busy} onChange={event => edit({ schema: 'setup-editor-event-v1', type: 'selection', index: item.index, checked: event.target.checked })} />{item.label}</label>
          <textarea aria-label={item.label} maxLength={policy.valueMax} value={item.value} disabled={model.ui.busy} onChange={event => edit({ schema: 'setup-editor-event-v1', type: 'value', index: item.index, value: event.target.value })} />
          {item.note && <p className="muted">{item.note}</p>}</div>)}
        {model.actions.reloadVisible && <p className="notice" role="status">{model.ui.stale} <button className="secondary" onClick={() => setReload(value => value + 1)}>{policy.reloadLabel}</button></p>}
        <div className="actions"><button disabled={!model.actions.applyEnabled} onClick={() => act('apply')}>{policy.applyLabel}</button><button className="secondary" disabled={!model.actions.dismissEnabled} onClick={() => act('dismiss')}>{policy.dismissLabel}</button></div>
      </>}
  </article>;
}
