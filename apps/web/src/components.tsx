import { clientId } from './client-id.js';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Configuration, DocumentSchema } from '@jevellan/core/client';
import { api, hubWaiting, isCancelled, type SettingsData } from './api.js';
import { Icon } from './icons.js';

export type PageProps = {
  data: SettingsData;
  reload(signal?: AbortSignal): Promise<void>;
  saveConfig(configuration: Configuration, signal?: AbortSignal): Promise<void>;
  message(text: string): void;
  onError(error: unknown): void;
  navigate(path: string): void;
};
export const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const MarkdownContent = lazy(() => import('./markdown.js'));
export function Markdown({ children, onOpen }: { children: string; onOpen?(ref: string): void }) {
  return (
    <Suspense fallback={<p className="muted">Rendering…</p>}>
      <MarkdownContent {...(onOpen ? { onOpen } : {})}>{children}</MarkdownContent>
    </Suspense>
  );
}
export function Modal({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" type="button" onClick={close} aria-label="Close panel">
          <Icon name="close" />
        </button>
      </div>
      <div className="modal-body">{children}</div>
      <HubWaiting />
    </dialog>
  );
}
// Side panels (Why, Changes, evidence, memory notes) open in the inspector column next to the page
// instead of covering it. They stay non-modal so the timeline remains usable while they are open.
const openPanels: string[] = [];
export function Panel({
  title,
  eyebrow,
  children,
  close,
}: {
  title: string;
  eyebrow?: string | undefined;
  children: ReactNode;
  close(): void;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [slot] = useState(() => document.getElementById('inspector'));
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    openPanels.push(id);
    heading.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openPanels.at(-1) !== id || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      openPanels.splice(openPanels.indexOf(id), 1);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [id]);
  const panel = (
    <section className="panel" role="dialog" aria-labelledby={id}>
      <div className="panel-heading">
        <div className="panel-title">
          {eyebrow && <span className="panel-eyebrow">{eyebrow}</span>}
          <h2 id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <button className="icon-button" type="button" onClick={close} aria-label="Close panel">
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
  return slot ? createPortal(panel, slot) : panel;
}
// Menus and popovers built on <details> close when the pointer goes elsewhere or Escape is pressed.
export function useDismissible() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return ref;
}
export function useTask(onError: (error: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
    };
  }, []);
  return {
    busy,
    run: async (task: (signal: AbortSignal) => Promise<void>) => {
      if (!mounted.current || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      try {
        await task(controller.signal);
      } catch (error) {
        if (!isCancelled(error) && !controller.signal.aborted) onError(error);
      } finally {
        if (active.current === controller) {
          active.current = undefined;
          setBusy(false);
        }
      }
    },
  };
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
  return <T,>(
    path: string,
    schema: DocumentSchema<T>,
    method: string,
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    api(
      path,
      schema,
      method,
      { ...value, clientRequestId: requestId({ path, method, value }) },
      { signal, waitForHub: true },
    );
}
export function SectionHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="section-heading">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function HubWaiting() {
  const messages = useSyncExternalStore(hubWaiting.subscribe, hubWaiting.snapshot);
  return (
    messages.length > 0 && (
      <div className="toast hub-wait" role="status">
        <div>
          {messages.map((message) => (
            <p key={message}>{message}</p>
          ))}
          <p className="small-text">Stopping the wait does not undo a request already received.</p>
        </div>
        <button className="secondary" type="button" onClick={() => hubWaiting.stop()}>
          Stop waiting
        </button>
      </div>
    )
  );
}
