import { useState } from 'react';
import { ProjectDailySchema, ProjectJobSchema, TaskReceiptSchema, MemoryDreamRunReceiptSchema, TaskTypeSchema, type ProjectDaily, type ProjectJob, type ProjectDailyListViewSchema, type ProjectJobsView } from '@jevellan/core/client';
import { z } from 'zod';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Modal, useTask } from './components.js';
import type { GoalEntry } from './project-goals.js';
export type DailyView = z.infer<typeof ProjectDailyListViewSchema>;
export function NightlyBanner({ view }: { view: ProjectJobsView }) {
  const key = `jevellan.last-window.${view.projectId}`, [dismissed, setDismissed] = useState(() => localStorage.getItem(key));
  if (view.mergeHold.banner) return <p className="notice" role="status">{view.mergeHold.banner}</p>;
  const banner = view.banner; if (!banner || dismissed === banner.windowId) return null;
  return <div className="notice actions" role="status"><span>{banner.text}</span><button className="secondary small" onClick={() => { localStorage.setItem(key, banner.windowId); setDismissed(banner.windowId); }}>Dismiss</button></div>;
}
export function ProjectDailyPanel({ view, goals, changed, onError }: { view: ProjectJobsView; goals: readonly GoalEntry[]; changed(): void; onError(error: unknown): void }) {
  const [daily, setDaily] = useState<ProjectDaily | 'new'>(), [job, setJob] = useState<ProjectJob | 'new'>(), operation = useTask(onError);
  const jobs = view.jobs.map(row => row.definition);
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
    {daily && <DailyEditor projectId={view.projectId} item={daily === 'new' ? undefined : daily} jobs={jobs} goals={goals} changed={changed} onError={onError} close={() => setDaily(undefined)} />}
    {job && <JobEditor projectId={view.projectId} item={job === 'new' ? undefined : job} jobs={jobs} goals={goals} changed={changed} onError={onError} close={() => setJob(undefined)} />}
  </>;
}
type EditorProps = { projectId: string; jobs: readonly ProjectJob[]; goals: readonly GoalEntry[]; changed(): void; onError(error: unknown): void; close(): void };
function JobEditor({ projectId, item, jobs, goals, changed, onError, close }: EditorProps & { item?: ProjectJob | undefined }) {
  const [request] = useState(clientId), [name, setName] = useState(item?.name ?? ''), [goalId, setGoal] = useState(item?.goalId ?? ''), [enabled, setEnabled] = useState(item?.enabled ?? true), [gate, setGate] = useState(item?.gate?.jobId ?? ''),
    [command, setCommand] = useState(item?.run.kind === 'command' ? item.run.command : ''), [timeout, setTimeout] = useState(item?.run.timeoutMinutes ?? 30),
    [needs, setNeeds] = useState(item?.run.kind === 'command' ? item.run.needs.join(', ') : ''), [cwd, setCwd] = useState(item?.run.kind === 'command' ? item.run.cwd : 'checkout');
  const operation = useTask(onError), retired = item?.run.kind === 'github-workflow';
  return <Modal title={item ? 'Edit job' : 'New job'} close={close}>{retired ? <p>GitHub workflow (retired 19 October). Its receipts remain available. Create a command job to replace it.</p> : <form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    const fields = { name, goalId: goalId || null, enabled, gate: gate ? { jobId: gate } : null, run: { kind: 'command', command, timeoutMinutes: timeout, needs: needs.split(/[,\s]+/u).filter(Boolean), cwd } };
    await api(item ? `/api/projects/${projectId}/jobs/${item.id}/edit` : `/api/projects/${projectId}/jobs`, ProjectJobSchema, 'POST', { ...fields, schema: item ? 'job-update-request-v1' : 'job-create-request-v1', ...(item ? { expectedRevision: item.revision } : { clientRequestId: request }) }, { signal, waitForHub: true }); changed(); close();
  }); }}>
    <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Goal<select value={goalId} onChange={event => setGoal(event.target.value)}><option value="">Asks</option>{goals.map(entry => <option key={entry.goal.id} value={entry.goal.id}>{entry.goal.name}</option>)}</select></label>
    <label>Command<textarea required maxLength={2000} value={command} onChange={event => setCommand(event.target.value)} /></label>
    <label>Device tags<input maxLength={264} placeholder="linux, prod-access" value={needs} onChange={event => setNeeds(event.target.value)} /></label><p className="pw-field-note">Every tag is required. Leave empty for any eligible project device.</p>
    <label>Working directory<select value={cwd} onChange={event => setCwd(event.target.value as typeof cwd)}><option value="checkout">Clean checkout</option><option value="workspace">Retained workspace</option></select></label>
    <label>Timeout in minutes<input required type="number" min={1} max={240} value={timeout} onChange={event => setTimeout(Number(event.target.value))} /></label>
    <label>Gate<select value={gate} onChange={event => setGate(event.target.value)}><option value="">No gate</option>{jobs.filter(job => job.id !== item?.id && job.run.kind === 'command').map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label><p className="pw-field-note">Runs on exactly the commit this job passed on in the project day.</p>
    <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form>}</Modal>;
}
function DailyEditor({ projectId, item, jobs, goals, changed, onError, close }: EditorProps & { item?: ProjectDaily | undefined }) {
  const [request] = useState(clientId), [name, setName] = useState(item?.name ?? ''), [goalId, setGoal] = useState(item?.goalId ?? ''), [enabled, setEnabled] = useState(item?.enabled ?? true), [order, setOrder] = useState(item?.order ?? 0),
    [days, setDays] = useState(item?.days ?? []), [kind, setKind] = useState(item?.target.kind ?? 'job'), [jobId, setJob] = useState(item?.target.kind === 'job' ? item.target.jobId : jobs[0]?.id ?? ''), [title, setTitle] = useState(item?.target.kind === 'session' ? item.target.title : ''),
    [reviewFrom, setReviewFrom] = useState(item?.target.kind === 'review-since-last' ? item.target.reviewFromCommit ?? '' : ''), [brief, setBrief] = useState(item?.target.kind === 'session' ? item.target.brief : ''), [type, setType] = useState(item?.target.kind === 'session' ? item.target.type : 'review');
  const operation = useTask(onError);
  return <Modal title={item ? 'Edit nightly item' : 'New nightly item'} close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    const fields = { name, goalId: goalId || null, order, enabled, ...(days.length ? { days } : {}), target: kind === 'memory-dream' ? { kind } : kind === 'job' ? { kind, jobId } : kind === 'review-since-last' ? { kind, ...(reviewFrom ? { reviewFromCommit: reviewFrom } : {}) } : { kind, title, brief, type } };
    await api(item ? `/api/projects/${projectId}/dailies/${item.id}/edit` : `/api/projects/${projectId}/dailies`, ProjectDailySchema, 'POST', { ...fields, schema: item ? 'daily-update-request-v1' : 'daily-create-request-v1', ...(item ? { expectedRevision: item.revision } : { clientRequestId: request }) }, { signal, waitForHub: true }); changed(); close();
  }); }}>
    <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label>Goal<select value={goalId} onChange={event => setGoal(event.target.value)}><option value="">Asks</option>{goals.map(entry => <option key={entry.goal.id} value={entry.goal.id}>{entry.goal.name}</option>)}</select></label>
    <label>Work<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="job">Job</option><option value="session">Thread</option><option value="review-since-last">Review since last</option><option value="memory-dream">Memory dream</option></select></label>
    {kind === 'review-since-last' && <label>Review from commit<input pattern="[0-9a-f]{40}" maxLength={40} placeholder="Current main when first enabled" value={reviewFrom} onChange={event => setReviewFrom(event.target.value)} /></label>}
    {kind === 'job' ? <label>Job<select required value={jobId} onChange={event => setJob(event.target.value)}><option value="">Choose a job</option>{jobs.filter(job => job.run.kind === 'command').map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label> : kind === 'session' ? <>
      <label>Task title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Brief<textarea required maxLength={20000} rows={5} value={brief} onChange={event => setBrief(event.target.value)} /></label>
      <label>Type<select value={type} onChange={event => setType(TaskTypeSchema.parse(event.target.value))}>{TaskTypeSchema.options.map(type => <option key={type}>{type}</option>)}</select></label>
    </> : <p className="pw-field-note">Read-only, high effort, on the other provider. Every commit since the last completed review is included.</p>}
    <fieldset><legend>Days (none means every night)</legend>{(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map(day => <label className="check" key={day}><input type="checkbox" checked={days.includes(day)} onChange={event => setDays(event.target.checked ? [...days, day] : days.filter(value => value !== day))} />{day[0]!.toUpperCase() + day.slice(1)}</label>)}</fieldset>
    <label>Order<input type="number" required min={0} max={100} value={order} onChange={event => setOrder(Number(event.target.value))} /></label><label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form></Modal>;
}
