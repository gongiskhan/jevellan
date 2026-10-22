import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalListReadViewSchema, terminalOpenCommand, terminalOpenResult, terminalLauncherContext, terminalLauncherView, terminalLauncherSelection,
  terminalLauncherDeviceChoice, terminalLauncherFolderChoice, terminalLauncherFolders, terminalLaunchAttempt, terminalLauncherListRequest, terminalListReadUrl,
  terminalListInitial, terminalListFailed, applyTerminalListRead, terminalLauncherRows, type TerminalLaunchAttempt, terminalStreamInitial, terminalStreamEvent, terminalStreamReceive, terminalStreamHeartbeat, type TerminalStreamTransition, TerminalActionsViewSchema, TerminalActionReceiptSchema, TerminalCopyViewSchema, terminalActionsPolicy, terminalActionsCurrent,
  terminalCopyPlan, terminalCopyView, verifyTerminalCopyView, terminalCopyFeedback, terminalSendAttempt, terminalCloseCommand, verifyTerminalActionReceipt, terminalRunPlan, terminalOwnerClosed,
  type TerminalActionsView, type TerminalSendAttempt, TerminalTicketSchema,
  type TerminalSession, type ThreadIndex } from '@jevellan/core/client';
import { api, empty } from './api.js';
import { clientId } from './client-id.js';
import { copyPendingText, copyText } from './clipboard.js';
import { Modal, useTask, type PageProps } from './components.js';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

function fontSize() { try { const value = Number(localStorage.getItem('jevellan-terminal-font')); return value >= 10 && value <= 26 ? value : 14; } catch { return 14; } }
const bytes = (text: string) => { const input = new TextEncoder().encode(text); let binary = ''; for (const value of input) binary += String.fromCharCode(value); return btoa(binary); };
const plain = (terminal: Terminal) => { const buffer = terminal.buffer.active; let text = ''; for (let index = 0; index < buffer.length; index++) { const line = buffer.getLine(index); text += `${index && !line?.isWrapped ? '\n' : ''}${line?.translateToString(true) ?? ''}`; } return text.trimEnd(); };
async function copy(text: string) { if (!await copyText(text)) throw new Error(terminalActionsPolicy().copyFailureLabel); }

export function OpenTerminalButton({ props, projectId, threadId, deviceId, cwd, takeover, label = 'Open terminal here' }:
  { props: Pick<PageProps, 'navigate' | 'onError'>; projectId?: string; threadId?: string; deviceId?: string; cwd?: string; takeover?: boolean; label?: string }) {
  const task = useTask(props.onError), requestId = useRef(clientId());
  return <button type="button" className="secondary terminal-launch-button" disabled={task.busy} onClick={() => void task.run(async signal => {
    const result = await api('/api/terminals', TerminalTicketSchema, 'POST', terminalOpenCommand({ schema: 'terminal-open-input-v1', clientRequestId: requestId.current,
      ...(projectId ? { projectId } : {}), ...(threadId ? { threadId } : {}), ...(deviceId ? { deviceId } : {}), ...(cwd ? { cwd } : {}), ...(takeover === undefined ? {} : { takeover }) }), { signal });
    props.navigate(terminalOpenResult(result.session).url);
  })}>{label}</button>;
}

export function TerminalLauncher({ props, projectId, deviceId, threads = [], coordinatorDeviceId }:
  { props: PageProps; projectId?: string; deviceId?: string; threads?: ThreadIndex[]; coordinatorDeviceId?: string }) {
  const model = useMemo(() => terminalLauncherView(terminalLauncherContext(props.data.roster, { ...(projectId ? { projectId } : {}), ...(deviceId ? { deviceId } : {}),
    ...(coordinatorDeviceId ? { coordinatorDeviceId } : {}), threads })), [props.data.roster, projectId, deviceId, coordinatorDeviceId, threads]);
  const [choice, setChoice] = useState(() => terminalLauncherSelection(model)), task = useTask(props.onError);
  const scope = terminalLauncherListRequest(model, choice), [reading, setReading] = useState(() => terminalListInitial(scope));
  const request = useRef<TerminalLaunchAttempt | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setReading(current => terminalListInitial(scope, current));
    const load = async () => {
      try { const frame = await api(terminalListReadUrl(scope), TerminalListReadViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted) setReading(current => applyTerminalListRead(current, frame)); }
      catch { if (!controller.signal.aborted) setReading(current => applyTerminalListRead(current, terminalListFailed(scope))); }
    };
    void load(); const timer = setInterval(() => void load(), model.policy.pollMs); return () => { controller.abort(); clearInterval(timer); };
  }, [scope.projectId, scope.deviceId, choice.deviceId, model.policy.pollMs]);
  const rows = useMemo(() => terminalLauncherRows(model, reading.list), [model, reading.list]);
  return <section className="terminal-launcher" aria-label="Project terminals">
    <h2>Terminal</h2><p className="muted">Open a shell on one of your devices. It stays open when you disconnect.</p>
    <form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      request.current = terminalLaunchAttempt(request.current, model, choice, clientId());
      const result = await api('/api/terminals', TerminalTicketSchema, 'POST', request.current.command, { signal });
      props.navigate(terminalOpenResult(result.session).url);
    }); }}>
      <label>Device<select aria-label="Terminal device" value={choice.deviceId} onChange={event => setChoice(terminalLauncherDeviceChoice(model, event.target.value))}>
        {model.devices.map(row => <option key={row.id} value={row.id} disabled={row.disabled}>{row.label}</option>)}
      </select></label>
      <label>Folder<select aria-label="Terminal folder" value={choice.folder} onChange={event => setChoice(current => terminalLauncherFolderChoice(current, event.target.value))}>
        {terminalLauncherFolders(model, choice).map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
      </select></label><button disabled={task.busy}>Open terminal</button>
    </form>
    {reading.error && <p className="notice">{reading.error}</p>}
    <h3>Open terminals</h3>{rows.length ? <ul className="terminal-session-list">{rows.map(row => <li key={row.session.id}><button className="text-button" onClick={() => props.navigate(row.url)}>{row.session.title}</button><span className="muted small-text">{row.deviceName} · {row.session.cwd}</span></li>)}</ul> : <p className="muted">No open terminals.</p>}
  </section>;
}

export function TerminalPage(props: PageProps & { id: string; navigation: ReactNode }) {
  const stream = useRef(terminalStreamInitial(props.id));
  const [actionPolicy] = useState(terminalActionsPolicy), applyStream = useRef<((result: TerminalStreamTransition) => void) | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | undefined>(undefined), socket = useRef<WebSocket | undefined>(undefined);
  const fitTerminal = useRef<(() => void) | undefined>(undefined), sendRequest = useRef<TerminalSendAttempt | null>(null);
  const [session, setSession] = useState<TerminalSession>(), [state, setState] = useState(stream.current.status), [connected, setConnected] = useState(false), [approximate, setApproximate] = useState(false);
  const [size, setSize] = useState(fontSize), [text, setText] = useState(''), [direct, setDirect] = useState(false), [ctrl, setCtrl] = useState(false), [alt, setAlt] = useState(false);
  const armed = useRef({ ctrl: false, alt: false }); armed.current = { ctrl, alt };
  const [menu, setMenu] = useState(false), [selecting, setSelecting] = useState(false), [selectionText, setSelectionText] = useState(''), [copied, setCopied] = useState('');
  const [sendOpen, setSendOpen] = useState(false), [sendContent, setSendContent] = useState(actionPolicy.defaultContent), [target, setTarget] = useState(actionPolicy.defaultTarget), [actions, setActions] = useState<TerminalActionsView | null>(null);
  const currentActions = useMemo(() => terminalActionsCurrent(session, actions), [session, actions]);
  const runPlan = terminalRunPlan(stream.current, { schema: 'terminal-run-request-v1', sessionId: stream.current.sessionId, text, transportOpen: stream.current.sessionId === props.id && socket.current?.readyState === WebSocket.OPEN });
  const task = useTask(props.onError), press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = (value: string, modified = false) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const modifiers = armed.current;
    if (modified && modifiers.ctrl && value.length === 1) value = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
    if (modified && modifiers.alt) value = `\x1b${value}`;
    socket.current.send(JSON.stringify({ schema: 'terminal-frame-v1', type: 'input', data: bytes(value) }));
    if (modified) { setCtrl(false); setAlt(false); armed.current = { ctrl: false, alt: false }; }
  };
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ fontFamily: '"JetBrains Mono", monospace', fontSize: size, cursorBlink: true, scrollback: 100000, allowProposedApi: true });
    const fit = new FitAddon(), unicode = new Unicode11Addon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon((_event, url) => { window.open(url, '_blank', 'noopener,noreferrer'); })); term.loadAddon(unicode); term.unicode.activeVersion = '11'; term.open(host.current); terminal.current = term;
    const theme = () => { const colors = getComputedStyle(document.documentElement); term.options.theme = { background: colors.getPropertyValue('--card').trim(), foreground: colors.getPropertyValue('--ink').trim(), cursor: colors.getPropertyValue('--jev').trim(), selectionBackground: colors.getPropertyValue('--jev-soft').trim() }; };
    theme(); const themeObserver = new MutationObserver(theme); themeObserver.observe(document.documentElement, { attributes: true });
    const media = window.matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', theme);
    const resize = () => { try { fit.fit(); if (socket.current?.readyState === WebSocket.OPEN && stream.current.connected) socket.current.send(JSON.stringify({ schema: 'terminal-frame-v1', type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* Layout is not visible yet. */ } };
    fitTerminal.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(host.current); window.visualViewport?.addEventListener('resize', resize);
    const input = term.onData(data => send(data, true));
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    stream.current = terminalStreamInitial(props.id); setSession(undefined); setState(stream.current.status); setConnected(false); setApproximate(false);
    const accept = (result: TerminalStreamTransition, transport?: WebSocket) => {
      if (disposed || transport && transport !== socket.current) return;
      stream.current = result.state; setSession(result.state.session ?? undefined); setState(result.state.status); setConnected(result.state.connected); setApproximate(result.state.approximate);
      for (const effect of result.effects) {
        if (effect.type === 'reset') term.reset();
        else if (effect.type === 'write') term.write(Uint8Array.from(effect.data, char => char.charCodeAt(0)));
        else if (effect.type === 'close') (transport ?? socket.current)?.close();
        else if (effect.type === 'heartbeat-stop') clearInterval(heartbeat);
        else if (effect.type === 'cancel-retry') clearTimeout(timer);
        else if (effect.type === 'retry') timer = setTimeout(() => void connect(), effect.delayMs);
        else if (effect.type === 'heartbeat-start') {
          clearInterval(heartbeat); const target = transport ?? socket.current;
          heartbeat = setInterval(() => { const frame = terminalStreamHeartbeat(stream.current); if (target?.readyState === WebSocket.OPEN && frame) target.send(JSON.stringify(frame)); }, effect.intervalMs);
        }
      }
    };
    applyStream.current = accept;
    const connect = async () => {
      try {
        const receipt = await api(`/api/terminals/${props.id}/ticket`, TerminalTicketSchema, 'POST', empty); if (disposed) return;
        accept(terminalStreamEvent(stream.current, { schema: 'terminal-stream-event-v1', type: 'ticket', session: receipt.session }));
        const url = new URL(`/api/terminals/${props.id}/stream`, window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', receipt.ticket);
        const ws = new WebSocket(url); socket.current = ws;
        ws.onopen = () => { if (disposed) { ws.close(); return; } accept(terminalStreamEvent(stream.current, { schema: 'terminal-stream-event-v1', type: 'opened' }), ws); resize(); };
        ws.onmessage = event => accept(terminalStreamReceive(stream.current, String(event.data)), ws);
        ws.onerror = () => accept(terminalStreamEvent(stream.current, { schema: 'terminal-stream-event-v1', type: 'errored' }), ws);
        ws.onclose = () => accept(terminalStreamEvent(stream.current, { schema: 'terminal-stream-event-v1', type: 'transport-closed' }), ws);
      } catch (error) { if (!disposed) accept(terminalStreamEvent(stream.current, { schema: 'terminal-stream-event-v1', type: 'ticket-failed', message: error instanceof Error ? error.message : stream.current.policy.labels.unavailable })); }
    };
    void connect(); resize();
    return () => { disposed = true; if (applyStream.current === accept) applyStream.current = undefined; clearTimeout(timer); clearTimeout(press.current); clearInterval(heartbeat); socket.current?.close(); socket.current = undefined; fitTerminal.current = undefined; input.dispose(); observer.disconnect(); themeObserver.disconnect(); media.removeEventListener('change', theme); window.visualViewport?.removeEventListener('resize', resize); term.dispose(); terminal.current = undefined; };
    // Font changes update the existing terminal; reconnects never create a new PTY.
  }, [props.id]);
  useEffect(() => { if (terminal.current) { terminal.current.options.fontSize = size; fitTerminal.current?.(); } try { localStorage.setItem('jevellan-terminal-font', String(size)); } catch { /* Font still changes for this visit. */ } }, [size]);
  useEffect(() => { if (!currentActions?.canSend || !sendOpen) return; const controller = new AbortController();
    void api(`/api/terminals/${props.id}/actions-view`, TerminalActionsViewSchema, 'GET', undefined, { signal: controller.signal }).then(view => { if (!controller.signal.aborted) setActions(view); }).catch(props.onError); return () => controller.abort();
  }, [props.id, currentActions?.canSend, sendOpen, props.onError]);
  const copying = (kind: 'all' | 'last' | 'five') => void task.run(async () => {
    setCopied(''); if (!terminal.current) return;
    const plan = terminalCopyPlan({ schema: 'terminal-copy-request-v1', sessionId: props.id, kind });
    const value = plan.source === 'buffer' ? Promise.resolve(terminalCopyView(plan, { schema: 'terminal-copy-source-v1', buffer: plain(terminal.current) }).text)
      : api(`/api/terminals/${props.id}/copy-view?kind=${plan.request.kind}`, TerminalCopyViewSchema).then(view => verifyTerminalCopyView(plan.request, view).text);
    const feedback = terminalCopyFeedback(await copyPendingText(value)); setCopied(feedback.status);
    if (feedback.select) { setSelectionText(await value); setSelecting(true); }
  });
  const toolbar = <>
    <button className="secondary" disabled={task.busy} onClick={() => copying('all')}>Copy all</button><button className="secondary" disabled={task.busy} onClick={() => copying('last')}>Copy last command</button><button className="secondary" disabled={task.busy} onClick={() => copying('five')}>Copy last 5 commands</button>
    <button className="secondary" disabled={!currentActions?.canSend} onClick={() => { setSendOpen(true); setMenu(false); }}>Send to…</button>
  </>;
  const device = props.data.roster.devices.find(row => row.device.id === session?.deviceId)?.device.name ?? '';
  return <section className="owner-terminal-page" aria-label="Owner terminal">
    <header className="terminal-heading"><h1>{props.navigation}<span>{session?.title ?? 'Terminal'}</span></h1><span className="small-text terminal-location">{device}{session && ` · ${session.cwd}`}</span>
      <div className="terminal-heading-actions"><span className="terminal-status" role="status">{state}</span>{session?.projectId && <button className="text-button" onClick={() => props.navigate(`/projects/${session.projectId}`)}>Project</button>}<button className="secondary" onClick={() => void task.run(async () => { const command = terminalCloseCommand(stream.current.sessionId); const receipt = await api(`/api/terminals/${props.id}/action-command`, TerminalActionReceiptSchema, 'POST', command); verifyTerminalActionReceipt(command, receipt, stream.current.sessionId); applyStream.current?.(terminalOwnerClosed(stream.current, receipt)); })}>Close terminal</button></div>
    </header>
    <div className="terminal-toolbar">{toolbar}<span role="status">{copied}</span></div>
    <div className="terminal-host" ref={host} onPointerDown={event => { if (event.pointerType === 'touch') press.current = setTimeout(() => { if (terminal.current) { setSelectionText(plain(terminal.current)); setSelecting(true); } }, 650); }} onPointerMove={() => clearTimeout(press.current)} onPointerUp={() => clearTimeout(press.current)} onPointerCancel={() => clearTimeout(press.current)} />
    {approximate && <p className="terminal-approximate">Command boundaries are approximate in this terminal.</p>}
    <div className="terminal-keybar" aria-label="Terminal keys">
      <button disabled={!connected} onClick={() => send('\x1b', true)}>Esc</button><button disabled={!connected} onClick={() => send('\t', true)}>Tab</button>
      <button aria-pressed={ctrl} onClick={() => setCtrl(!ctrl)}>Ctrl</button><button aria-pressed={alt} onClick={() => setAlt(!alt)}>Alt</button>
      {ctrl && <button aria-label="C" disabled={!connected} onClick={() => send('c', true)}>C</button>}
      {(['↑', '↓', '←', '→'] as const).map((label, index) => <button key={label} aria-label={label} disabled={!connected} onClick={() => send(`\x1b[${['A', 'B', 'D', 'C'][index]}`, true)}>{label}</button>)}
      {['|', '~', '/', '-'].map(value => <button key={value} disabled={!connected} onClick={() => send(value, true)}>{value}</button>)}
      <button disabled={!connected} onClick={() => void task.run(async () => send(await navigator.clipboard.readText()))}>Paste</button>
      <button aria-label="Smaller terminal font" onClick={() => setSize(Math.max(10, size - 1))}>A−</button><button aria-label="Larger terminal font" onClick={() => setSize(Math.min(26, size + 1))}>A+</button>
      <button aria-label="Terminal menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
    </div>
    {menu && <div className="terminal-phone-menu">{toolbar}<button className="secondary" onClick={() => { if (terminal.current) { setSelectionText(plain(terminal.current)); setSelecting(true); setMenu(false); } }}>Select text</button><span role="status">{copied}</span></div>}
    <form className="terminal-commandline" onSubmit={event => { event.preventDefault(); const transport = socket.current, plan = terminalRunPlan(stream.current, { schema: 'terminal-run-request-v1', sessionId: stream.current.sessionId, text, transportOpen: stream.current.sessionId === props.id && transport?.readyState === WebSocket.OPEN }); if (!plan.allowed || !plan.frame) return; transport!.send(JSON.stringify(plan.frame)); setText(''); }}>
      {!direct && <><input aria-label="Type or dictate a command" placeholder="Type or dictate a command" value={text} maxLength={actionPolicy.commandMaxLength} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="send" onChange={event => setText(event.target.value)} /><button disabled={!runPlan.allowed}>Run</button></>}
      <label className="terminal-direct"><input type="checkbox" checked={direct} onChange={event => { setDirect(event.target.checked); if (event.target.checked) terminal.current?.focus(); }} />Type straight into terminal</label>
    </form>
    {selecting && <Modal title="Select terminal text" close={() => setSelecting(false)}><p>Select or long press the text to copy it.</p><textarea className="terminal-selection" readOnly value={selectionText} aria-label="Terminal output to select" onSelect={event => { const element = event.currentTarget; if (element.selectionEnd > element.selectionStart) setCopied(actionPolicy.textSelectedLabel); }} /><button onClick={() => void task.run(async () => { const element = document.querySelector<HTMLTextAreaElement>('.terminal-selection'); const value = element && element.selectionEnd > element.selectionStart ? element.value.slice(element.selectionStart, element.selectionEnd) : selectionText; await copy(value); setCopied(actionPolicy.copiedLabel); })}>Copy</button></Modal>}
    {sendOpen && <Modal title="Send terminal output" close={() => setSendOpen(false)}><form onSubmit={event => { event.preventDefault(); void task.run(async signal => {
      const model = terminalActionsCurrent(session, actions); if (!model) return;
      sendRequest.current = terminalSendAttempt(sendRequest.current, model, { schema: 'terminal-send-choice-v1', target, content: sendContent,
        activeSelection: terminal.current?.getSelection() ?? '', selectionText }, clientId());
      const command = sendRequest.current.command, receipt = await api(`/api/terminals/${props.id}/action-command`, TerminalActionReceiptSchema, 'POST', command, { signal });
      verifyTerminalActionReceipt(command, receipt, stream.current.sessionId); props.message(actionPolicy.sentLabel); setSendOpen(false); sendRequest.current = null;
    }); }}><label>Send to<select aria-label="Send terminal output to" value={target} onChange={event => setTarget(event.target.value)}>{currentActions?.targets.map(row => <option value={row.value} key={row.value}>{row.label}</option>)}</select></label>
      <label>Output<select value={sendContent} onChange={event => setSendContent(event.target.value as typeof sendContent)}>{actionPolicy.contentOptions.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select></label><button disabled={task.busy}>Send</button></form></Modal>}
  </section>;
}
