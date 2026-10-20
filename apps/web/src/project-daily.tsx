import { useState } from 'react';
import { ProjectDailySchema, ProjectJobSchema, TaskReceiptSchema, MemoryDreamRunReceiptSchema, type ProjectDaily, type ProjectJob, type ProjectDailyListViewSchema, type ProjectJobsView } from '@jevellan/core/client';
import { z } from 'zod';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { useTask } from './components.js';
import { JobEditor, DailyEditor } from './routine-editors.js';
export type DailyView = z.infer<typeof ProjectDailyListViewSchema>;
export function NightlyBanner({ view }: { view: ProjectJobsView }) {
  const key = `jevellan.last-window.${view.projectId}`, [dismissed, setDismissed] = useState(() => localStorage.getItem(key));
  if (view.mergeHold.banner) return <p className="notice" role="status">{view.mergeHold.banner}</p>;
  const banner = view.banner; if (!banner || dismissed === banner.windowId) return null;
  return <div className="notice actions" role="status"><span>{banner.text}</span><button className="secondary small" onClick={() => { localStorage.setItem(key, banner.windowId); setDismissed(banner.windowId); }}>Dismiss</button></div>;
}
export function ProjectDailyPanel({ view, changed, onError }: { view: ProjectJobsView; changed(): void; onError(error: unknown): void }) {
  const [daily, setDaily] = useState<ProjectDaily | 'new'>(), [job, setJob] = useState<ProjectJob | 'new'>(), operation = useTask(onError);
  const run = (plan: ProjectJobsView['jobs'][number]['runNow']) => void operation.run(async signal => { await api(plan.path, z.union([TaskReceiptSchema, MemoryDreamRunReceiptSchema]), 'POST', { schema: 'project-run-request-v1', clientRequestId: clientId() }, { signal, waitForHub: true }); changed(); });
  const toggle = (plan: ProjectJobsView['dailies'][number]['toggle']) => void operation.run(async signal => {
    await api(plan.path, ProjectDailySchema, 'POST', plan.body, { signal, waitForHub: true }); changed();
  });
  const pause = (plan: NonNullable<ProjectJobsView['jobs'][number]['pause']>) => void operation.run(async signal => {
    await api(plan.path, ProjectJobSchema, 'POST', plan.body, { signal, waitForHub: true }); changed();
  });
  return <>
    {view.mergeHold.notice && <p className="notice">{view.mergeHold.notice}</p>}
    <p className="muted">{view.displayDay.label}: {view.displayDay.date}</p>
    <div className="actions"><button className="secondary small" onClick={() => setDaily('new')}>New nightly item</button><button className="secondary small" onClick={() => setJob('new')}>New job</button></div>
    {!view.dailies.length && <p className="pw-empty">Add checks or a review to run every night.</p>}
    {view.dailies.map(row => <article className="pw-goal" key={row.definition.id} data-daily-id={row.definition.id}><header><h4>{row.definition.name}</h4><span className="chip">{row.stateLabel}</span></header>
      <p className="muted">{row.kindLabel}</p>{row.daysLabel && <p className="muted">{row.daysLabel}</p>}{row.goalLabel && <p className="muted">{row.goalLabel}</p>}
      {row.lastRun && <details><summary>{row.lastRun.summary} · {row.lastRun.commitLabel}</summary><pre className="pw-job-log">{row.lastRun.logTail}</pre>{row.lastRun.href && <a href={row.lastRun.href} target="_blank" rel="noopener noreferrer">Open workflow run</a>}</details>}
      {row.failure !== null && <p className="error">{row.failure}</p>}
      <div className="actions"><button className="small" disabled={operation.busy || !row.runNow.enabled} title={row.runNow.refusal ?? undefined} onClick={() => run(row.runNow)}>Run now</button><button className="secondary small" onClick={() => setDaily(row.definition)}>Edit</button><label className="check"><input type="checkbox" aria-label={`Enable ${row.definition.name}`} checked={row.definition.enabled} disabled={operation.busy} onChange={() => toggle(row.toggle)} />Enabled</label></div>
    </article>)}
    {view.jobs.length > 0 && <details className="pw-jobs"><summary>Jobs ({view.jobs.length})</summary>{view.jobs.map(row => <article className="pw-goal" key={row.definition.id}><header><h4>{row.definition.name}</h4><span className="chip">{row.stateLabel}</span></header><p className="muted">{row.kindLabel}{row.gateLabel && ` · ${row.gateLabel}`}</p>{row.scheduleLine && <p className="muted">{row.scheduleLine}</p>}<div className="actions"><button className="secondary small" disabled={operation.busy || !row.runNow.enabled} title={row.runNow.refusal ?? undefined} onClick={() => run(row.runNow)}>Run now</button>{row.pause && <button className="secondary small" disabled={operation.busy} onClick={() => pause(row.pause!)}>{row.pause.label}</button>}<button className="secondary small" onClick={() => setJob(row.definition)}>Edit</button></div></article>)}</details>}
    {view.lastWindowOutcome !== null && <details><summary>Last nightly window</summary><pre className="pw-job-log">{view.lastWindowOutcome}</pre></details>}
    {view.review && <details open className="pw-jobs"><summary>Last night's review · {view.review.commitLabel}</summary><p>{view.review.summary}</p>{view.review.findings.map((finding, index) => <div key={index}><strong>{finding.what}</strong><p>{finding.detail}</p><p className="muted">{finding.filesLabel}</p></div>)}{view.review.emptyText && <p className="muted">{view.review.emptyText}</p>}</details>}
    {daily && <DailyEditor projectId={view.projectId} itemId={daily === 'new' ? undefined : daily.id} changed={changed} onError={onError} close={() => setDaily(undefined)} />}
    {job && <JobEditor projectId={view.projectId} itemId={job === 'new' ? undefined : job.id} changed={changed} onError={onError} close={() => setJob(undefined)} />}
  </>;
}
