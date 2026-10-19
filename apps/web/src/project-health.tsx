import { useEffect, useState } from 'react';
import { ProjectHealthViewSchema, type ProjectHealthCheck, type ProjectHealthRun, type HealthStep } from '@jevellan/core/client';
import { api } from './api.js';

const newStep = (): HealthStep => ({ name: 'The app answers', method: 'GET', url: 'https://', headers: {}, body: null, expectStatus: [200], expectBody: null, timeoutMs: 10000 });
export function ProjectHealthEditor({ projectId, checks, change, fail }: { projectId: string; checks: ProjectHealthCheck[]; change(checks: ProjectHealthCheck[]): void; fail(error: unknown): void }) {
  const [runs, setRuns] = useState<ProjectHealthRun[]>([]), [busy, setBusy] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/projects/${projectId}/health`, ProjectHealthViewSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(view => setRuns(view.runs)).catch(error => { if (!controller.signal.aborted) fail(error); });
    return () => controller.abort();
  }, [projectId, fail]);
  const update = (id: string, patch: Partial<ProjectHealthCheck>) => change(checks.map(check => check.id === id ? { ...check, ...patch } : check));
  const run = async (check: ProjectHealthCheck) => {
    setBusy(check.id);
    try {
      const view = await api(`/api/projects/${projectId}/health/run`, ProjectHealthViewSchema, 'POST', { schema: 'project-health-request-v1', project: projectId, operation: 'run', definition: check });
      setRuns(previous => [...view.runs, ...previous]);
    } catch (error) { fail(error); } finally { setBusy(undefined); }
  };
  return <>
    <p>Checks run around deploys and when you press Run now. They never sign in. Save changes to keep these definitions.</p>
    {checks.map((check, checkIndex) => <fieldset key={check.id} className="pw-health-check"><legend>Check {checkIndex + 1}</legend>
      <label>Check name<input required maxLength={80} value={check.name} onChange={event => update(check.id, { name: event.target.value })} /></label>
      <label className="checkbox"><input type="checkbox" checked={check.enabled} onChange={event => update(check.id, { enabled: event.target.checked })} />Enabled</label>
      {check.steps.map((step, index) => {
        const patch = (value: Partial<HealthStep>) => update(check.id, { steps: check.steps.map((row, n) => n === index ? { ...row, ...value } : row) });
        return <fieldset key={index}><legend>Step {index + 1}</legend>
          <label>Step name<input required maxLength={80} value={step.name} onChange={event => patch({ name: event.target.value })} /></label>
          <div className="form-grid"><label>Method<select value={step.method} onChange={event => patch({ method: event.target.value === 'POST' ? 'POST' : 'GET' })}><option>GET</option><option>POST</option></select></label>
            <label>URL<input type="url" required maxLength={500} value={step.url} onChange={event => patch({ url: event.target.value })} /></label></div>
          <label>Expected status codes<input required value={step.expectStatus.join(', ')} onChange={event => patch({ expectStatus: event.target.value.split(',').map(value => Number(value.trim())) })} /></label>
          <label>Expected text (optional)<input maxLength={200} value={step.expectBody ?? ''} onChange={event => patch({ expectBody: event.target.value || null })} /></label>
          <label>Timeout (ms)<input type="number" min={1000} max={30000} value={step.timeoutMs} onChange={event => patch({ timeoutMs: event.target.valueAsNumber })} /></label>
          <label>Headers (JSON)<textarea defaultValue={JSON.stringify(step.headers)} onBlur={event => { try { const headers: unknown = JSON.parse(event.target.value); if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !Object.values(headers).every(value => typeof value === 'string')) throw new Error('Headers must be a JSON object of text values.'); patch({ headers: headers as Record<string, string> }); } catch (error) { fail(error); } }} /></label>
          {step.method === 'POST' && <label>Request body<textarea maxLength={2000} value={step.body ?? ''} onChange={event => patch({ body: event.target.value || null })} /></label>}
          {check.steps.length > 1 && <button type="button" className="text-button" onClick={() => update(check.id, { steps: check.steps.filter((_, n) => n !== index) })}>Remove step {index + 1}</button>}
        </fieldset>;
      })}
      <div className="form-actions"><button type="button" className="secondary" disabled={check.steps.length >= 5} onClick={() => update(check.id, { steps: [...check.steps, newStep()] })}>Add step</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void run(check)}>{busy === check.id ? 'Running…' : 'Run now'}</button>
        <button type="button" className="text-button" onClick={() => change(checks.filter(row => row.id !== check.id))}>Remove check</button></div>
      {runs.filter(row => row.checkId === check.id).slice(0, 5).map(row => <div key={row.id} role="status"><strong>{row.passed ? 'Passed' : 'Failed'}</strong> at {new Date(row.at).toLocaleTimeString()}
        <ul>{row.steps.map(step => <li key={step.name}>{step.name}: {step.passed ? 'passed' : 'failed'} · {step.ms} ms{step.reason ? ` · ${step.reason}` : ` · status ${step.status}`}</li>)}</ul></div>)}
    </fieldset>)}
    <button type="button" className="secondary" disabled={checks.length >= 10} onClick={() => change([...checks, { id: `health_${crypto.randomUUID()}`, name: 'New check', enabled: true, steps: [newStep()] }])}>Add health check</button>
  </>;
}
