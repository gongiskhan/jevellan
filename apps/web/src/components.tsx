import { clientId } from './client-id.js';
import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Configuration, DocumentSchema } from '@jevellan/core/client';
import { api, hubWaiting, isCancelled, type SettingsData } from './api.js';

export type PageProps = { data: SettingsData; reload(signal?: AbortSignal): Promise<void>; saveConfig(configuration: Configuration, signal?: AbortSignal): Promise<void>; message(text: string): void; onError(error: unknown): void; navigate(path: string): void };
export const dateTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const MarkdownContent = lazy(() => import('./markdown.js'));
export function Markdown({ children, onOpen }: { children: string; onOpen?(ref: string): void }) { return <Suspense fallback={<p className="muted">Rendering…</p>}><MarkdownContent {...(onOpen ? { onOpen } : {})}>{children}</MarkdownContent></Suspense>; }
export function Modal({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-labelledby={id} onCancel={(event) => { event.preventDefault(); close(); }}><div className="modal-heading"><h2 id={id}>{title}</h2><button className="icon-button" type="button" onClick={close} aria-label="Close panel">×</button></div>{children}<HubWaiting/></dialog>;
}
export function useTask(onError: (error: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); active.current = undefined; }; }, []);
  return { busy, run: async (task: (signal: AbortSignal) => Promise<void>) => {
    if (!mounted.current || active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    try { await task(controller.signal); } catch (error) { if (!isCancelled(error) && !controller.signal.aborted) onError(error); }
    finally { if (active.current === controller) { active.current = undefined; setBusy(false); } }
  } };
}
export function useRequestId() {
  const pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  return (value: unknown) => {
    const signature = JSON.stringify(value);
    if (pending.current?.signature !== signature) pending.current = { signature, id: clientId() };
    return pending.current.id;
  };
}
export function useSettingsSave() {
  const requestId = useRequestId();
  return <T,>(path: string, schema: DocumentSchema<T>, method: string, value: Record<string, unknown>, signal?: AbortSignal) => api(path, schema, method, { ...value, clientRequestId: requestId({ path, method, value }) }, { signal, waitForHub: true });
}
export function SectionHeading({ title, children }: { title: string; children?: ReactNode }) { return <div className="section-heading"><h1>{title}</h1>{children}</div>; }

export function HubWaiting() {
  const messages = useSyncExternalStore(hubWaiting.subscribe, hubWaiting.snapshot);
  return messages.length > 0 && <div className="toast hub-wait" role="status"><div>{messages.map(message => <p key={message}>{message}</p>)}<p className="small-text">Stopping the wait does not undo a request already received.</p></div><button className="secondary" type="button" onClick={() => hubWaiting.stop()}>Stop waiting</button></div>;
}
