import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ConversationPlanReadSchema, planContentView, type PlanContentView, type PlanNode } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown } from './components.js';

export { decodePlan } from '@jevellan/core/client';
export function PlanContent({ content, view, open }: { content?: unknown; view?: PlanContentView | undefined; open(ref: string): void }) {
  const render = (node: PlanNode): ReactNode => {
    if (node.kind === 'markdown') return <Markdown onOpen={open}>{node.text}</Markdown>;
    if (node.kind === 'muted') return <span className="muted">{node.text}</span>;
    if (node.kind === 'value') return <span>{node.text}</span>;
    if (node.kind === 'list') { const List = node.ordered ? 'ol' : 'ul'; return <List className="plan-list">{node.items.map((item, index) => <li key={index}>{render(item)}</li>)}</List>; }
    return <div className={node.topLevel ? 'plan-sections' : 'plan-fields'}>
      {node.title && <div className="plan-item-title">{render(node.title)}</div>}
      {node.sections.map(section => <section className="plan-section" key={section.key}>
        {section.headingLevel === 3 ? <h3>{section.heading}</h3> : section.headingLevel === 4 ? <h4>{section.heading}</h4> : null}
        {render(section.value)}
      </section>)}
    </div>;
  };
  return <div className="plan-content">{render((view ?? planContentView(content)).root)}</div>;
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
  const [result, setResult] = useState<{ pointer: string; view: PlanContentView }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const request = useRef<{ text: string; id: string } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); setFailed(false);
    void api(`/api/conversations/${id}/plan-read`, ConversationPlanReadSchema, 'POST', { schema: 'conversation-plan-read-request-v1', pointer }, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setResult({ pointer, view: value.view }); })
      .catch(error => { if (!abort.signal.aborted) { setFailed(true); onError(error); } });
    return () => abort.abort();
  }, [id, pointer, attempt, onError]);
  const loaded = result?.pointer === pointer;
  const busy = sending || actions?.busy;
  const run = async (action: () => Promise<void>) => { setSending(true); try { await action(); setEditing(false); setFeedback(''); } catch (error) { onError(error); } finally { setSending(false); } };
  return <section className="plan-review" id={`plan-step-${step}`} aria-label={`Plan from step ${step}`}>
    <header className="plan-review-header"><h2>Proposed plan</h2><span className={`chip ${actions ? 'plan-awaiting' : ''}`}>{actions ? 'Awaiting approval' : approved ? 'Approved' : 'Recorded plan'}</span></header>
    {actions && <p className="plan-intro">Read the proposal below. Implementation will wait until you approve it.</p>}
    {loaded ? <PlanContent view={result.view} open={open} /> : failed ? <div className="notice">Could not load the full plan. <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry loading plan</button></div> : <p role="status">Loading the full plan…</p>}
    {actions && <footer className="plan-review-footer">
      {editing ? <form onSubmit={event => { event.preventDefault(); if (!feedback.trim() || busy) return; if (request.current?.text !== feedback) request.current = { text: feedback, id: `message_${clientId()}` }; void run(() => actions.changes(feedback, request.current!.id)); }}>
        <label>What should change?<textarea autoFocus rows={3} value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy} placeholder="Describe the changes you want in the plan…" /></label>
        <div className="actions"><button disabled={busy || !feedback.trim()}>Send requested changes</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
      </form> : <div className="actions"><button disabled={busy || !loaded} onClick={() => void run(actions.approve)}>Approve plan</button><button className="secondary" disabled={busy || !loaded} onClick={() => setEditing(true)}>Request changes</button></div>}
    </footer>}
  </section>;
}
