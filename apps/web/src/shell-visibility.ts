import { useEffect, useState } from 'react';
import { z } from 'zod';

const key = 'jevellan-shell-visibility';
const ShellVisibility = z.object({ schema: z.literal('shell-visibility-v1'), visible: z.boolean() });
function readVisibility() {
  try {
    const stored = ShellVisibility.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    if (stored.success) return stored.data.visible;
  } catch { /* Keep the default when browser storage is unavailable. */ }
  return true;
}
export function useShellVisibility() {
  const [visible, setVisible] = useState(readVisibility);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setVisible(readVisibility());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const update = (visible: boolean) => {
    setVisible(visible);
    try { localStorage.setItem(key, JSON.stringify(ShellVisibility.parse({ schema: 'shell-visibility-v1', visible }))); }
    catch { /* The switch still works for this visit. */ }
  };
  return { visible, update };
}
