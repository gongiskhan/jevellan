import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ProjectJobEditorSchema, ProjectDailyEditorSchema, ProjectJobSchema, ProjectDailySchema,
  type ProjectJobEditor, type ProjectDailyEditor, type RoutineEditorChoice } from '@jevellan/core/client';
import { api } from './api.js';
import { Modal, useTask } from './components.js';

type Props = { projectId: string; itemId?: string | undefined; changed(): void; onError(error: unknown): void; close(): void };
function useEditor<T>(path: string, schema: z.ZodType<T>, onError: Props['onError']) {
  const [view, setView] = useState<T>(), fail = useRef(onError); fail.current = onError;
  useEffect(() => {
    const controller = new AbortController(); setView(undefined);
    void api(path, schema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(value => { if (!controller.signal.aborted) setView(value); })
      .catch(error => { if (!controller.signal.aborted) fail.current(error); });
    return () => controller.abort();
  }, [path, schema]);
  return view;
}
function Options({ values }: { values: readonly RoutineEditorChoice[] }) {
  return values.map(value => <option key={value.value} value={value.value} disabled={value.disabled} title={value.refusal ?? undefined}>{value.label}</option>);
}
export function JobEditor(props: Props) {
  const path = `/api/projects/${props.projectId}/jobs/${props.itemId ? `${props.itemId}/` : ''}editor`;
  const view = useEditor(path, ProjectJobEditorSchema, props.onError);
  return <Modal title={view?.title ?? 'Loading job'} close={props.close}>{!view ? <p role="status">Loading editor…</p> : view.readonly ? <p>{view.notice}</p> : <JobForm key={path} view={view} props={props} />}</Modal>;
}
function JobForm({ view, props }: { view: ProjectJobEditor; props: Props }) {
  const [fields, setFields] = useState(view.defaults), operation = useTask(props.onError);
  const set = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) => setFields(previous => ({ ...previous, [key]: value }));
  return <form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    await api(view.request.path, ProjectJobSchema, 'POST', { ...view.request.base, fields }, { signal, waitForHub: true }); props.changed(); props.close();
  }); }}>
    <label>Name<input required maxLength={view.constraints.nameMax} value={fields.name} onChange={event => set('name', event.target.value)} /></label>
    <label>Goal<select value={fields.goalId} onChange={event => set('goalId', event.target.value)}><Options values={view.choices.goals} /></select></label>
    <label>Command<textarea required maxLength={view.constraints.commandMax} value={fields.command} onChange={event => set('command', event.target.value)} /></label>
    <label>Device tags<input maxLength={view.constraints.needsMax} placeholder="linux, prod-access" value={fields.needs} onChange={event => set('needs', event.target.value)} /></label><p className="pw-field-note">Every tag is required. Leave empty for any eligible project device.</p>
    <label>Working directory<select value={fields.cwd} onChange={event => set('cwd', event.target.value as typeof fields.cwd)}><Options values={view.choices.cwd} /></select></label>
    <label>Timeout in minutes<input required type="number" min={view.constraints.timeoutMinutes.min} max={view.constraints.timeoutMinutes.max} value={fields.timeoutMinutes} onChange={event => set('timeoutMinutes', event.target.value)} /></label>
    <label>Gate<select value={fields.gate} onChange={event => set('gate', event.target.value)}><Options values={view.choices.gates} /></select></label><p className="pw-field-note">Runs on exactly the commit this job passed on in the project day.</p>
    <label className="check"><input type="checkbox" checked={fields.intervalEnabled} onChange={event => set('intervalEnabled', event.target.checked)} />Interval schedule</label>
    {fields.intervalEnabled && <><label>Every minutes<input required type="number" min={view.constraints.everyMinutes.min} max={view.constraints.everyMinutes.max} value={fields.everyMinutes} onChange={event => set('everyMinutes', event.target.value)} /></label>
      <label>Between start<input required type="time" value={fields.intervalStart} onChange={event => set('intervalStart', event.target.value)} /></label><label>Between end<input required type="time" value={fields.intervalEnd} onChange={event => set('intervalEnd', event.target.value)} /></label></>}
    <label className="check"><input type="checkbox" checked={fields.enabled} onChange={event => set('enabled', event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={props.close}>Cancel</button></div>
  </form>;
}
export function DailyEditor(props: Props) {
  const path = `/api/projects/${props.projectId}/dailies/${props.itemId ? `${props.itemId}/` : ''}editor`;
  const view = useEditor(path, ProjectDailyEditorSchema, props.onError);
  return <Modal title={view?.title ?? 'Loading nightly item'} close={props.close}>{view ? <DailyForm key={path} view={view} props={props} /> : <p role="status">Loading editor…</p>}</Modal>;
}
function DailyForm({ view, props }: { view: ProjectDailyEditor; props: Props }) {
  const [fields, setFields] = useState(view.defaults), operation = useTask(props.onError);
  const set = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) => setFields(previous => ({ ...previous, [key]: value }));
  const groups = view.fieldsByKind[fields.kind], note = view.notesByKind[fields.kind];
  return <form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    await api(view.request.path, ProjectDailySchema, 'POST', { ...view.request.base, fields }, { signal, waitForHub: true }); props.changed(); props.close();
  }); }}>
    <label>Name<input required maxLength={view.constraints.nameMax} value={fields.name} onChange={event => set('name', event.target.value)} /></label>
    <label>Goal<select value={fields.goalId} onChange={event => set('goalId', event.target.value)}><Options values={view.choices.goalsByKind[fields.kind]} /></select></label>
    <label>Work<select value={fields.kind} onChange={event => set('kind', event.target.value as typeof fields.kind)}><Options values={view.choices.kinds} /></select></label>
    {groups.review && <label>Review from commit<input pattern={view.constraints.reviewFromPattern} maxLength={view.constraints.reviewFromMax} placeholder="Current main when first enabled" value={fields.reviewFrom} onChange={event => set('reviewFrom', event.target.value)} /></label>}
    {groups.job && <label>Job<select required value={fields.jobId} onChange={event => set('jobId', event.target.value)}><option value="">Choose a job</option><Options values={view.choices.jobs} /></select></label>}
    {groups.session && <><label>Task title<input required maxLength={view.constraints.titleMax} value={fields.title} onChange={event => set('title', event.target.value)} /></label>
      <label>Brief<textarea required maxLength={view.constraints.briefMax} rows={5} value={fields.brief} onChange={event => set('brief', event.target.value)} /></label>
      <label>Type<select value={fields.type} onChange={event => set('type', event.target.value as typeof fields.type)}><Options values={view.choices.types} /></select></label></>}
    {note && <p className="pw-field-note">{note}</p>}
    <fieldset><legend>Days (none means every night)</legend>{view.choices.days.map(day => <label className="check" key={day.value}><input type="checkbox" checked={fields.days.includes(day.value)} onChange={event => set('days', event.target.checked ? [...fields.days, day.value] : fields.days.filter(value => value !== day.value))} />{day.label}</label>)}</fieldset>
    <label>Order<input type="number" required min={view.constraints.order.min} max={view.constraints.order.max} value={fields.order} onChange={event => set('order', event.target.value)} /></label>
    <label className="check"><input type="checkbox" checked={fields.enabled} onChange={event => set('enabled', event.target.checked)} />Enabled</label>
    <div className="actions"><button disabled={operation.busy}>Save</button><button type="button" className="secondary" onClick={props.close}>Cancel</button></div>
  </form>;
}
