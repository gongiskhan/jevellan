import { useEffect, useRef, useState } from 'react';
import { DeliverySchema, ProjectLandingEditorSchema, type ProjectLandingEditor, type ProjectLandingEditorFields, type ProjectWorkSettings } from '@jevellan/core/client';
import { api, isCancelled } from './api.js';

/** Raw controls stay local; the engine supplies normalization, constraints and save eligibility. */
export function LandingSettings({ value, change, ready, onError }: { value: ProjectWorkSettings; change(patch: Partial<ProjectWorkSettings>): void; ready(value: boolean): void; onError(error: unknown): void }) {
  const [model, setModel] = useState<ProjectLandingEditor>(), [fields, setFields] = useState<ProjectLandingEditorFields>();
  const [pending, setPending] = useState(true), [error, setError] = useState('');
  const active = useRef<AbortController | undefined>(undefined), raw = useRef<ProjectLandingEditorFields | undefined>(undefined);
  const callbacks = useRef({ value, change, ready, onError }); callbacks.current = { value, change, ready, onError };
  const path = `/api/projects/${value.projectId}/config/landing-editor`;
  const apply = (next: ProjectLandingEditor) => {
    setModel(next); setFields(next.fields); raw.current = next.fields;
    if (next.patch) callbacks.current.change(next.patch);
    callbacks.current.ready(next.apply.enabled); setPending(false); setError('');
  };
  const applyRef = useRef(apply); applyRef.current = apply;
  const load = () => {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setPending(true); callbacks.current.ready(false);
    void api(path, ProjectLandingEditorSchema, 'POST', { schema: 'project-landing-editor-request-v1', settings: callbacks.current.value,
      ...(raw.current ? { fields: raw.current } : {}) }, { signal: controller.signal, waitForHub: true }).then(next => {
      if (!controller.signal.aborted && active.current === controller) applyRef.current(next);
    }).catch(reason => { if (!isCancelled(reason) && !controller.signal.aborted) { setPending(false); setError(reason instanceof Error ? reason.message : 'Could not read landing settings.'); callbacks.current.onError(reason); } });
  };
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    loadRef.current();
    return () => { active.current?.abort(); callbacks.current.ready(true); };
  }, [path, value.revision]);
  const edit = (patch: Partial<ProjectLandingEditorFields>) => {
    if (!model || !raw.current) return;
    const next = { ...raw.current, ...patch }; raw.current = next; setFields(next); setPending(true); callbacks.current.ready(false); setError('');
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    void api(model.request.previewPath, ProjectLandingEditorSchema, 'POST', { ...model.request.base, fields: next }, { signal: controller.signal, waitForHub: true }).then(result => {
      if (!controller.signal.aborted && active.current === controller) applyRef.current(result);
    }).catch(reason => { if (!isCancelled(reason) && !controller.signal.aborted) { setPending(false); setError(reason instanceof Error ? reason.message : 'Could not preview landing settings.'); callbacks.current.onError(reason); } });
  };
  const check = (index: number, patch: Partial<ProjectLandingEditorFields['checks'][number]>) => {
    if (raw.current) edit({ checks: raw.current.checks.map((row, at) => at === index ? { ...row, ...patch } : row) });
  };
  return <>
    {!model || !fields ? <p role="status">Loading landing settings…</p> : <>
      <label>Delivery<select value={fields.delivery} onChange={event => edit({ delivery: DeliverySchema.parse(event.target.value) })}>{model.deliveryChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
      <label className="checkbox"><input type="checkbox" checked={fields.autoLand} onChange={event => edit({ autoLand: event.target.checked })} />Land automatically</label>
      <p className="pw-field-note">{model.routeHelp}</p>
      <fieldset><legend>Landing checks</legend>{fields.checks.map((row, index) => <fieldset key={index}><legend>Check {index + 1}</legend>
        <label>Name<input required maxLength={model.limits.name} value={row.name} onChange={event => check(index, { name: event.target.value })} /></label>
        <label>Paths<textarea aria-label="Paths" value={row.paths} onChange={event => check(index, { paths: event.target.value })} /></label>
        <p className="pw-field-note">{model.pathsHelp}</p>
        <label>Command<textarea aria-label="Command" required maxLength={model.limits.command} value={row.command} onChange={event => check(index, { command: event.target.value })} /></label>
        <button type="button" className="secondary small" onClick={() => edit({ checks: fields.checks.filter((_, at) => at !== index) })}>Remove check</button>
      </fieldset>)}<button type="button" className="secondary small" disabled={pending || !model.canAddCheck} onClick={() => edit({ checks: [...fields.checks, model.newCheck] })}>Add landing check</button></fieldset>
      <label>Smoke check<textarea aria-label="Smoke check" maxLength={model.limits.smokeCheck} value={fields.smokeCheck} onChange={event => edit({ smokeCheck: event.target.value })} /></label><p className="pw-field-note">{model.smokeHelp}</p>
      <label>Managed localhost ports<textarea aria-label="Managed localhost ports" maxLength={model.limits.ports} value={fields.ports ?? ''} onChange={event => edit({ ports: event.target.value })} /></label><p className="pw-field-note">{model.portsHelp}</p>
      <label>Keep commits for these paths<textarea aria-label="Keep commits for these paths" value={fields.mergeCommitPaths} onChange={event => edit({ mergeCommitPaths: event.target.value })} /></label><p className="pw-field-note">{model.mergeHelp}</p>
      {model.apply.errors.map((issue, index) => <p className="error" role="status" key={index}>{issue.label}: {issue.message}</p>)}
    </>}
    {error && <><p className="error" role="alert">{error}</p><button type="button" className="secondary" disabled={pending} onClick={() => loadRef.current()}>Reload landing settings</button></>}
  </>;
}
