import { useState } from 'react';
import { ProjectDailySchema, ProjectJobSchema, TaskReceiptSchema, TaskTypeSchema, type ProjectDaily, type ProjectJob, type ProjectDailyListViewSchema } from '@jevellan/core/client';
import type { z } from 'zod';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Modal, useTask } from './components.js';
import type { GoalEntry } from './project-goals.js';
export type DailyView = z.infer<typeof ProjectDailyListViewSchema>;
export function NightlyBanner({ view }: { view: DailyView }) {
  const key = `jevellan.last-window.${view.projectId}`, [dismissed, setDismissed] = useState(() => localStorage.getItem(key));
  if (view.mergesHeld) return <p className="notice" role="status">Nightly window · merges held until the nightly tasks finish</p>;
  const window = view.window; if (!window || window.state !== 'finished' || dismissed === window.id) return null;
  const passed = view.tasks.filter(task => window.taskIds.includes(task.id) && task.state === 'done').length;
  return <div className="notice actions" role="status"><span>Last night: {passed} of {window.taskIds.length} nightly tasks passed.</span><button className="secondary small" onClick={() => { localStorage.setItem(key, window.id); setDismissed(window.id); }}>Dismiss</button></div>;
}
export function ProjectDailyPanel({ view, goals, changed, onError }: { view: DailyView; goals: readonly GoalEntry[]; changed(): void; onError(error: unknown): void }) {
  const [daily, setDaily] = useState<ProjectDaily | 'new'>(), [job, setJob] = useState<ProjectJob | 'new'>(), operation = useTask(onError);
  const displayDay = view.window?.state === 'open' ? view.window.closingProjectDay : view.projectDay;
  const run = (kind: 'jobs' | 'dailies', id: string) => void operation.run(async signal => { await api(`/api/projects/${view.projectId}/${kind}/${id}/run`, TaskReceiptSchema, 'POST', { schema: 'project-run-request-v1', clientRequestId: clientId() }, { signal, waitForHub: true }); changed(); });
  const toggle = (item: ProjectDaily) => void operation.run(async signal => {
    await api(`/api/projects/${view.projectId}/dailies/${item.id}/edit`, ProjectDailySchema, 'POST', { schema: 'daily-update-request-v1', expectedRevision: item.revision, name: item.name, goalId: item.goalId, order: item.order, target: item.target, enabled: !item.enabled }, { signal, waitForHub: true }); changed();
  });
  return <>
    {view.mergesHeld && <p className="notice">Merges are held while the nightly window runs.</p>}
    <p className="muted">{view.window?.state === 'open' ? 'Closing project day' : 'Project day'}: {displayDay}</p>
    <div className="actions"><button className="secondary small" onClick={() => setDaily('new')}>New nightly item</button><button className="secondary small" onClick={() => setJob('new')}>New job</button></div>
    {!view.dailies.length && <p className="pw-empty">Add checks or a review to run every night.</p>}
    {view.dailies.map(item => {
      const matching = view.tasks.filter(task => task.dailyId === item.id && task.projectDay === displayDay), nightly = view.tasks.filter(task => task.dailyId === item.id && view.window?.taskIds.includes(task.id));
      const tasks = nightly.length ? nightly : matching, completed = tasks.some(task => task.state === 'done'), pending = tasks.find(task => ['queued', 'active'].includes(task.state)), failed = tasks.find(task => task.state === 'failed');
      const receipt = view.runs.find(run => tasks.some(task => task.id === run.taskId));
      const end = tasks.find(task => task.state === (completed ? 'done' : 'failed'))?.endedAt;
      const time = end ? ` at ${new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
      const target = item.target, definition = target.kind === 'job' ? view.jobs.find(job => job.id === target.jobId) : null;
      return <article className="pw-goal" key={item.id} data-daily-id={item.id}><header><h4>{item.name}</h4><span className="chip">{!item.enabled ? 'Disabled' : completed ? `Done today${time}` : pending?.state === 'active' ? 'Running' : pending ? 'Queued' : failed ? `Failed${time}` : 'Not run today'}</span></header>
        <p className="muted">{item.target.kind === 'review-since-last' ? 'Review since last' : item.target.kind === 'session' ? 'Thread' : definition?.run.kind === 'command' ? 'Command' : 'GitHub workflow'}</p>
        {item.goalId && <p className="muted">{goals.find(entry => entry.goal.id === item.goalId)?.goal.name ?? 'Goal'}</p>}
        {receipt && <details><summary>{receipt.summary || 'Job running'} · {receipt.commit.slice(0, 7)}</summary><pre className="pw-job-log">{receipt.logTail || 'No output recorded.'}</pre>{receipt.url && <a href={receipt.url} target="_blank" rel="noopener noreferrer">Open workflow run</a>}</details>}
        {failed && !receipt && <p className="error">{failed.endNote}</p>}
        <div className="actions"><button className="small" disabled={operation.busy || !item.enabled || !!pending} onClick={() => run('dailies', item.id)}>Run now</button><button className="secondary small" onClick={() => setDaily(item)}>Edit</button><label className="check"><input type="checkbox" aria-label={`Enable ${item.name}`} checked={item.enabled} disabled={operation.busy} onChange={() => toggle(item)} />Enabled</label></div>
      </article>;
    })}
    {view.jobs.length > 0 && <details className="pw-jobs"><summary>Jobs ({view.jobs.length})</summary>{view.jobs.map(item => <article className="pw-goal" key={item.id}><header><h4>{item.name}</h4><span className="chip">{item.enabled ? 'Enabled' : 'Disabled'}</span></header><p className="muted">{item.run.kind === 'command' ? 'Command' : `${item.run.mode === 'watch' ? 'Watch' : 'Dispatch'} ${item.run.workflow}`}{item.gate ? ` · Gate: ${view.jobs.find(job => job.id === item.gate?.jobId)?.name ?? 'Job'}` : ''}</p><div className="actions"><button className="secondary small" disabled={operation.busy || !item.enabled} onClick={() => run('jobs', item.id)}>Run now</button><button className="secondary small" onClick={() => setJob(item)}>Edit</button></div></article>)}</details>}
    {view.window?.state === 'finished' && <details><summary>Last nightly window</summary><pre className="pw-job-log">{view.window.outcome}</pre></details>}
    {view.lastReview && <details open className="pw-jobs"><summary>Last night's review · {view.lastReview.commit.slice(0, 7)}</summary><p>{view.lastReview.summary}</p>{view.lastReview.findings.map((finding, index) => <div key={index}><strong>{finding.what}</strong><p>{finding.detail}</p><p className="muted">{finding.files.join(', ')}</p></div>)}{!view.lastReview.findings.length && <p className="muted">No findings.</p>}</details>}
    {daily && <DailyEditor projectId={view.projectId} item={daily === 'new' ? undefined : daily} jobs={view.jobs} goals={goals} changed={changed} onError={onError} close={() => setDaily(undefined)} />}
    {job && <JobEditor projectId={view.projectId} item={job === 'new' ? undefined : job} jobs={view.jobs} goals={goals} changed={changed} onError={onError} close={() => setJob(undefined)} />}
  </>;
}
type EditorProps = { projectId: string; jobs: readonly ProjectJob[]; goals: readonly GoalEntry[]; changed(): void; onError(error: unknown): void; close(): void };
function JobEditor({ projectId, item, jobs, goals, changed, onError, close }: EditorProps & { item?: ProjectJob | undefined }) {
  const [request] = useState(clientId), [name, setName] = useState(item?.name ?? ''), [goalId, setGoal] = useState(item?.goalId ?? ''), [enabled, setEnabled] = useState(item?.enabled ?? true), [gate, setGate] = useState(item?.gate?.jobId ?? ''),
    [kind, setKind] = useState(item?.run.kind ?? 'command'), [command, setCommand] = useState(item?.run.kind === 'command' ? item.run.command : ''), [workflow, setWorkflow] = useState(item?.run.kind === 'github-workflow' ? item.run.workflow : ''),
    [mode, setMode] = useState(item?.run.kind === 'github-workflow' ? item.run.mode : 'watch'), [timeout, setTimeout] = useState(item?.run.timeoutMinutes ?? 30),
    [requiredJobs, setRequiredJobs] = useState(item?.run.kind === 'github-workflow' ? item.run.requiredJobs?.join('\n') ?? '' : ''), [requiredSteps, setRequiredSteps] = useState(item?.run.kind === 'github-workflow' ? item.run.requiredSteps?.join('\n') ?? '' : '');
  const operation = useTask(onError), names = (value: string) => value.split('\n').map(name => name.trim()).filter(Boolean);
  return <Modal title={item ? 'Edit job' : 'New job'} close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    const run = kind === 'command' ? { kind, command, timeoutMinutes: timeout } : { kind, workflow, mode, timeoutMinutes: timeout, requiredJobs: names(requiredJobs), requiredSteps: names(requiredSteps) };
    const fields = { name, goalId: goalId || null, enabled, gate: gate ? { jobId: gate } : null, run };
    await api(item ? `/api/projects/${projectId}/jobs/${item.id}/edit` : `/api/projects/${projectId}/jobs`, ProjectJobSchema, 'POST', { ...fields, schema: item ? 'job-update-request-v1' : 'job-create-request-v1', ...(item ? { expectedRevision: item.revision } : { clientRequestId: request }) }, { signal, waitForHub: true }); changed(); close();
  }); }}>
    <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Goal<select value={goalId} onChange={event => setGoal(event.target.value)}><option value="">Asks</option>{goals.map(entry => <option key={entry.goal.id} value={entry.goal.id}>{entry.goal.name}</option>)}</select></label>
    <label>Run<select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setTimeout(30); }}><option value="command">Command</option><option value="github-workflow">GitHub workflow</option></select></label>
    {kind === 'command' ? <label>Command<textarea required maxLength={2000} value={command} onChange={event => setCommand(event.target.value)} /></label> : <>
      <label>Workflow<input required maxLength={200} placeholder="nightly.yml" value={workflow} onChange={event => setWorkflow(event.target.value)} /></label>
      <label>Mode<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="watch">Watch an existing run</option><option value="dispatch">Dispatch a run</option></select></label>
      <label>Required job names<textarea value={requiredJobs} onChange={event => setRequiredJobs(event.target.value)} /></label><label>Required step names<textarea value={requiredSteps} onChange={event => setRequiredSteps(event.target.value)} /></label><p className="pw-field-note">One exact name per line. These must run successfully; skipped tests do not pass.</p>
    </>}
    <label>Timeout in minutes<input required type="number" min={kind === 'command' ? 1 : 5} max={kind === 'command' ? 240 : 600} value={timeout} onChange={event => setTimeout(Number(event.target.value))} /></label>
    <label>Gate<select value={gate} onChange={event => setGate(event.target.value)}><option value="">No gate</option>{jobs.filter(job => job.id !== item?.id).map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label><p className="pw-field-note">Runs on exactly the commit this job passed on in the project day.</p>
    <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form></Modal>;
}
function DailyEditor({ projectId, item, jobs, goals, changed, onError, close }: EditorProps & { item?: ProjectDaily | undefined }) {
  const [request] = useState(clientId), [name, setName] = useState(item?.name ?? ''), [goalId, setGoal] = useState(item?.goalId ?? ''), [enabled, setEnabled] = useState(item?.enabled ?? true), [order, setOrder] = useState(item?.order ?? 0),
    [kind, setKind] = useState(item?.target.kind ?? 'job'), [jobId, setJob] = useState(item?.target.kind === 'job' ? item.target.jobId : jobs[0]?.id ?? ''), [title, setTitle] = useState(item?.target.kind === 'session' ? item.target.title : ''),
    [brief, setBrief] = useState(item?.target.kind === 'session' ? item.target.brief : ''), [type, setType] = useState(item?.target.kind === 'session' ? item.target.type : 'review');
  const operation = useTask(onError);
  return <Modal title={item ? 'Edit nightly item' : 'New nightly item'} close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    const fields = { name, goalId: goalId || null, order, enabled, target: kind === 'job' ? { kind, jobId } : kind === 'review-since-last' ? { kind } : { kind, title, brief, type } };
    await api(item ? `/api/projects/${projectId}/dailies/${item.id}/edit` : `/api/projects/${projectId}/dailies`, ProjectDailySchema, 'POST', { ...fields, schema: item ? 'daily-update-request-v1' : 'daily-create-request-v1', ...(item ? { expectedRevision: item.revision } : { clientRequestId: request }) }, { signal, waitForHub: true }); changed(); close();
  }); }}>
    <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label>Goal<select value={goalId} onChange={event => setGoal(event.target.value)}><option value="">Asks</option>{goals.map(entry => <option key={entry.goal.id} value={entry.goal.id}>{entry.goal.name}</option>)}</select></label>
    <label>Work<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="job">Job</option><option value="session">Thread</option><option value="review-since-last">Review since last</option></select></label>
    {kind === 'job' ? <label>Job<select required value={jobId} onChange={event => setJob(event.target.value)}><option value="">Choose a job</option>{jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label> : kind === 'session' ? <>
      <label>Task title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Brief<textarea required maxLength={20000} rows={5} value={brief} onChange={event => setBrief(event.target.value)} /></label>
      <label>Type<select value={type} onChange={event => setType(TaskTypeSchema.parse(event.target.value))}>{TaskTypeSchema.options.map(type => <option key={type}>{type}</option>)}</select></label>
    </> : <p className="pw-field-note">Read-only, high effort, on the other provider. Every commit since the last completed review is included.</p>}
    <label>Order<input type="number" required min={0} max={100} value={order} onChange={event => setOrder(Number(event.target.value))} /></label><label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={close}>Cancel</button></div>
  </form></Modal>;
}
