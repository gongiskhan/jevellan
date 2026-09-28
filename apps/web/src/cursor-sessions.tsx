import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { CursorListSchema, CursorTranscriptSchema, CursorMessageSchema, type CursorTurn } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown, useTask, type PageProps } from './components.js';
import { MessageDelivery, MessageInput, LatestUserMessage } from './message-delivery.js';
import './cursor-sessions.css';

export function useCursorSessions() {
  const [list, setList] = useState<z.infer<typeof CursorListSchema>>({ schema: 'cursor-list-v1', sessions: [], excludedSessionIds: [], unavailable: [], observedAt: new Date().toISOString() });
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { setList(await api('/api/cursor', CursorListSchema, 'GET', undefined, { signal: controller.signal })); }
      catch { if (!controller.signal.aborted) setList(current => ({ ...current, unavailable: ['Cursor sessions are reconnecting.'], sessions: current.sessions.map(row => ({ ...row, connected: false, state: 'unknown', canSteer: false, canSend: false })) })); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 3000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return list;
}
const Turn = memo(function Turn({ turn }: { turn: CursorTurn }) {
  return <article className={`cursor-turn cursor-turn-${turn.role}`}>
    <div className="cursor-turn-label">{turn.automated ? 'Cursor update' : turn.role === 'user' ? 'You' : 'Cursor'}</div>
    {turn.blocks.map((block, index) => block.type === 'text'
      ? <Markdown key={index}>{block.text}</Markdown>
      : block.type === 'thinking'
        ? <details className="cursor-thinking" key={index} open><summary>Thinking</summary><Markdown>{block.text}</Markdown></details>
        : <details className="cursor-tool" key={block.id}>
          <summary><span>{block.name}</span><span className="muted small-text">{block.state === 'running' ? 'In progress' : block.state === 'unknown' ? 'Recorded' : block.state}</span></summary>
          {block.input && <><div className="cursor-output-label">Input</div><pre><code>{block.input}</code></pre></>}
          {block.output !== undefined && <><div className="cursor-output-label">Output</div><pre><code>{block.output || 'No text output.'}</code></pre></>}
          {block.output === undefined && <p className="muted small-text">Cursor’s saved transcript does not include this tool’s result.</p>}
        </details>)}
  </article>;
}, (previous, next) => JSON.stringify(previous.turn) === JSON.stringify(next.turn));

export function CursorConversationPage({ id, navigation, ...props }: PageProps & { id: string; navigation?: ReactNode }) {
  const [view, setView] = useState<z.infer<typeof CursorTranscriptSchema>>();
  const [error, setError] = useState(''); const [text, setText] = useState('');
  const pending = useRef<{ id: string; text: string; mode: 'steer' | 'next' } | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null); const following = useRef(true); const opened = useRef(false);
  const page = useRef<HTMLDivElement>(null); const [behind, setBehind] = useState(false);
  const task = useTask(props.onError);
  const query = window.location.search; const base = `/api/cursor/${id}`;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api(base + query, CursorTranscriptSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) { setView(next); setError(''); }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Reconnecting to Cursor…'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 1500); }
    };
    const scroll = () => { following.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180; setBehind(!following.current); };
    window.addEventListener('scroll', scroll, { passive: true }); void load();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('scroll', scroll); };
  }, [base, query]);
  useEffect(() => {
    if (!view) return;
    if (!opened.current || following.current) { bottom.current?.scrollIntoView({ block: 'end' }); opened.current = true; }
  }, [view]);
  useEffect(() => {
    if (!page.current) return;
    const observer = new ResizeObserver(() => { if (following.current) bottom.current?.scrollIntoView({ block: 'end' }); });
    observer.observe(page.current); return () => observer.disconnect();
  }, [!!view]);
  const session = view?.session;
  const connected = !!session?.connected && !error;
  const submit = (mode: 'steer' | 'next') => task.run(async () => {
    if (!text.trim() || !connected || task.busy || !(mode === 'steer' ? session?.canSteer : session?.canSend)) return;
    if (!pending.current || pending.current.text !== text || pending.current.mode !== mode) pending.current = { id: `message_${clientId()}`, text, mode };
    const result = await api(`${base}/messages${query}`, CursorMessageSchema, 'POST', { schema: 'cursor-message-input-v1', clientMessageId: pending.current.id, text, mode });
    setView(current => current ? { ...current, messages: [...current.messages.filter(message => message.clientMessageId !== result.clientMessageId), result] } : current);
    pending.current = undefined; setText('');
  });
  if (!view) return <p className="page-loading" role="status">{error || 'Opening Cursor conversation…'}</p>;
  const latest = view.activity.at(-1)?.blocks.at(-1);
  const lastUser = view.turns.findLast(turn => turn.role === 'user' && !turn.automated && turn.blocks.some(block => block.type === 'text' && block.text.trim()))?.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  return <div className="conversation-page cursor-conversation" ref={page}>
    <div className="section-heading conversation-heading">
      <h1>{navigation}<span className="session-title">{session!.title}</span></h1>
      <div className="conversation-meta">
        <span className="chip">Cursor</span><span className="chip">{session!.project}</span><span className="chip">{session!.deviceName}</span>
        <span className="chip" role="status">{connected && session!.state === 'working' && <span className="activity-spinner" aria-hidden="true" />}
          {!connected ? 'Reconnecting' : session!.state === 'working' ? 'Working' : session!.state === 'idle' ? 'Idle' : 'Activity unknown'}</span>
      </div>
      <LatestUserMessage text={lastUser} />
    </div>
    {error && <p className="notice" role="status">{error} Your last loaded messages remain below.</p>}
    <div className="cursor-transcript" aria-label="Cursor conversation">
      {view.truncated && <p className="muted small-text">Showing the most recent part of this conversation. Earlier history is available in Cursor.</p>}
      {!view.turns.length && <p className="muted">Cursor hasn’t saved any messages for this session yet.</p>}
      {view.turns.map(turn => <Turn key={turn.id} turn={turn} />)}
      {!!view.activity.length && <section className="cursor-live" aria-label="Recent Cursor activity">
        <h2>{session!.state === 'working' ? 'Live updates' : 'Recent activity'}</h2>
        <p className="muted small-text">Tool results and updates captured directly from this Cursor turn.</p>
        {view.activity.map(turn => <Turn key={turn.id} turn={turn} />)}
      </section>}
    </div>
    {view.messages.filter(message => message.state !== 'cancelled').length > 0 && <details className="cursor-deliveries" open>
      <summary>Your messages from Jevellan</summary>
      {view.messages.filter(message => message.state !== 'cancelled').map(message => <div key={message.clientMessageId} className="cursor-delivery">
        <p>{message.text}</p><span className="muted small-text">{message.mode === 'steer' ? 'Steer' : 'Message'} · {message.state === 'queued' ? 'Queued' : message.state === 'handed-to-cursor' ? 'Handed to Cursor' : 'Not sent — the turn ended or changed'}</span>
        {message.state === 'queued' && <button type="button" className="text-button" disabled={task.busy || !connected} onClick={() => void task.run(async () => {
          const changed = await api(`${base}/messages/${message.clientMessageId}${query}`, CursorMessageSchema, 'DELETE');
          setView(current => current ? { ...current, messages: current.messages.map(row => row.clientMessageId === changed.clientMessageId ? changed : row) } : current);
        })}>Cancel</button>}
      </div>)}
    </details>}
    <form className="composer card" onSubmit={event => { event.preventDefault(); void submit(session!.state === 'working' ? 'steer' : 'next'); }}>
      {(behind || connected && session!.state === 'working') && <div className="cursor-live-bar">
        {connected && session!.state === 'working' && <span role="status"><span className="activity-spinner" aria-hidden="true" />Cursor is working{latest?.type === 'tool' ? ` · Last tool: ${latest.name}` : latest?.type === 'thinking' ? ' · Thinking' : ''}</span>}
        {behind && <button type="button" className="text-button" onClick={() => { following.current = true; setBehind(false); bottom.current?.scrollIntoView({ block: 'end' }); }}>Jump to latest ↓</button>}
      </div>}
      <div className="message-input-row">
        <MessageInput value={text} change={setText} label="Message Cursor" placeholder="Message this conversation…" />
        <MessageDelivery running={session!.state === 'working'} canSteer={connected && session!.canSteer} canSend={connected && session!.canSend}
          disabled={task.busy || !text.trim()} queue={() => void submit('next')} cursor />
      </div>
    </form>
    <div ref={bottom} />
  </div>;
}
