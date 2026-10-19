import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { OwnerCommandReceiptViewSchema, OwnerCommandRunReceiptSchema, type OwnerCommand } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { copyText, selectText } from './clipboard.js';

type CommandScope = { projectId: string; threadId?: string | undefined; decisionId?: string | undefined;
  deviceId?: string | undefined; cwd: 'worktree' | 'checkout'; deviceName?(id: string): string;
  deviceForThread?(id: string): string | undefined; navigate(path: string): void; onError(error: unknown): void };
const Context = createContext<CommandScope | null>(null);
function useCommandOverflow(ref: RefObject<HTMLElement | null>) {
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const pre = ref.current?.matches('pre') ? ref.current : ref.current?.querySelector('pre');
    if (!pre) return;
    const measure = () => setOverflow(pre.scrollWidth > pre.clientWidth);
    const observer = new ResizeObserver(measure); observer.observe(pre); measure(); return () => observer.disconnect();
  }, [ref]);
  return overflow;
}
export function OwnerCommandScope({ value, children }: { value: Partial<CommandScope>; children: ReactNode }) {
  const parent = useContext(Context);
  const scope = { ...parent, ...value } as CommandScope;
  if (value.threadId && !('deviceId' in value)) scope.deviceId = scope.deviceForThread?.(value.threadId);
  else if (value.deviceId === undefined) scope.deviceId = parent?.deviceId;
  return <Context.Provider value={scope}>{children}</Context.Provider>;
}
export function OwnerCommandButtons({ command }: { command: OwnerCommand }) {
  const scope = useContext(Context);
  const [requestId] = useState(clientId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ReturnType<typeof OwnerCommandRunReceiptSchema.parse>>();
  const [checking, setChecking] = useState(true);
  const projectId = scope?.projectId, threadId = scope?.threadId, decisionId = scope?.decisionId;
  const commandKey = JSON.stringify(command);
  useEffect(() => {
    if (!projectId || command.kind === 'prompt') { setChecking(false); return; }
    const controller = new AbortController(); setChecking(true); setReceipt(undefined);
    void api('/api/terminals/owner-command/receipt', OwnerCommandReceiptViewSchema, 'POST', {
      schema: 'owner-command-receipt-request-v1', projectId, ...(threadId ? { threadId } : {}), ...(decisionId ? { decisionId } : {}), command: JSON.parse(commandKey),
    }, { signal: controller.signal }).then(view => { if (!controller.signal.aborted) setReceipt(view.receipt ?? undefined); })
      .catch(() => { /* A fresh or offline card can still try its normal run path. */ }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [projectId, threadId, decisionId, commandKey, command.kind]);
  if (command.kind === 'prompt') return <div className="owner-command-actions"><button type="button" className="secondary" onClick={async event => { const pre = event.currentTarget.closest('.owner-command')?.querySelector('pre'); if (!await copyText(command.command) && pre) selectText(pre); }}>Copy</button></div>;
  if (!scope) return null;
  const run = async () => {
    if (busy || checking) return;
    if (receipt) { scope.navigate(`/terminals/${receipt.terminalId}`); return; }
    setBusy(true); setError('');
    try {
      const next = await api('/api/terminals/owner-command', OwnerCommandRunReceiptSchema, 'POST', {
        schema: 'owner-command-run-request-v1', clientRequestId: requestId, projectId: scope.projectId,
        ...(scope.threadId ? { threadId: scope.threadId } : {}), ...(scope.decisionId ? { decisionId: scope.decisionId } : {}), command,
      });
      setReceipt(next); scope.navigate(`/terminals/${next.terminalId}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); scope.onError(failure); }
    finally { setBusy(false); }
  };
  return <div className="owner-command-actions">
    <div className="actions"><button type="button" className="secondary" onClick={async event => { const pre = event.currentTarget.closest('.owner-command, .shell-command')?.querySelector('pre'); if (!await copyText(command.command) && pre) selectText(pre); }}>Copy</button>
      <button type="button" disabled={busy || checking} onClick={() => void run()}>Run in Terminal</button></div>
    {receipt && <p role="status">Ran in terminal at {new Date(receipt.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on {receipt.deviceName}{' '}
      <button type="button" className="text-button" onClick={() => scope.navigate(`/terminals/${receipt.terminalId}`)}>Open terminal</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
export function ShellCommand({ command, children }: { command: string; children: ReactNode }) {
  const scope = useContext(Context); const ref = useRef<HTMLDivElement>(null); const overflow = useCommandOverflow(ref);
  return <div className="shell-command" ref={ref}>{children}{scope && <>
    {overflow && <p className="muted small-text">Scroll sideways to read the full command.</p>}
    <OwnerCommandButtons command={{ command: command.replace(/\n$/u, ''), why: 'Run the command from this session.', cwd: scope.cwd }} /></>}</div>;
}
function CommandCard({ command }: { command: OwnerCommand }) {
  const scope = useContext(Context); const text = useRef<HTMLPreElement>(null); const overflow = useCommandOverflow(text);
  const deviceId = command.deviceId ?? scope?.deviceId;
  return <section className="owner-command" aria-label="Owner command"><p>{command.why}</p>
    <p className="muted">{command.kind === 'prompt' ? `Paste into the Claude app on ${deviceId ? scope?.deviceName?.(deviceId) ?? deviceId : 'the session device'}` : `${deviceId ? scope?.deviceName?.(deviceId) ?? deviceId : 'Session device'} · ${command.cwd}`}</p>
    <pre ref={text} tabIndex={0}><code>{command.command}</code></pre>
    {overflow && <p className="muted small-text">Scroll sideways to read the full command.</p>}
    <OwnerCommandButtons command={command} />
  </section>;
}
export function OwnerCommands({ commands }: { commands?: readonly OwnerCommand[] | undefined }) {
  return commands?.length ? <div className="owner-commands">{commands.map((command, index) => <CommandCard key={`${index}:${command.command}`} command={command} />)}</div> : null;
}
