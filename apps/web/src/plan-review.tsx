import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ConversationReadSchema } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown } from './components.js';

const label = (key: string) => key.replace(/([a-z\d])([A-Z])/g, (_, left: string, right: string) => `${left} ${right.toLowerCase()}`).replace(/[_-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
const priority = ['title', 'goal', 'summary', 'overview', 'scope', 'steps', 'phases', 'architecture', 'affectedFiles', 'checks', 'tests', 'risks', 'decisionsNeeded', 'questions'];
function entries(value: object) {
  return Object.entries(value).sort(([a], [b]) => (priority.includes(a) ? priority.indexOf(a) : priority.length) - (priority.includes(b) ? priority.indexOf(b) : priority.length));
}
export function decodePlan(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  if (/^[{[]/.test(text)) {
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object') return value; } catch { /* Existing Markdown remains readable as written. */ }
  }
  return content;
}
export function PlanContent({ content, open }: { content: unknown; open(ref: string): void }) {
  const render = (value: unknown, depth = 0, ordered = false): ReactNode => {
    if (typeof value === 'string') return <Markdown onOpen={open}>{value}</Markdown>;
    if (value === null || value === undefined) return <span className="muted">Not specified</span>;
    if (typeof value !== 'object') return <span>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value)}</span>;
    if (Array.isArray(value)) {
      if (!value.length) return <span className="muted">None</span>;
      const List = ordered ? 'ol' : 'ul';
      return <List className="plan-list">{value.map((item, index) => <li key={index}>{render(item, depth + 1)}</li>)}</List>;
    }
    const fields = entries(value);
    const title = depth > 0 ? fields.find(([key, item]) => ['title', 'name'].includes(key) && typeof item === 'string') : undefined;
    return <div className={depth === 0 ? 'plan-sections' : 'plan-fields'}>
      {title && <div className="plan-item-title">{render(title[1], depth + 1)}</div>}
      {fields.filter(([key]) => key !== title?.[0]).map(([key, item]) => <section className="plan-section" key={key}>
        {depth === 0 ? <h3>{label(key)}</h3> : !['details', 'description'].includes(key) && <h4>{label(key)}</h4>}
        {render(item, depth + 1, ['steps', 'phases', 'tasks'].includes(key))}
      </section>)}
    </div>;
  };
  return <div className="plan-content">{render(decodePlan(content))}</div>;
}
export type PlanReviewActions = {
  busy: boolean;
  approve(): Promise<void>;
  changes(text: string, clientMessageId: string): Promise<void>;
};
export function PlanReview({ id, pointer, step, approved, actions, open, onError }: {
  id: string; pointer: string; step: number; approved: boolean; actions?: PlanReviewActions | undefined;
  open(ref: string): void; onError(error: unknown): void;
}) {
  const [result, setResult] = useState<{ pointer: string; content: unknown }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const request = useRef<{ text: string; id: string } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); setFailed(false);
    void api(`/api/conversations/${id}/read?pointer=${encodeURIComponent(pointer)}`, ConversationReadSchema, 'GET', undefined, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setResult({ pointer, content: value.content }); })
      .catch(error => { if (!abort.signal.aborted) { setFailed(true); onError(error); } });
    return () => abort.abort();
  }, [id, pointer, attempt, onError]);
  const loaded = result?.pointer === pointer;
  const busy = sending || actions?.busy;
  const run = async (action: () => Promise<void>) => { setSending(true); try { await action(); setEditing(false); setFeedback(''); } catch (error) { onError(error); } finally { setSending(false); } };
  return <section className="plan-review" id={`plan-step-${step}`} aria-label={`Plan from step ${step}`}>
    <header className="plan-review-header"><h2>Proposed plan</h2><span className={`chip ${actions ? 'plan-awaiting' : ''}`}>{actions ? 'Awaiting approval' : approved ? 'Approved' : 'Recorded plan'}</span></header>
    {actions && <p className="plan-intro">Read the proposal below. Implementation will wait until you approve it.</p>}
    {loaded ? <PlanContent content={result.content} open={open} /> : failed ? <div className="notice">Could not load the full plan. <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry loading plan</button></div> : <p role="status">Loading the full plan…</p>}
    {actions && <footer className="plan-review-footer">
      {editing ? <form onSubmit={event => { event.preventDefault(); if (!feedback.trim() || busy) return; if (request.current?.text !== feedback) request.current = { text: feedback, id: `message_${clientId()}` }; void run(() => actions.changes(feedback, request.current!.id)); }}>
        <label>What should change?<textarea autoFocus rows={3} value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy} placeholder="Describe the changes you want in the plan…" /></label>
        <div className="actions"><button disabled={busy || !feedback.trim()}>Send requested changes</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
      </form> : <div className="actions"><button disabled={busy || !loaded} onClick={() => void run(actions.approve)}>Approve plan</button><button className="secondary" disabled={busy || !loaded} onClick={() => setEditing(true)}>Request changes</button></div>}
    </footer>}
  </section>;
}
