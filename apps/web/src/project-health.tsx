import { useEffect, useRef, useState } from 'react';
import { HealthEditorSchema, HealthHistoryViewSchema, ProjectHealthViewSchema, healthEditor, healthEditorEdit, healthHistoryView, healthHistoryMerge, healthRecentRuns, healthRunRequest,
  type HealthEditor, type HealthEditorCommand, type HealthHistoryView, type ProjectHealthCheck } from '@jevellan/core/client';
import { api } from './api.js';

/** The engine owns draft normalization, limits and result presentation; locale time remains a browser adapter. */
export function ProjectHealthEditor({ projectId, checks, change, ready, fail }: { projectId: string; checks: ProjectHealthCheck[]; change(checks: ProjectHealthCheck[]): void; ready(value: boolean): void; fail(error: unknown): void }) {
  const [model, setModel] = useState<HealthEditor>(), [history, setHistory] = useState<HealthHistoryView>(), [busy, setBusy] = useState<string>(), [adding, setAdding] = useState(false);
  const current = useRef<HealthEditor | undefined>(undefined), runs = useRef<HealthHistoryView | undefined>(undefined), running = useRef(false), addingRef = useRef(false), controller = useRef<AbortController | undefined>(undefined);
  const callbacks = useRef({ checks, change, ready, fail }); callbacks.current = { checks, change, ready, fail };
  const accept = (next: HealthEditor) => { current.current = next; setModel(next); if (next.patch) callbacks.current.change(next.patch); callbacks.current.ready(next.apply.enabled); };
  const merge = (incoming: unknown) => { const merged = healthHistoryMerge(projectId, runs.current?.source.runs ?? [], incoming), view = healthHistoryView({ schema: 'project-health-view-v1', projectId, runs: merged }); runs.current = view; setHistory(view); };
  const acceptRef = useRef(accept), mergeRef = useRef(merge); acceptRef.current = accept; mergeRef.current = merge;
  useEffect(() => {
    const active = new AbortController(); controller.current = active; callbacks.current.ready(false); current.current = undefined; runs.current = undefined; setModel(undefined); setHistory(undefined);
    void api(`/api/projects/${projectId}/config/health-editor`, HealthEditorSchema, 'GET', undefined, { signal: active.signal, waitForHub: true }).then(view => { if (!active.signal.aborted) acceptRef.current(healthEditor(projectId, callbacks.current.checks, view.candidateIds)); }).catch(error => { if (!active.signal.aborted) callbacks.current.fail(error); });
    void api(`/api/projects/${projectId}/health/view`, HealthHistoryViewSchema, 'GET', undefined, { signal: active.signal, waitForHub: true }).then(view => { if (!active.signal.aborted) mergeRef.current(view.source); }).catch(error => { if (!active.signal.aborted) callbacks.current.fail(error); });
    return () => { active.abort(); callbacks.current.ready(true); };
  }, [projectId]);
  const edit = (command: HealthEditorCommand) => { if (current.current) accept(healthEditorEdit(current.current, command)); };
  const add = async () => {
    const captured = current.current, active = controller.current;
    if (!captured || addingRef.current) return;
    const command: HealthEditorCommand = { schema: 'health-editor-command-v1', operation: 'add-check' };
    if (!captured.needsCandidate) { edit(command); return; }
    addingRef.current = true; setAdding(true);
    try {
      const refreshed = await api(`/api/projects/${projectId}/config/health-editor`, HealthEditorSchema, 'POST', { schema: 'health-editor-preview-v1', projectId, fields: captured.fields }, { signal: active!.signal, waitForHub: true });
      if (!active?.signal.aborted && current.current === captured) accept(healthEditorEdit(refreshed, command));
    } catch (error) { if (!active?.signal.aborted) callbacks.current.fail(error); }
    finally { addingRef.current = false; if (!active?.signal.aborted) setAdding(false); }
  };
  const run = async (checkId: string) => {
    if (!current.current || running.current) return;
    const active = controller.current; running.current = true; setBusy(checkId);
    try { const request = healthRunRequest(current.current, checkId), view = await api(`/api/projects/${projectId}/health/run`, ProjectHealthViewSchema, 'POST', request, { signal: active!.signal }); if (!active?.signal.aborted) merge(view); }
    catch (error) { if (!active?.signal.aborted) callbacks.current.fail(error); } finally { running.current = false; if (!active?.signal.aborted) setBusy(undefined); }
  };
  return !model ? <p role="status">Loading health checks…</p> : <>
    <p>{model.notice}</p>
    {model.fields.map((check, checkIndex) => {
      const controls = model.checks[checkIndex]!, update = (patch: { name?: string; enabled?: boolean }) => edit({ schema: 'health-editor-command-v1', operation: 'check', checkId: check.id, patch });
      return <fieldset key={check.id} className="pw-health-check"><legend>Check {checkIndex + 1}</legend>
        <label>Check name<input required maxLength={model.limits.name} value={check.name} onChange={event => update({ name: event.target.value })} /></label>
        <label className="checkbox"><input type="checkbox" checked={check.enabled} onChange={event => update({ enabled: event.target.checked })} />Enabled</label>
        {check.steps.map((step, index) => {
          const patch = (value: Partial<HealthEditor['newStep']>) => edit({ schema: 'health-editor-command-v1', operation: 'step', checkId: check.id, index, patch: value });
          return <fieldset key={index}><legend>Step {index + 1}</legend>
            <label>Step name<input required maxLength={model.limits.name} value={step.name} onChange={event => patch({ name: event.target.value })} /></label>
            <div className="form-grid"><label>Method<select aria-label="Method" value={step.method} onChange={event => patch({ method: model.methods.find(row => row.value === event.target.value)!.value })}>{model.methods.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select></label>
              <label>URL<input type="url" required maxLength={model.limits.url} value={step.url} onChange={event => patch({ url: event.target.value })} /></label></div>
            <label>Expected status codes<input required value={step.expectStatus} onChange={event => patch({ expectStatus: event.target.value })} /></label>
            <label>Expected text (optional)<input maxLength={model.limits.expectBody} value={step.expectBody} onChange={event => patch({ expectBody: event.target.value })} /></label>
            <label>Timeout (ms)<input type="number" min={model.limits.timeout.min} max={model.limits.timeout.max} value={step.timeoutMs} onChange={event => patch({ timeoutMs: event.target.value })} /></label>
            <label>Headers (JSON)<textarea aria-label="Headers (JSON)" value={step.headers} onChange={event => patch({ headers: event.target.value })} /></label>
            {step.method === 'POST' && <label>Request body<textarea aria-label="Request body" maxLength={model.limits.body} value={step.body} onChange={event => patch({ body: event.target.value })} /></label>}
            {controls.canRemoveStep && <button type="button" className="text-button" onClick={() => edit({ schema: 'health-editor-command-v1', operation: 'remove-step', checkId: check.id, index })}>Remove step {index + 1}</button>}
          </fieldset>;
        })}
        <div className="form-actions"><button type="button" className="secondary" disabled={!controls.canAddStep} onClick={() => edit({ schema: 'health-editor-command-v1', operation: 'add-step', checkId: check.id })}>Add step</button>
          <button type="button" className="secondary" disabled={!!busy || !controls.runEnabled} onClick={() => void run(check.id)}>{busy === check.id ? 'Running…' : 'Run now'}</button>
          <button type="button" className="text-button" onClick={() => edit({ schema: 'health-editor-command-v1', operation: 'remove-check', checkId: check.id })}>Remove check</button></div>
        {history && healthRecentRuns(history, check.id).map(row => <div key={row.runId} role="status" data-health-run={row.runId}><strong>{row.label}</strong> at {new Date(row.at).toLocaleTimeString()}<ul>{row.steps.map((line, index) => <li key={index}>{line}</li>)}</ul></div>)}
      </fieldset>;
    })}
    {model.apply.errors.map((issue, index) => <p className="error" role="status" key={index}>{issue.message}</p>)}
    <button type="button" className="secondary" disabled={adding || !model.canAddCheck} onClick={() => void add()}>Add health check</button>
  </>;
}
