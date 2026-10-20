import { useEffect, useState } from 'react';
import { ProjectDeploySchema, ProjectDeploySummarySchema, ProjectJobListViewSchema, type ProjectDeploySummary, type ProjectJob, type ProjectWorkSettings } from '@jevellan/core/client';
import { api } from './api.js';
export function DeploySettings({ projectId, value, change, fail }: { projectId: string; value: ProjectWorkSettings; change(patch: Partial<ProjectWorkSettings>): void; fail(error: unknown): void }) {
  const [jobs, setJobs] = useState<ProjectJob[]>([]);
  useEffect(() => { const controller = new AbortController(); void api(`/api/projects/${projectId}/jobs`, ProjectJobListViewSchema, 'GET', undefined, { signal: controller.signal }).then(view => setJobs(view.jobs.filter(job => job.run.kind === 'command'))).catch(error => { if (!controller.signal.aborted) fail(error); }); return () => controller.abort(); }, [projectId, fail]);
  return <fieldset><legend>Deploys</legend><label>Deploy mode<select value={value.deploy.mode} disabled><option value="approve">Owner approval</option><option value="nightly">After the night's full suite</option><option value="automatic">Automatic</option></select></label>
    {([['jobId', 'Deploy job'], ['desktopJobId', 'Desktop build job'], ['suiteJobId', 'Full suite job']] as const).map(([key, label]) => <label key={key}>{label}<select value={value.deploy[key] ?? ''} onChange={event => change({ deploy: { ...value.deploy, [key]: event.target.value || null } })}><option value="">None</option>{jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label>)}
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
