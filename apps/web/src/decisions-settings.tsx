import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigRevisionSchema, DecisionsSettingsEditorSchema, type DecisionsSettingsEditor, type DecisionsSettingsFields, type DecisionsSettingsPreview } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';
import { SectionHeading, useTask, type PageProps } from './components.js';
import { JevConnection } from './jev-connection.js';

export function DecisionsPage(props: PageProps) {
  const task = useTask(props.onError), [view, setView] = useState<DecisionsSettingsEditor>(), [draft, setDraft] = useState<DecisionsSettingsPreview>();
  const [previewing, setPreviewing] = useState(false), [previewError, setPreviewError] = useState(false), [pendingSave, setPendingSave] = useState<NonNullable<DecisionsSettingsEditor['saveRequest']>>();
  const [evidenceRevision, setEvidenceRevision] = useState(0), epoch = useRef(0);
  const evidenceChanged = useCallback(() => setEvidenceRevision(value => value + 1), []);
  const accept = useCallback((value: DecisionsSettingsEditor) => { epoch.current++; setView(value); setDraft(value.preview.request); setPreviewError(false); setPreviewing(false); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/config/decisions', DecisionsSettingsEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(accept).catch(error => { if (!isCancelled(error)) props.onError(error); });
    return () => controller.abort();
  }, [accept, props.onError]);
  useEffect(() => {
    if (!draft) return;
    const controller = new AbortController(), requestEpoch = ++epoch.current; setPreviewing(true); setPreviewError(false);
    const timer = setTimeout(() => {
      void api('/api/config/decisions/preview', DecisionsSettingsEditorSchema, 'POST', draft, { signal: controller.signal, waitForHub: true }).then(value => {
        if (requestEpoch === epoch.current) { setView(value); setPreviewing(false); }
      }).catch(error => {
        if (!isCancelled(error) && requestEpoch === epoch.current) { setPreviewError(true); setPreviewing(false); props.onError(error); }
      });
    }, 100);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [draft, props.data.config.revision, props.data.jev, evidenceRevision, props.onError]);
  const change = (update: (fields: DecisionsSettingsFields) => void) => {
    setPreviewing(true); epoch.current++;
    setDraft(current => { if (!current) return current; const fields = structuredClone(current.fields); update(fields); return { ...current, fields }; });
  };
  const reload = async (signal: AbortSignal) => {
    const latest = await api('/api/config/decisions', DecisionsSettingsEditorSchema, 'GET', undefined, { signal, waitForHub: true }); accept(latest); setPendingSave(undefined);
  };
  const command = (value: NonNullable<DecisionsSettingsPreview['command']>) => {
    if (!draft) return;
    void task.run(async signal => {
      epoch.current++; setPreviewing(true);
      try { accept(await api('/api/config/decisions/preview', DecisionsSettingsEditorSchema, 'POST', { ...draft, command: value }, { signal, waitForHub: true })); }
      catch (error) { if (!signal.aborted) { setPreviewError(true); setPreviewing(false); } throw error; }
    });
  };
  const save = (request: NonNullable<DecisionsSettingsEditor['saveRequest']>) => {
    void task.run(async signal => {
      try {
        await api('/api/config/decisions', ConfigRevisionSchema, 'PUT', request, { signal, waitForHub: true });
        await props.reload(signal); await reload(signal); props.message('Decisions settings saved.');
      } catch (error) { if (!signal.aborted) setPendingSave(request); throw error; }
    });
  };
  const disabled = task.busy || !!pendingSave;
  return <>
    <SectionHeading title="Decisions" />
    <p className="intro">Jev chooses each next step from the models and guidance you give it.</p>
    <JevConnection {...props} changed={evidenceChanged} />
    {!view || !draft ? <p>Loading decisions settings…</p> : <form onSubmit={event => { event.preventDefault(); if (!disabled && !previewing && !previewError && view.canSave && view.saveRequest) save(view.saveRequest); }}>
      {view.staleNotice && <div className="notice"><p>{view.staleNotice}</p><button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(reload)}>Reload latest decisions settings</button></div>}
      {pendingSave && <div className="notice"><p>The save was not confirmed. Retry the same save to recover its result.</p><button type="button" disabled={task.busy} onClick={() => save(pendingSave)}>Retry save</button>{!view.staleNotice && <button type="button" className="secondary" disabled={task.busy} onClick={() => void task.run(reload)}>Reload latest decisions settings</button>}</div>}
      {previewError && <button type="button" className="secondary" onClick={evidenceChanged}>Refresh choices</button>}
      <section className="card">
        <h2>Model menu</h2>
        <label className="compact-label">Jev model<input required disabled={disabled} value={draft.fields.model} onChange={event => change(fields => { fields.model = event.target.value; })} /></label>
        {draft.fields.menu.map((model, index) => {
          const row = view.rows.find(row => row.id === model.id);
          return <div className="menu-model" key={model.id}>
            <div className="menu-model-heading"><label className="toggle"><input type="checkbox" checked={model.enabled} disabled={disabled || !row?.canToggle} onChange={event => change(fields => { fields.menu[index]!.enabled = event.target.checked; })} /><span>Enabled</span></label>
              <label>Label<input required disabled={disabled} value={model.label} onChange={event => change(fields => { fields.menu[index]!.label = event.target.value; })} /></label>
              <div><span className="muted">{row?.runtime}</span><code>{row?.model}</code></div>
            </div>
            <p className="muted small-text">{row?.reasonLine}</p>
            <label>Description<textarea required disabled={disabled} rows={2} value={model.description} onChange={event => change(fields => { fields.menu[index]!.description = event.target.value; })} /></label>
          </div>;
        })}
        {view.canAdd && <label>Add an offered model<select value="" disabled={disabled || previewing} onChange={event => command({ kind: 'add-model', offerKey: event.target.value })}><option value="" disabled>Choose a model</option>{view.candidates.map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label} · {candidate.runtime}</option>)}</select></label>}
        {view.addRefusal && <p className="notice">{view.addRefusal}</p>}
      </section>
      <section className="card"><h2>Effort guide</h2>
        {view.guide.differsFromSuggested && <div className="notice"><p>{view.guide.notice}</p><button type="button" className="secondary small" disabled={disabled || previewing} onClick={() => command({ kind: 'reset-effort-guide' })}>Use suggested effort guide</button></div>}
        {view.guide.efforts.map(effort => <label key={effort} className="effort-line"><span>{effort}</span><textarea required disabled={disabled} rows={3} value={draft.fields.effortGuide[effort]} onChange={event => change(fields => { fields.effortGuide[effort] = event.target.value; })} /></label>)}
      </section>
      <section className="card"><h2>Routing profile</h2><label><span className="sr-only">Routing profile</span><textarea required disabled={disabled} rows={12} value={draft.fields.routingProfile} onChange={event => change(fields => { fields.routingProfile = event.target.value; })} /></label></section>
      <section className="card"><h2>Guards</h2><div className="form-grid">
        {view.guardFields.map(field => <label key={field.key}>{field.label}<input type="number" disabled={disabled} min={field.min} step={field.step} required={field.required} placeholder={field.placeholder} value={draft.fields.guards[field.key]} onChange={event => change(fields => { fields.guards[field.key] = event.target.value; })} /></label>)}
      </div><label className="toggle"><input type="checkbox" disabled={disabled} checked={draft.fields.guards.pauseAfterPlan} onChange={event => change(fields => { fields.guards.pauseAfterPlan = event.target.checked; })} />Pause after a plan</label></section>
      {view.validation.length > 0 && <div className="notice" role="status">{view.validation.map(issue => <p key={issue.path}>{issue.message}</p>)}</div>}
      <div className="sticky-actions"><span className="muted">Saving creates a configuration revision.</span><button disabled={disabled || previewing || previewError || !view.canSave}>{task.busy ? 'Saving…' : 'Save decisions settings'}</button></div>
    </form>}
  </>;
}
