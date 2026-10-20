import { useEffect, useState } from 'react';
import { ProjectDeploySchema, ProjectDeploySummarySchema, type ProjectDeploySummary, type ProjectRoutineSettingsView, type ProjectWorkSettings } from '@jevellan/core/client';
import { api } from './api.js';
export function DeploySettings({ model, value, change }: { model: ProjectRoutineSettingsView; value: ProjectWorkSettings; change(patch: Partial<ProjectWorkSettings>): void }) {
  const choose = (choices: ProjectRoutineSettingsView['deploy']['modes'], selected: string) => { const choice = choices.find(row => row.value === selected); if (choice && !choice.disabled) change({ deploy: { ...value.deploy, ...choice.patch } }); };
  return <fieldset><legend>Deploys</legend><label>Deploy mode<select value={value.deploy.mode} onChange={event => choose(model.deploy.modes, event.target.value)}>{model.deploy.modes.map(row => <option key={row.value} value={row.value} disabled={row.disabled}>{row.label}</option>)}</select></label><p className="pw-field-note">{model.deploy.modeNotice}</p>
    {model.deploy.slots.map(slot => <label key={slot.key}>{slot.label}<select value={value.deploy[slot.key] ?? ''} onChange={event => choose(slot.choices, event.target.value)}>{slot.choices.map(row => <option key={row.value} value={row.value} disabled={row.disabled}>{row.label}</option>)}</select></label>)}
    <p>Deploys build the commit shown in the owner’s message. Health checks run before and after release.</p></fieldset>;
}
export function LastDeploy({ projectId, fail }: { projectId: string; fail(error: unknown): void }) {
  const [view, setView] = useState<ProjectDeploySummary | null>(null), [confirm, setConfirm] = useState<string | null>(null), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => { const controller = new AbortController(); const read = () => { void api(`/api/projects/${projectId}/deploy-summary`, ProjectDeploySummarySchema, 'GET', undefined, { signal: controller.signal }).then(setView).catch(error => { if (!controller.signal.aborted) fail(error); }); }; read(); const timer = setInterval(read, 15000); return () => { clearInterval(timer); controller.abort(); }; }, [projectId, fail, refresh]);
  if (!view?.current) return null;
  const plan = view.rollback;
  return <div className="pw-last-deploy"><p>{view.current.label}</p>
    {view.healthLines.map((line, i) => <p key={i}>{line}</p>)}
    {view.desktopLine && <p>{view.desktopLine}</p>}
    {plan && (plan.enabled && confirm === plan.body.clientRequestId ? <div role="group" aria-label="Confirm rollback"><p>{plan.confirmation}</p><button type="button" disabled={busy} onClick={() => { setBusy(true); void api(plan.path, ProjectDeploySchema, 'POST', plan.body).then(() => { setConfirm(null); setRefresh(value => value + 1); }).catch(fail).finally(() => setBusy(false)); }}>Confirm rollback</button><button type="button" className="secondary" onClick={() => setConfirm(null)}>Cancel</button></div> : <><button type="button" className="secondary small" disabled={busy || !plan.enabled} onClick={() => setConfirm(plan.body.clientRequestId)}>{plan.label}</button>{plan.refusal && <p>{plan.refusal}</p>}</>)}
  </div>;
}
