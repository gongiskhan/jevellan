import { useEffect, useRef, useState } from 'react';

type Drag = { id: string; target?: string | undefined; after: boolean; x: number; y: number; width: number; order: string[] };
type Options = { disabled: boolean; start(): void; drop(id: string, target: string, after: boolean): void };

export function useSessionDrag(options: Options) {
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef(options);
  const [drag, setDrag] = useState<Drag>();
  useEffect(() => { latest.current = options; });
  useEffect(() => {
    const element = list.current!;
    let pending: { id: string; x: number; y: number; touch: boolean } | undefined;
    let active: Drag | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0, suppressClickUntil = 0;
    const rows = () => [...element.querySelectorAll<HTMLElement>('[data-session-id]')];
    const update = (x: number, y: number) => {
      if (!active) return;
      const bounds = element.getBoundingClientRect();
      let target: string | undefined, after = false;
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
        for (const row of rows()) {
          if (row.dataset.sessionId === active.id) continue;
          const box = row.getBoundingClientRect();
          target = row.dataset.sessionId; after = y > box.top + box.height / 2;
          if (!after) break;
        }
      }
      active = { ...active, x, y, target, after }; setDrag(active);
    };
    const scroll = () => {
      if (!active) return;
      const bounds = element.getBoundingClientRect();
      if (active.x >= bounds.left && active.x <= bounds.right && active.y >= bounds.top && active.y <= bounds.bottom) {
        const edge = 44;
        const speed = active.y < bounds.top + edge ? -10 * (1 - (active.y - bounds.top) / edge)
          : active.y > bounds.bottom - edge ? 10 * (1 - (bounds.bottom - active.y) / edge) : 0;
        if (speed) { element.scrollTop += speed; update(active.x, active.y); }
      }
      frame = requestAnimationFrame(scroll);
    };
    const begin = () => {
      if (!pending || latest.current.disabled) return;
      const row = rows().find(row => row.dataset.sessionId === pending!.id);
      if (!row) return;
      active = { id: pending.id, after: false, x: pending.x, y: pending.y, width: row.getBoundingClientRect().width, order: rows().map(row => row.dataset.sessionId!) };
      setDrag(active); latest.current.start();
      frame = requestAnimationFrame(scroll);
    };
    const finish = (save = false) => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      const finished = active;
      if (active) suppressClickUntil = Date.now() + 700;
      pending = undefined; active = undefined; setDrag(undefined);
      if (save && finished?.target) latest.current.drop(finished.id, finished.target, finished.after);
    };
    const prepare = (target: EventTarget | null, x: number, y: number, touch: boolean) => {
      if (latest.current.disabled || !(target instanceof Element)) return;
      // Only the session itself starts dragging; the actions menu stays tappable.
      const button = target.closest('.conversation-row');
      const row = button?.closest<HTMLElement>('[data-session-id]');
      if (!row || !element.contains(row)) return;
      pending = { id: row.dataset.sessionId!, x, y, touch };
      if (touch) timer = setTimeout(begin, 450);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.button === 0) prepare(event.target, event.clientX, event.clientY, false);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!pending || pending.touch || event.pointerType === 'touch') return;
      if (!(event.buttons & 1)) { finish(); return; }
      if (!active && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 6) begin();
      if (active) { event.preventDefault(); update(event.clientX, event.clientY); }
    };
    const pointerUp = (event: PointerEvent) => { if (pending && !pending.touch && event.pointerType !== 'touch') finish(true); };
    const pointerCancel = (event: PointerEvent) => { if (event.pointerType !== 'touch') finish(); };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { finish(); return; }
      const point = event.touches[0]!;
      prepare(event.target, point.clientX, point.clientY, true);
    };
    const touchMove = (event: TouchEvent) => {
      if (!pending?.touch) return;
      if (event.touches.length !== 1) { finish(); return; }
      const point = event.touches[0]!;
      if (active) {
        if (!event.cancelable) { finish(); return; }
        event.preventDefault(); update(point.clientX, point.clientY);
      } else if (Math.hypot(point.clientX - pending.x, point.clientY - pending.y) > 8) finish();
    };
    const touchEnd = (event: TouchEvent) => {
      if (!pending?.touch) return;
      if (active && event.cancelable) event.preventDefault();
      finish(true);
    };
    const cancel = () => finish();
    const scrolled = () => { if (pending && !active) finish(); };
    const click = (event: MouseEvent) => { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } };
    const context = (event: MouseEvent) => { if (pending?.touch || active) event.preventDefault(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { finish(); return; }
      if (latest.current.disabled || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !(event.target instanceof Element) || !event.target.closest('.conversation-row')) return;
      const items = rows(), row = event.target.closest<HTMLElement>('[data-session-id]');
      const index = items.indexOf(row!); const after = event.key === 'ArrowDown';
      const target = items[index + (after ? 1 : -1)];
      if (row && target) { event.preventDefault(); latest.current.drop(row.dataset.sessionId!, target.dataset.sessionId!, after); }
    };
    element.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: false });
    element.addEventListener('touchend', touchEnd, { passive: false });
    element.addEventListener('touchcancel', cancel);
    element.addEventListener('scroll', scrolled, { passive: true });
    element.addEventListener('click', click, true);
    element.addEventListener('contextmenu', context);
    element.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    return () => {
      clearTimeout(timer); cancelAnimationFrame(frame);
      element.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('touchend', touchEnd);
      element.removeEventListener('touchcancel', cancel);
      element.removeEventListener('scroll', scrolled);
      element.removeEventListener('click', click, true);
      element.removeEventListener('contextmenu', context);
      element.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  return { list, drag };
}
