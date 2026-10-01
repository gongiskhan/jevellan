import { z } from 'zod';

const preferenceKey = 'jevellan-panel-size';
const PanelSize = z.object({ schema: z.literal('panel-size-v1'), width: z.number().min(320).max(2400) });
export function readPanelWidth(): number {
  try {
    const value = PanelSize.safeParse(JSON.parse(localStorage.getItem(preferenceKey) ?? 'null'));
    if (value.success) return value.data.width;
  } catch { /* Storage may be unavailable. */ }
  return 520;
}
export function applyPanelWidth(width: number): number {
  const next = Math.round(Math.max(320, Math.min(2400, width)));
  document.documentElement.style.setProperty('--inspector-width', `${next}px`);
  return next;
}
export function savePanelWidth(width: number) {
  try { localStorage.setItem(preferenceKey, JSON.stringify(PanelSize.parse({ schema: 'panel-size-v1', width }))); }
  catch { /* Resizing still works without browser storage. */ }
}
