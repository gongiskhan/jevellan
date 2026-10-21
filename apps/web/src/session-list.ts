import { useEffect, useState } from 'react';
import { z } from 'zod';
import { SessionListPreferencesSchema, SessionListViewSchema, defaultSessionListPreferences, acceptSessionListPreferences, prepareSessionListUpdate } from '@jevellan/core/client';
import { api } from './api.js';

export function useSessionList() {
  const [preferences, setPreferences] = useState<z.infer<typeof SessionListPreferencesSchema>>(defaultSessionListPreferences);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let version = 0;
    const load = async () => {
      const request = ++version;
      try {
        const next = await api('/api/session-list/view', SessionListViewSchema, 'GET', undefined, { signal: controller.signal });
        if (!controller.signal.aborted && request === version) { setPreferences(current => acceptSessionListPreferences(current, next.preferences)); setReady(true); }
      } catch { /* Keep the last saved presentation during reconnects. */ }
    };
    const changed = () => void load();
    changed(); const timer = setInterval(changed, 5000);
    window.addEventListener('jevellan-session-list-updated', changed);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('jevellan-session-list-updated', changed); };
  }, []);
  const save = async (change: { operation: 'rename'; id: string; title: string } | { operation: 'order'; order: string[] }) => {
    const input = prepareSessionListUpdate(preferences, change);
    try { setPreferences((await api('/api/session-list/view', SessionListViewSchema, 'POST', input)).preferences); }
    finally { window.dispatchEvent(new Event('jevellan-session-list-updated')); }
  };
  return { preferences, ready, save };
}
