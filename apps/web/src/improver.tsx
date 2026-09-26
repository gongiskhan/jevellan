import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConversationListSchema, IdSchema, ImproverJobViewSchema, ImproverStateSchema, RoutingImproverLogSchema, RoutingRevisionRecordSchema, RoutingSuggestionRowSchema,
  type DecisionComparison, type DocumentSchema, type RoutingDraft, type RoutingSuggestionRow } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Modal, dateTime, useTask, type PageProps } from './components.js';

type State = z.infer<typeof ImproverStateSchema>;
const SeenSchema = z.strictObject({ schema: z.literal('improver-seen-v1'), ids: z.array(IdSchema) });
const pending = (row: RoutingSuggestionRow) => ['pending', 'recompute'].includes(row.suggestion.status);
export function useImprover(enabled: boolean, onError: (error: unknown) => void) {
  const [state, setState] = useState<State>(); const [unseen, setUnseen] = useState<string[]>([]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api('/api/improver', ImproverStateSchema, 'GET', undefined, { signal, waitForHub: true }); setState(result);
    let seen: string[] = [];
    try { seen = SeenSchema.parse(JSON.parse(localStorage.getItem('jevellan-improver-seen') ?? 'null')).ids; } catch { /* A new browser has not seen any suggestions. */ }
    const ids = result.suggestions.filter(pending).map(row => row.suggestion.id); const fresh = ids.filter(id => !seen.includes(id));
    if (fresh.length) {
      setUnseen(previous => [...new Set([...previous, ...fresh])]);
      localStorage.setItem('jevellan-improver-seen', JSON.stringify(SeenSchema.parse({ schema: 'improver-seen-v1', ids: [...new Set([...seen, ...ids])] })));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let running = false;
    const load = async () => { if (running) return; running = true; try { await refresh(controller.signal); } catch (error) { if (!controller.signal.aborted) onError(error); } finally { running = false; } };
    void load(); const timer = setInterval(() => void load(), 5000); return () => { controller.abort(); clearInterval(timer); };
  }, [enabled, refresh, onError]);
  return { state: enabled ? state : undefined, refresh, count: enabled ? state?.suggestions.filter(pending).length ?? 0 : 0, unseen: enabled ? unseen.length : 0, consume: () => setUnseen([]) };
}
type Monitor = ReturnType<typeof useImprover>;
function useMutation() {
  const pendingRequest = useRef<{ signature: string; id: string } | undefined>(undefined);
  return async <T,>(schema: DocumentSchema<T>, operation: string, value: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const signature = JSON.stringify({ operation, value });
    if (pendingRequest.current?.signature !== signature) pendingRequest.current = { signature, id: clientId() };
    const id = pendingRequest.current.id;
    const request = operation === 'run' ? { ...value, clientRequestId: id } : { ...value, input: { ...(value.input as object), clientRequestId: id } };
    const result = await api('/api/improver', schema, 'POST', { schema: 'improver-request-v1', operation, ...request }, { signal, waitForHub: true });
    pendingRequest.current = undefined; return result;
  };
}
function Draft({ draft }: { draft: RoutingDraft }) {
  return <div className="suggestion-diff"><div><h3>Before</h3><pre className="suggestion-before">{draft.before}</pre></div><div><h3>After</h3><pre className="suggestion-after">{draft.after}</pre></div></div>;
}
function Checks({ comparison }: { comparison: DecisionComparison }) {
  const changed = comparison.cases.filter(entry => entry.change !== 'unchanged');
  const choice = (value: typeof comparison.cases[number]['before']) => [value.choice.action, value.choice.modelId, value.choice.effort].filter(Boolean).join(' · ');
  return <div className="suggestion-checks"><p>Checked against {comparison.cases.length} saved cases: {comparison.unchanged} unchanged, {comparison.better} better, {comparison.worse} worse.</p>
    {comparison.evidence === 'simulated' && <p className="muted small-text">Simulated judge responses</p>}
    {changed.length > 0 && <details><summary>Changed cases ({changed.length})</summary><ul>{changed.map(entry => <li key={entry.before.caseId}><strong>{entry.before.title} · {entry.change}</strong><p>{choice(entry.before)} → {choice(entry.after)}</p></li>)}</ul></details>}
  </div>;
}
function SuggestionCard({ row, monitor, titles, props }: { row: RoutingSuggestionRow; monitor: Monitor; titles: Record<string, string>; props: PageProps }) {
  const { suggestion } = row; const task = useTask(props.onError); const mutate = useMutation();
  const [dialog, setDialog] = useState<'change' | 'dismiss'>(); const [after, setAfter] = useState(suggestion.draft.after); const [instruction, setInstruction] = useState(''); const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState<string>(); const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!suggestion.applied || suggestion.status !== 'applied') return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [suggestion.applied, suggestion.status]);
  const request = monitor.state?.revisions.find(entry => entry.id === requestId);
  const active = monitor.state?.revisions.find(entry => entry.request.suggestionId === suggestion.id && entry.request.revision === row.revision && entry.status === 'running');
  const failure = monitor.state?.revisions.find(entry => entry.request.suggestionId === suggestion.id && entry.request.revision === row.revision && entry.status === 'failed');
  const preview = request?.status === 'complete' ? request.preview : null;
  const undo = suggestion.status === 'applied' && suggestion.applied && Date.parse(suggestion.applied.undoUntil) > now;
  const act = (kind: 'apply' | 'undo' | 'dismiss', previewId: string | null = null) => task.run(async signal => {
    const input = { schema: 'routing-suggestion-action-v1', kind, revision: row.revision, ...(kind === 'apply' ? { previewId } : kind === 'dismiss' ? { reason: reason.trim() || null } : {}) };
    const result = await mutate(RoutingSuggestionRowSchema, 'act', { suggestionId: suggestion.id, input }, signal);
    setDialog(undefined); await monitor.refresh(signal); await props.reload(signal);
    props.message(result.suggestion.status === 'recompute' ? 'The field changed. Recomputing the suggestion before you decide.' : kind === 'undo' ? 'Undone.' : kind === 'dismiss' ? 'Suggestion dismissed.' : 'Applied.');
  });
  const revise = (kind: 'text' | 'instruction' | 'recompute') => task.run(async signal => {
    const result = await mutate(RoutingRevisionRecordSchema, 'revise', { input: { schema: 'routing-revision-request-v1', kind, suggestionId: suggestion.id, revision: row.revision,
      ...(kind === 'text' ? { after } : kind === 'instruction' ? { instruction } : {}) } }, signal);
    setRequestId(result.id); await monitor.refresh(signal);
  });
  const key = suggestion.group.key; const transition = `${key.from ?? 'Auto'} → ${key.to ?? 'Auto'}`;
  return <article className="card suggestion-card" aria-label={suggestion.draft.title}><h2>{suggestion.draft.title}</h2><p>{suggestion.draft.reason}</p>
    <details><summary>Based on {suggestion.group.overrides.length} corrections ({suggestion.group.overrides.filter(entry => entry.mode === 'redo').length} with undo)</summary>
      <ul>{suggestion.group.overrides.map(entry => <li key={entry.id}><a href={`/conversations/${entry.conversationId}${entry.stretch ? `?stretch=${entry.stretch}` : ''}`} onClick={event => { event.preventDefault(); props.navigate(event.currentTarget.getAttribute('href')!); }}>{titles[entry.conversationId] ?? entry.context}</a><span className="muted"> · {dateTime(entry.at)} · {transition}</span></li>)}</ul></details>
    <Draft draft={suggestion.draft}/><Checks comparison={suggestion.comparison}/>
    {active && <p role="status">{active.request.kind === 'recompute' ? 'Recomputing against the current field…' : 'Checking a revised draft…'}</p>}
    {failure && !active && <p className="notice">{failure.error}</p>}
    {pending(row) ? <div className="actions">
      {suggestion.status === 'pending' ? <><button disabled={task.busy || !!active} onClick={() => void act('apply')}>Apply</button><button className="secondary" disabled={task.busy || !!active} onClick={() => { setRequestId(undefined); setDialog('change'); }}>Change it</button></>
        : <button disabled={task.busy || !!active} onClick={() => void revise('recompute')}>{active ? 'Recomputing…' : 'Recompute'}</button>}
      <button className="text-button" disabled={task.busy} onClick={() => setDialog('dismiss')}>Dismiss</button>
    </div> : <div className="actions"><strong>{suggestion.status === 'applied' ? 'Applied.' : suggestion.status === 'undone' ? 'Undone.' : 'Dismissed.'}</strong>{undo && <button className="secondary" disabled={task.busy} onClick={() => void act('undo')}>Undo</button>}{suggestion.outcomes.at(-1)?.reason && <span>{suggestion.outcomes.at(-1)!.reason}</span>}</div>}
    {dialog === 'dismiss' && <Modal title="Dismiss suggestion" close={() => setDialog(undefined)}><label>Why not? (optional)<input maxLength={1200} value={reason} onChange={event => setReason(event.target.value)}/></label><button disabled={task.busy} onClick={() => void act('dismiss')}>Dismiss suggestion</button></Modal>}
    {dialog === 'change' && <Modal title="Change the suggestion" close={() => setDialog(undefined)}>
      <div className="suggestion-diff"><section><label>Edit the after text<textarea rows={7} value={after} onChange={event => setAfter(event.target.value)}/></label><button disabled={task.busy || !!active || !after.trim()} onClick={() => void revise('text')}>Check this text</button></section>
        <section><label>Or say what you want instead<textarea rows={7} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="Only for UI work in ekoa-code"/></label><button disabled={task.busy || !!active || !instruction.trim()} onClick={() => void revise('instruction')}>Revise the suggestion</button></section></div>
      {active && <p role="status">Preparing and checking the revised suggestion…</p>}{request?.status === 'failed' && <p className="notice">{request.error}</p>}
      {preview && <><Draft draft={preview.draft}/><Checks comparison={preview.comparison}/><button disabled={task.busy || !!active} onClick={() => void act('apply', preview.id)}>Apply this</button></>}
      <button className="text-button" onClick={() => setDialog(undefined)}>Cancel</button>
      <details><summary>Previously checked drafts</summary>{monitor.state?.revisions.filter(entry => entry.request.suggestionId === suggestion.id && entry.request.revision === row.revision && entry.preview).map(entry => <p key={entry.id}><button className="text-button" onClick={() => setRequestId(entry.id)}>{dateTime(entry.startedAt)} · {entry.preview!.source === 'text' ? 'Edited text' : entry.preview!.instruction}</button></p>)}</details>
    </Modal>}
  </article>;
}
export function ImproverPage({ monitor, ...props }: PageProps & { monitor: Monitor }) {
  const task = useTask(props.onError); const mutate = useMutation(); const [titles, setTitles] = useState<Record<string, string>>({}); const [log, setLog] = useState<z.infer<typeof RoutingImproverLogSchema>>();
  useEffect(() => { const controller = new AbortController(); void api('/api/conversations', ConversationListSchema, 'GET', undefined, { signal: controller.signal, waitForHub: true }).then(value => setTitles(Object.fromEntries(value.conversations.map(entry => [entry.id, entry.title])))).catch(props.onError); return () => controller.abort(); }, [props.onError]);
  const rows = monitor.state?.suggestions ?? [];
  return <><div className="section-heading"><h1>Improver</h1><button disabled={task.busy || !props.data.config.configuration['x-jevellan'].improver.routing.enabled} onClick={() => void task.run(async signal => { await mutate(ImproverJobViewSchema, 'run', {}, signal); await monitor.refresh(signal); props.message('Routing suggestions started.'); })}>Run routing now</button></div>
    <p className="intro">Review suggestions drawn from your corrections. Routing changes apply only when you choose Apply.</p>
    <h2>Pending suggestions{monitor.count ? ` (${monitor.count})` : ''}</h2>{!monitor.state ? <p>Loading suggestions…</p> : !monitor.count ? <p className="muted">No pending suggestions.</p> : rows.filter(pending).map(row => <SuggestionCard key={`${row.suggestion.id}_${row.revision}`} row={row} monitor={monitor} titles={titles} props={props}/>)}
    <h2>Recently decided</h2><p className="muted small-text">The last 7 days</p>{rows.filter(row => !pending(row)).map(row => <SuggestionCard key={`${row.suggestion.id}_${row.revision}`} row={row} monitor={monitor} titles={titles} props={props}/>)}
    <section className="card"><h2>Last routing runs</h2>{!monitor.state?.jobs.length && <p className="muted">No runs yet.</p>}{monitor.state?.jobs.map(job => <div className="suggestion-run" key={job.id}><div><strong>{dateTime(job.startedAt)}</strong><p>{job.note || 'Running…'}</p></div><button className="text-button" onClick={() => void task.run(async signal => setLog(await api('/api/improver', RoutingImproverLogSchema, 'POST', { schema: 'improver-request-v1', operation: 'log', jobId: job.id }, { signal, waitForHub: true })))}>Open log</button></div>)}</section>
    {log && <Modal title="Routing run log" close={() => setLog(undefined)}><ol>{log.entries.map((entry, index) => <li key={index}><strong>{dateTime(entry.at)} · {entry.stage}</strong><p>{entry.note}</p>{entry.probability !== null && <p>Preference probability: {Math.round(entry.probability * 100)}%</p>}</li>)}</ol></Modal>}
  </>;
}
