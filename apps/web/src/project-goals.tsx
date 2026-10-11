import { useState } from 'react';
import { GoalAutonomySchema, GoalViewSchema, type GoalListViewSchema } from '@jevellan/core/client';
import type { z } from 'zod';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Confirm, Markdown, Modal, useTask } from './components.js';
export type GoalEntry = z.infer<typeof GoalListViewSchema>['goals'][number];
export function ProjectGoals({ projectId, goals, changed, onError }: { projectId: string; goals: readonly GoalEntry[]; changed(): void; onError(error: unknown): void }) {
  const [editing, setEditing] = useState<GoalEntry | 'new'>(), [done, setDone] = useState<GoalEntry>(), operation = useTask(onError);
  const update = (entry: GoalEntry, patch: object) => void operation.run(async signal => { await api(`/api/projects/${projectId}/goals/${entry.goal.id}/edit`, GoalViewSchema, 'POST', { schema: 'goal-update-request-v1', expectedRevision: entry.goal.revision, ...patch }, { signal, waitForHub: true }); changed(); setDone(undefined); });
  return <>
    <div className="actions"><button className="secondary small" onClick={() => setEditing('new')}>New goal</button></div>
    {!goals.length && <p className="pw-empty">Add a goal to explain what matters and let the coordinator propose useful work.</p>}
    {goals.map(entry => <article className="pw-goal" key={entry.goal.id} data-goal-id={entry.goal.id}>
      <header><h4>{entry.goal.name}</h4><span className="chip">{entry.goal.state === 'done' ? 'Done' : entry.goal.state === 'paused' ? 'Paused' : 'Active'}</span></header>
      <p className="muted">{entry.goal.autonomy === 'propose' ? 'Propose tasks' : 'Queue tasks automatically'}</p>
      <Markdown>{entry.goal.motivation}</Markdown>
      {entry.goal.health && <p>Health: {entry.goal.health}</p>}
      <p className="muted">{entry.counts.queued} queued · {entry.counts.active} running · {entry.counts.inReview} in review · {entry.counts.refillsToday} refilled today</p>
      <p className="muted">Refills a day: {entry.goal.dailyRefillCap} · Open pull requests: {entry.goal.openPrCap}</p>
      <div className="actions">
        {entry.goal.state !== 'done' && <button className="secondary small" disabled={operation.busy} onClick={() => update(entry, { state: entry.goal.state === 'active' ? 'paused' : 'active' })}>{entry.goal.state === 'active' ? 'Pause' : 'Reactivate'}</button>}
        <button className="secondary small" onClick={() => setEditing(entry)}>Edit</button>
        {entry.goal.state !== 'done' && <button className="secondary small" onClick={() => setDone(entry)}>Mark done</button>}
      </div>
    </article>)}
    {editing && <GoalEditor projectId={projectId} entry={editing === 'new' ? undefined : editing} saved={changed} close={() => setEditing(undefined)} onError={onError} />}
    {done && <Confirm title={`Mark "${done.goal.name}" done?`} action="Mark done" busy={operation.busy} confirm={() => update(done, { state: 'done' })} close={() => setDone(undefined)}><p>Its queued tasks stay in history and stop dispatching. Running tasks can finish.</p></Confirm>}
  </>;
}
function GoalEditor({ projectId, entry, saved, close, onError }: { projectId: string; entry?: GoalEntry | undefined; saved(): void; close(): void; onError(error: unknown): void }) {
  const goal = entry?.goal, [requestId] = useState(() => clientId());
  const [name, setName] = useState(goal?.name ?? ''), [motivation, setMotivation] = useState(goal?.motivation ?? ''), [health, setHealth] = useState(goal?.health ?? ''),
    [autonomy, setAutonomy] = useState(goal?.autonomy ?? 'propose'), [refills, setRefills] = useState(goal?.dailyRefillCap ?? 3), [prs, setPrs] = useState(goal?.openPrCap ?? 2), [state, setState] = useState(goal?.state ?? 'active');
  const operation = useTask(onError);
  return <Modal title={goal ? 'Edit goal' : 'New goal'} close={close}><form onSubmit={event => { event.preventDefault(); void operation.run(async signal => {
    const fields = { name, motivation, health, autonomy, dailyRefillCap: refills, openPrCap: prs, state };
    await api(goal ? `/api/projects/${projectId}/goals/${goal.id}/edit` : `/api/projects/${projectId}/goals`, GoalViewSchema, 'POST', goal ? { ...fields, schema: 'goal-update-request-v1', expectedRevision: goal.revision } : { ...fields, schema: 'goal-create-request-v1', clientRequestId: requestId }, { signal, waitForHub: true }); saved(); close();
  }); }}>
    <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>Motivation<textarea required rows={5} maxLength={4000} value={motivation} onChange={event => setMotivation(event.target.value)} /></label>
    <p className="pw-field-note">Why does this goal matter? The coordinator reads this to decide what to do next.</p>
    <label>Health<textarea rows={3} maxLength={1000} value={health} onChange={event => setHealth(event.target.value)} /></label>
    <p className="pw-field-note">How will you know it is going well?</p>
    <label>Autonomy<select value={autonomy} onChange={event => setAutonomy(GoalAutonomySchema.parse(event.target.value))}><option value="propose">Propose tasks</option><option value="auto">Queue tasks automatically</option></select></label>
    <label>State<select value={state} onChange={event => setState(event.target.value as typeof state)}><option value="active">Active</option><option value="paused">Paused</option>{goal?.state === 'done' && <option value="done">Done</option>}</select></label>
    <div className="form-grid"><label>Refills a day<input type="number" required min={0} max={20} value={refills} onChange={event => setRefills(Number(event.target.value))} /></label><label>Open pull requests<input type="number" required min={1} max={10} value={prs} onChange={event => setPrs(Number(event.target.value))} /></label></div>
    <div className="actions"><button disabled={operation.busy}>Save</button><button className="secondary" type="button" onClick={close}>Cancel</button></div>
  </form></Modal>;
}
