import { memo, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CursorListSchema, CursorTranscriptSchema, CursorMessageSchema, type CursorTurn } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { Markdown, useTask, type PageProps } from './components.js';
import { MessageDelivery } from './message-delivery.js';
import './cursor-sessions.css';

export function useCursorSessions() {
  const [list, setList] = useState<z.infer<typeof CursorListSchema>>({ schema: 'cursor-list-v1', sessions: [], unavailable: [], observedAt: new Date().toISOString() });
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
    <div className="cursor-turn-label">{turn.role === 'user' ? 'You' : 'Cursor'}</div>
    {turn.blocks.map((block, index) => block.type === 'text'
      ? <Markdown key={index}>{block.text}</Markdown>
      : block.type === 'thinking'
        ? <details className="cursor-thinking" key={index}><summary>Thinking</summary><Markdown>{block.text}</Markdown></details>
        : <details className="cursor-tool" key={block.id}>
          <summary><span>{block.name}</span><span className="muted small-text">{block.state === 'running' ? 'In progress' : block.state === 'unknown' ? 'No result recorded' : block.state}</span></summary>
          {block.input && <pre><code>{block.input}</code></pre>}
          {block.output !== undefined && <><div className="cursor-output-label">Output</div><pre><code>{block.output}</code></pre></>}
        </details>)}
  </article>;
}, (previous, next) => JSON.stringify(previous.turn) === JSON.stringify(next.turn));

export function CursorConversationPage({ id, ...props }: PageProps & { id: string }) {
  const [view, setView] = useState<z.infer<typeof CursorTranscriptSchema>>();
  const [error, setError] = useState(''); const [text, setText] = useState('');
  const [mode, setMode] = useState<'steer' | 'next'>('next');
  const pending = useRef<{ id: string; text: string; mode: 'steer' | 'next' } | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null); const following = useRef(true); const opened = useRef(false);
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
    const scroll = () => { following.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180; };
    window.addEventListener('scroll', scroll, { passive: true }); void load();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('scroll', scroll); };
  }, [base, query]);
  useEffect(() => {
    if (!view) return;
    if (!opened.current || following.current) { bottom.current?.scrollIntoView({ block: 'end' }); opened.current = true; }
  }, [view]);
  useEffect(() => { if (view?.session.state !== 'working') setMode('next'); }, [view?.session.state]);
  const session = view?.session;
  const connected = !!session?.connected && !error;
  const submit = () => task.run(async () => {
    if (!text.trim() || !connected) return;
    if (!pending.current || pending.current.text !== text || pending.current.mode !== mode) pending.current = { id: `message_${clientId()}`, text, mode };
    const result = await api(`${base}/messages${query}`, CursorMessageSchema, 'POST', { schema: 'cursor-message-input-v1', clientMessageId: pending.current.id, text, mode });
    setView(current => current ? { ...current, messages: [...current.messages.filter(message => message.clientMessageId !== result.clientMessageId), result] } : current);
    pending.current = undefined; setText(''); setMode('next');
  });
  if (!view) return <p className="page-loading" role="status">{error || 'Opening Cursor conversation…'}</p>;
  return <div className="conversation-page cursor-conversation">
    <div className="section-heading conversation-heading">
      <h1>{session!.title}</h1>
      <div className="conversation-meta">
        <span className="chip">Cursor</span><span className="chip">{session!.project}</span><span className="chip">{session!.deviceName}</span>
        <span className="chip" role="status">{connected && session!.state === 'working' && <span className="activity-spinner" aria-hidden="true" />}
          {!connected ? 'Reconnecting' : session!.state === 'working' ? 'Working' : session!.state === 'idle' ? 'Idle' : 'Activity unknown'}</span>
      </div>
    </div>
    {error && <p className="notice" role="status">{error} Your last loaded messages remain below.</p>}
    <div className="cursor-transcript" aria-label="Cursor conversation">
      {view.truncated && <p className="muted small-text">Showing the most recent part of this conversation. Earlier history is available in Cursor.</p>}
      {!view.turns.length && <p className="muted">Cursor hasn’t saved any messages for this session yet.</p>}
      {view.turns.map(turn => <Turn key={turn.id} turn={turn} />)}
      {connected && session!.state === 'working' && <p className="cursor-working" role="status"><span className="activity-spinner" aria-hidden="true" />Cursor is working</p>}
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
    <form className="composer card" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label><span className="sr-only">Message Cursor</span><textarea rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="Message this Cursor conversation…" /></label>
      <div className="composer-bar"><MessageDelivery mode={mode} change={setMode} running={session!.state === 'working'} canSteer={connected && session!.canSteer} canSend={connected && session!.canSend} disabled={task.busy} cursor />
        <button disabled={task.busy || !text.trim() || !connected || !(mode === 'steer' ? session!.canSteer : session!.canSend)}>{task.busy ? 'Sending…' : mode === 'steer' ? 'Steer' : session!.state === 'working' ? 'Queue message' : 'Send'}</button>
      </div>
      {!session!.canSend && <p className="muted small-text">Viewing this session. Message delivery needs the Cursor connection hooks and a turn started in Cursor. <button type="button" className="text-button" onClick={() => props.navigate('/settings/devices')}>Connection settings</button></p>}
    </form>
    <div ref={bottom} />
  </div>;
}
