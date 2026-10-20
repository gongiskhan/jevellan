import { useEffect, useRef, useState } from 'react';
import { GoalViewSchema, ProjectGoalEditorSchema, type ProjectGoalEditor, type ProjectGoalAction, type ProjectGoalViews, type GoalListViewSchema } from '@jevellan/core/client';
import type { z } from 'zod';
import { api } from './api.js';
import { Confirm, Markdown, Modal, useTask } from './components.js';
export type GoalEntry = z.infer<typeof GoalListViewSchema>['goals'][number];
type Update = Extract<ProjectGoalAction, { kind: 'update' }>;
export function ProjectGoals({ view, changed, onError }: { view: ProjectGoalViews; changed(): void; onError(error: unknown): void }) {
  const [editing, setEditing] = useState<string>(), [confirming, setConfirming] = useState<Update>(), operation = useTask(onError);
  const update = (action: Update) => void operation.run(async signal => {
    await api(action.request.path, GoalViewSchema, 'POST', action.request.body, { signal, waitForHub: true }); changed(); setConfirming(undefined);
  });
  return <>
    <div className="actions"><button className="secondary small" onClick={() => setEditing(view.createEditorPath)}>New goal</button></div>
    {!view.rows.length && <p className="pw-empty">{view.emptyText}</p>}
    {view.rows.map(row => <article className="pw-goal" key={row.goalId} data-goal-id={row.goalId}>
      <header><h4>{row.name}</h4><span className="chip">{row.stateLabel}</span></header>
      <p className="muted">{row.autonomyLabel}</p><Markdown>{row.motivation}</Markdown>
      {row.health && <p>Health: {row.health}</p>}
      <p className="muted">{row.countsLine}</p><p className="muted">{row.capsLine}</p>
      {row.dueLine && <p className="muted">{row.dueLine}</p>}
      {row.notice && <p role="status">{row.notice}</p>}
      <div className="actions">{row.actions.map(action => action.kind === 'edit'
        ? <button key={action.name} className="secondary small" onClick={() => setEditing(action.path)}>{action.label}</button>
        : <button key={action.name} className="secondary small" disabled={operation.busy || !action.enabled} title={action.refusal ?? undefined}
          onClick={() => action.confirm ? setConfirming(action) : update(action)}>{action.label}</button>)}</div>
    </article>)}
    {editing && <GoalEditor path={editing} saved={changed} close={() => setEditing(undefined)} onError={onError} />}
    {confirming?.confirm && <Confirm title={confirming.confirm.title} action={confirming.confirm.action} busy={operation.busy} confirm={() => update(confirming)} close={() => setConfirming(undefined)}><p>{confirming.confirm.consequence}</p></Confirm>}
  </>;
}
type EditorProps = { path: string; saved(): void; close(): void; onError(error: unknown): void };
function GoalEditor(props: EditorProps) {
  const [view, setView] = useState<ProjectGoalEditor>(), fail = useRef(props.onError); fail.current = props.onError;
  useEffect(() => {
    const controller = new AbortController(); setView(undefined);
    void api(props.path, ProjectGoalEditorSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(value => { if (!controller.signal.aborted) setView(value); })
      .catch(error => { if (!controller.signal.aborted) fail.current(error); });
    return () => controller.abort();
  }, [props.path]);
  return <Modal title={view?.title ?? 'Loading goal'} close={props.close}>{view ? <GoalForm key={props.path} view={view} props={props} /> : <p role="status">Loading editor…</p>}</Modal>;
}
function GoalForm({ view, props }: { view: ProjectGoalEditor; props: EditorProps }) {
  const [fields, setFields] = useState(view.defaults), operation = useTask(props.onError);
  const set = <K extends keyof typeof fields>(key: K, value: (typeof fields)[K]) => setFields(previous => ({ ...previous, [key]: value }));
  return <form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    await api(view.request.path, GoalViewSchema, 'POST', { ...view.request.base, fields }, { signal, waitForHub: true }); props.saved(); props.close();
  }); }}>
    <label>Name<input required maxLength={view.constraints.name.maxLength} value={fields.name} onChange={event => set('name', event.target.value)} /></label>
    <label>Motivation<textarea required rows={5} maxLength={view.constraints.motivation.maxLength} value={fields.motivation} onChange={event => set('motivation', event.target.value)} /></label>
    <p className="pw-field-note">Why does this goal matter? The coordinator reads this to decide what to do next.</p>
    <label>Health<textarea rows={3} maxLength={view.constraints.health.maxLength} value={fields.health} onChange={event => set('health', event.target.value)} /></label>
    <p className="pw-field-note">How will you know it is going well?</p>
    <label>Autonomy<select value={fields.autonomy} onChange={event => set('autonomy', event.target.value)}>{view.choices.autonomy.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
    <label>State<select value={fields.state} onChange={event => set('state', event.target.value)}>{view.choices.states.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
    <div className="form-grid"><label>Refills a day<input type="number" required min={view.constraints.dailyRefillCap.min} max={view.constraints.dailyRefillCap.max} value={fields.dailyRefillCap} onChange={event => set('dailyRefillCap', event.target.value)} /></label>
      <label>Open pull requests<input type="number" required min={view.constraints.openPrCap.min} max={view.constraints.openPrCap.max} value={fields.openPrCap} onChange={event => set('openPrCap', event.target.value)} /></label></div>
    <div className="actions"><button disabled={operation.busy}>Save</button><button className="secondary" type="button" onClick={props.close}>Cancel</button></div>
  </form>;
}
