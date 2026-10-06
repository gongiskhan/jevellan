import { applyPanelWidth, readPanelWidth, savePanelWidth } from './panel-size.js';
import { clientId } from './client-id.js';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
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
/**
 * A small confirmation (Merge, Stop, Discard, Remove token). The dialog focuses the action, or Cancel when the action is
 * destructive, so Enter never destroys by accident. `busy` disables the action while its request runs.
 */
export function Confirm({ title, children, action, danger = false, busy = false, confirm, close }: {
  title: string;
  children: ReactNode;
  action: string;
  danger?: boolean;
  busy?: boolean;
  confirm(): void;
  close(): void;
}) {
  // showModal() focuses the first element with the autofocus attribute; React's autoFocus prop does not set it.
  const initial = (element: HTMLButtonElement | null) => element?.setAttribute('autofocus', '');
  return (
    <Modal title={title} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) confirm();
        }}
      >
        {children}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close} ref={danger ? initial : undefined}>
            Cancel
          </button>
          <button className={danger ? 'danger' : ''} disabled={busy} ref={danger ? undefined : initial}>
            {action}
          </button>
        </div>
      </form>
    </Modal>
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
  const [width, setWidth] = useState(readPanelWidth);
  const dragging = useRef(false);
  const resize = (value: number) => {
    const sidebar = slot?.closest('.app-shell')?.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0;
    const maximum = innerWidth > 1180 ? innerWidth - sidebar - 380 : innerWidth * .92;
    const next = applyPanelWidth(Math.min(maximum, value));
    setWidth(next);
    return next;
  };
  useEffect(() => { applyPanelWidth(width); }, [width]);
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
      <div className="panel-resizer" role="separator" tabIndex={0} aria-label="Resize details panel"
        aria-orientation="vertical" aria-valuemin={320} aria-valuemax={2400} aria-valuenow={width}
        title="Drag to resize · arrow keys to adjust · double-click to reset"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (dragging.current) {
            resize(innerWidth - event.clientX);
          }
        }}
        onPointerUp={event => {
          dragging.current = false;
          savePanelWidth(width);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { dragging.current = false; }}
        onDoubleClick={() => savePanelWidth(resize(520))}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 520 : width + (event.key === 'ArrowLeft' ? 40 : -40);
          savePanelWidth(resize(next));
        }} />
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
/** Whether the page's end is within `margin` px of the bottom of the window; a reader there follows new content. */
const nearEnd = (margin: number) => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - margin;
/**
 * A page's scroll listener for following its end like a chat; it returns whether the reader still follows. Only the reader
 * scrolling up, farther than `margin` px from the end, unpins (and shows Jump to latest): the scrolls a browser makes while the
 * window or the content resizes never move up, so a reader who follows keeps following when the window shrinks. Scrolling back
 * near the end follows again.
 */
export function followOnScroll(pinned: { current: boolean }, margin: number): () => boolean {
  let top = window.scrollY;
  return () => {
    const up = window.scrollY < top;
    top = window.scrollY;
    pinned.current = nearEnd(margin) || (pinned.current && !up);
    return pinned.current;
  };
}
/**
 * Re-pins a reader whom the page no longer leaves behind, after a resize of the window or of the content (which never unpins). A
 * resize can bring the end into view without a scroll (a taller window, shorter content); then Jump to latest goes away, so a
 * stale live bar never grows the sticky composer over the end of the page.
 */
export function repinAtEnd(pinned: { current: boolean }, margin: number, repinned: () => void) {
  if (pinned.current || !nearEnd(margin)) return;
  pinned.current = true;
  repinned();
}
/**
 * A strip of tabs that scrolls sideways when it does not fit: it marks the ends that hide tabs (`data-more-start`,
 * `data-more-end`) for an edge fade, and centers the selected tab (`aria-current="page"`) whenever `selected` changes, so the
 * page being shown is always in view. A strip that fits is left alone.
 */
export function useTabStrip(selected: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const ends = () => {
      const hidden = strip.scrollWidth - strip.clientWidth;
      strip.toggleAttribute('data-more-start', hidden > 1 && strip.scrollLeft > 1);
      strip.toggleAttribute('data-more-end', hidden > 1 && strip.scrollLeft < hidden - 1);
    };
    ends();
    // The strip's own width and its tabs' widths (fonts, counts) both change what it hides.
    const observer = new ResizeObserver(ends);
    observer.observe(strip);
    for (const tab of strip.children) observer.observe(tab);
    strip.addEventListener('scroll', ends, { passive: true });
    return () => {
      observer.disconnect();
      strip.removeEventListener('scroll', ends);
    };
  }, []);
  useLayoutEffect(() => {
    const strip = ref.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const box = strip.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    strip.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
  }, [selected]);
  return ref;
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
