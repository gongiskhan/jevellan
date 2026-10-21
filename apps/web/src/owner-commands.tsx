import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { OwnerCommandViewSchema, OwnerCommandRunReceiptSchema, mergeOwnerCommandScope, ownerCommandPresentation, ownerCommandReadRequest, ownerCommandRunRequest, shellOwnerCommand, type OwnerCommand } from '@jevellan/core/client';
import { api } from './api.js';
import { clientId } from './client-id.js';
import { copyText, selectText } from './clipboard.js';
type CommandScope = { projectId: string; threadId?: string | undefined; decisionId?: string | undefined; deviceId?: string | undefined; cwd: 'worktree' | 'checkout'; deviceName?(id: string): string; deviceForThread?(id: string): string | undefined; navigate(path: string): void; onError(error: unknown): void };
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
  const parent = useContext(Context), scope = { ...parent, ...value } as CommandScope;
  const facts = mergeOwnerCommandScope(parent ?? undefined, value, id => scope.deviceForThread?.(id));
  return <Context.Provider value={{ ...scope, deviceId: facts.deviceId }}>{children}</Context.Provider>;
}
function useOwnerCommand(command: OwnerCommand) {
  const scope = useContext(Context), [requestId] = useState(clientId), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ReturnType<typeof OwnerCommandRunReceiptSchema.parse>>(), [checking, setChecking] = useState(true);
  const [prepared, setPrepared] = useState<ReturnType<typeof OwnerCommandViewSchema.parse>['presentation']>();
  const projectId = scope?.projectId, threadId = scope?.threadId, decisionId = scope?.decisionId, deviceId = scope?.deviceId, commandKey = JSON.stringify(command);
  useEffect(() => {
    if (!projectId || command.kind === 'prompt') { setChecking(false); return; }
    const controller = new AbortController(); setChecking(true); setReceipt(undefined); setPrepared(undefined);
    void api('/api/terminals/owner-command/view', OwnerCommandViewSchema, 'POST', ownerCommandReadRequest({ projectId, threadId, decisionId, deviceId }, JSON.parse(commandKey)), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setPrepared(value.presentation); setReceipt(value.presentation.receipt ?? undefined); } })
      .catch(() => { /* A fresh or offline card can still try its normal run path. */ }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [projectId, threadId, decisionId, deviceId, commandKey, command.kind]);
  const target = command.deviceId ?? scope?.deviceId ?? prepared?.deviceId ?? undefined;
  const view = ownerCommandPresentation(command, { deviceId: target, deviceName: target ? scope?.deviceName?.(target) ?? prepared?.deviceName ?? target : undefined, receipt });
  const run = async () => {
    if (!scope || busy || checking) return;
    if (receipt) { scope.navigate(view.receiptPath!); return; }
    setBusy(true); setError('');
    try { const next = await api('/api/terminals/owner-command', OwnerCommandRunReceiptSchema, 'POST', ownerCommandRunRequest(scope, command, requestId)); setReceipt(next); scope.navigate(`/terminals/${next.terminalId}`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); scope.onError(failure); }
    finally { setBusy(false); }
  };
  return { scope, view, receipt, busy, checking, error, run };
}
function CommandButtons({ command, state }: { command: OwnerCommand; state: ReturnType<typeof useOwnerCommand> }) {
  const { scope, view, receipt, busy, checking, error, run } = state;
  if (view.copyOnly) return <div className="owner-command-actions"><button type="button" className="secondary" onClick={async event => { const pre = event.currentTarget.closest('.owner-command')?.querySelector('pre'); if (!await copyText(command.command) && pre) selectText(pre); }}>{view.copyLabel}</button></div>;
  if (!scope) return null;
  return <div className="owner-command-actions">
    <div className="actions"><button type="button" className="secondary" onClick={async event => { const pre = event.currentTarget.closest('.owner-command, .shell-command')?.querySelector('pre'); if (!await copyText(command.command) && pre) selectText(pre); }}>{view.copyLabel}</button>
      <button type="button" disabled={busy || checking} onClick={() => void run()}>{view.runLabel}</button></div>
    {receipt && <p role="status">{view.receiptPrefix} {new Date(receipt.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {view.receiptConnector} {receipt.deviceName}{' '}
      <button type="button" className="text-button" onClick={() => scope.navigate(view.receiptPath!)}>{view.openLabel}</button></p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
export function OwnerCommandButtons({ command }: { command: OwnerCommand }) { const state = useOwnerCommand(command); return <CommandButtons command={command} state={state} />; }
export function ShellCommand({ command, children }: { command: string; children: ReactNode }) {
  const scope = useContext(Context), ref = useRef<HTMLDivElement>(null), overflow = useCommandOverflow(ref);
  return <div className="shell-command" ref={ref}>{children}{scope && <>
    {overflow && <p className="muted small-text">{ownerCommandPresentation(shellOwnerCommand(command, scope.cwd), {}).overflowText}</p>}
    <OwnerCommandButtons command={shellOwnerCommand(command, scope.cwd)} /></>}</div>;
}
function CommandCard({ command }: { command: OwnerCommand }) {
  const state = useOwnerCommand(command), text = useRef<HTMLPreElement>(null), overflow = useCommandOverflow(text);
  return <section className="owner-command" aria-label="Owner command"><p>{command.why}</p><p className="muted">{state.view.header}</p>
    <pre ref={text} tabIndex={0}><code>{command.command}</code></pre>
    {overflow && <p className="muted small-text">{state.view.overflowText}</p>}
    <CommandButtons command={command} state={state} />
  </section>;
}
export function OwnerCommands({ commands }: { commands?: readonly OwnerCommand[] | undefined }) { return commands?.length ? <div className="owner-commands">{commands.map((command, index) => <CommandCard key={`${index}:${command.command}`} command={command} />)}</div> : null; }
