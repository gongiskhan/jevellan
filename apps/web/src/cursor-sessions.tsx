import { TranscriptTurn } from './session-transcript.js';
import { mergeTranscriptTurns } from './transcript-groups.js';
import { useSessionList } from './session-list.js';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { NativeMessageReceiptSchema, nativeRuntimePresentation, NativeListReadViewSchema, NativeTranscriptReadViewSchema,
  nativeViewerTitle, nativeConversationPresentation, nativeMessageAdmission, nativeMessageAttempt, applyNativeMessageReceipt, type NativeMessageAttempt,
  nativeReadingPolicy, nativeSessionReadRef, nativeListInitial, nativeListFailed, applyNativeListRead,
  nativeTranscriptInitial, nativeTranscriptFailed, applyNativeTranscriptRead } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { composerClearance, followOnScroll, repinAtEnd, useTask, type PageProps } from './components.js';
import { MessageDelivery, MessageInput, LatestUserMessage } from './message-delivery.js';
import './cursor-sessions.css';

export const sessionRuntimeLabel = (runtime?: string) => nativeRuntimePresentation(runtime).label;

export function useCursorSessions() {
  const [reading, setReading] = useState(nativeListInitial);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let policy = nativeReadingPolicy();
    const load = async () => {
      try { const frame = await api('/api/cursor/list-view', NativeListReadViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) { policy = frame.policy; setReading(current => applyNativeListRead(current, frame)); } }
      catch { if (!controller.signal.aborted) setReading(current => applyNativeListRead(current, nativeListFailed('', policy))); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), policy.listPollMs); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return reading.list;
}

export function CursorConversationPage({ id, navigation, ...props }: PageProps & { id: string; navigation?: ReactNode }) {
  // The heading also holds the phone navigation button, so it is named by its title alone.
  const titleId = useId();
  const query = window.location.search; const base = `/api/cursor/${id}`; const parameters = new URLSearchParams(query);
  const ref = nativeSessionReadRef({ schema: 'native-session-ref-request-v1', id, currentDeviceId: props.data.devices.currentDeviceId,
    ...(parameters.has('deviceId') ? { ownerDeviceId: parameters.get('deviceId')! } : {}), ...(parameters.has('gateway') ? { gatewayDeviceId: parameters.get('gateway')! } : {}) });
  const [reading, setReading] = useState(() => nativeTranscriptInitial(ref));
  const view = reading.view;
  const [text, setText] = useState('');
  const pending = useRef<NativeMessageAttempt | null>(null);
  const bottom = useRef<HTMLDivElement>(null); const following = useRef(true); const opened = useRef(false);
  const page = useRef<HTMLDivElement>(null); const [behind, setBehind] = useState(false);
  const task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let policy = nativeReadingPolicy();
    setReading(nativeTranscriptInitial(ref));
    const load = async () => {
      try {
        const frame = await api(base + '/read-view' + query, NativeTranscriptReadViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) { policy = frame.policy; setReading(current => applyNativeTranscriptRead(current, frame)); }
      } catch (error) { if (!controller.signal.aborted) setReading(current => applyNativeTranscriptRead(current, nativeTranscriptFailed(ref, error instanceof Error ? error.message : policy.readFailureLabel, policy))); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), policy.transcriptPollMs); }
    };
    const follows = followOnScroll(following, 180); const scroll = () => setBehind(!follows());
    // Only scrolling up unpins; a resize re-pins once the end is in view (see followOnScroll and repinAtEnd).
    const resized = () => repinAtEnd(following, 180, () => setBehind(false));
    window.addEventListener('scroll', scroll, { passive: true }); window.addEventListener('resize', resized); void load();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('scroll', scroll); window.removeEventListener('resize', resized); };
  }, [base, query, ref.ownerDeviceId, ref.gatewayDeviceId]);
  useEffect(() => {
    if (!view) return;
    if (!opened.current || following.current) { bottom.current?.scrollIntoView({ block: 'end' }); opened.current = true; }
  }, [view]);
  useEffect(() => {
    if (!page.current) return;
    const observer = new ResizeObserver(() => { repinAtEnd(following, 180, () => setBehind(false)); if (following.current) bottom.current?.scrollIntoView({ block: 'end' }); });
    observer.observe(page.current); return () => observer.disconnect();
  }, [!!view]);
  const preferences = useSessionList().preferences;
  const model = useMemo(() => nativeConversationPresentation(reading, nativeViewerTitle(props.data.devices.currentDeviceId, preferences, reading.ref)), [reading, preferences, props.data.devices.currentDeviceId]);
  const submit = (mode: 'steer' | 'next') => task.run(async () => {
    if (!nativeMessageAdmission(model, text, mode, task.busy).allowed) return;
    pending.current = nativeMessageAttempt(pending.current, reading.ref, text, mode, `message_${clientId()}`);
    const receipt = await api(`${base}/message-command`, NativeMessageReceiptSchema, 'POST', pending.current.command);
    setReading(current => applyNativeMessageReceipt(current, receipt));
    pending.current = null; setText('');
  });
  if (!view || !model) return <p className="page-loading" role="status">{reading.loadingLabel}</p>;
  const session = view.session, status = reading.presentation!;
  const runtime = model.runtime, runtimeLabel = runtime.label, isCursor = model.composer.visible;
  return <div className="conversation-page cursor-conversation" ref={page}>
    <div className="section-heading conversation-heading">
      <h1 aria-labelledby={titleId}>{navigation}<span id={titleId} className="session-title">{model.title}</span></h1>
      <div className="conversation-meta">
        <span className="chip">{runtimeLabel}</span><span className="chip">{session.project}</span><span className="chip">{session.deviceName}</span>
        {!isCursor && <span className="chip" title="Continue this session in its original application">{runtime.readOnlyLabel}</span>}
        <span className="chip" role="status">{status.working && <span className="activity-spinner" aria-hidden="true" />}{status.stateLabel}</span>
      </div>
      <LatestUserMessage text={model.latestUserMessage ?? undefined} />
    </div>
    {status.notice && <p className="notice" role="status">{status.notice}</p>}
    <div className="cursor-transcript" aria-label={`${runtimeLabel} conversation`}>
      {view.truncated && <p className="muted small-text">Showing the most recent part of this conversation. Earlier history is available in {runtimeLabel}.</p>}
      {!view.turns.length && <p className="muted">{runtimeLabel} hasn’t saved any messages for this session yet.</p>}
      {mergeTranscriptTurns(view.turns).map(turn => <TranscriptTurn key={turn.id} turn={turn} />)}
      {!!view.activity.length && <section className="cursor-live" aria-label="Recent Cursor activity">
        <h2>{status.activityTitle}</h2>
        <p className="muted small-text">Tool results and updates captured directly from this Cursor turn.</p>
        {mergeTranscriptTurns(view.activity).map(turn => <TranscriptTurn key={turn.id} turn={turn} />)}
      </section>}
    </div>
    {model.deliveries.length > 0 && <details className="cursor-deliveries" open>
      <summary>Your messages from Jevellan</summary>
      {model.deliveries.map(delivery => <div key={delivery.message.clientMessageId} className="cursor-delivery">
        <p>{delivery.message.text}</p><span className="muted small-text">{delivery.modeLabel} · {delivery.stateLabel}</span>
        {delivery.message.state === 'queued' && <button type="button" className="text-button" disabled={task.busy || !delivery.canCancel} onClick={() => void task.run(async () => {
          if (!delivery.cancel) return;
          const receipt = await api(`${base}/message-command`, NativeMessageReceiptSchema, 'POST', delivery.cancel);
          setReading(current => applyNativeMessageReceipt(current, receipt));
        })}>Cancel</button>}
      </div>)}
    </details>}
    {isCursor && <form className="composer card" ref={composerClearance} onSubmit={event => { event.preventDefault(); void submit(model.composer.primaryMode); }}>
      {(behind || status.working) && <div className="cursor-live-bar">
        {status.working && <span role="status"><span className="activity-spinner" aria-hidden="true" />{status.liveText}</span>}
        {behind && <button type="button" className="text-button jump-latest" onClick={() => { following.current = true; setBehind(false); bottom.current?.scrollIntoView({ block: 'end' }); }}>Jump to latest ↓</button>}
      </div>}
      <div className="message-input-row">
        <MessageInput value={text} change={setText} label="Message Cursor" placeholder="Message this conversation…" />
        <MessageDelivery running={model.composer.running} presentation={model.composer.delivery}
          disabled={task.busy || !text.trim()} queue={() => void submit('next')} cursor />
      </div>
    </form>}
    {!isCursor && behind && <div className="native-follow"><button type="button" className="secondary" onClick={() => { following.current = true; setBehind(false); bottom.current?.scrollIntoView({ block: 'end' }); }}>Jump to latest ↓</button></div>}
    <div ref={bottom} />
  </div>;
}
