import { useState, useSyncExternalStore } from 'react';
import { z } from 'zod';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type PwaState = { installed: boolean; offline: boolean; prompt?: InstallPrompt | undefined; waiting?: ServiceWorker | undefined; error?: string | undefined };
const standalone = window.matchMedia('(display-mode: standalone)');
let state: PwaState = { installed: standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone), offline: !navigator.onLine };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;
function update(patch: Partial<PwaState>) { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); }
const usePwa = () => useSyncExternalStore(subscribe, snapshot);
const UpdateMessageSchema = z.object({ schema: z.literal('pwa-message-v1'), action: z.literal('activate-update') });
let started = false;
let reloadRequested = false;
let registration: ServiceWorkerRegistration | undefined;

export function startPwa() {
  if (started) return;
  started = true;
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); update({ prompt: event as InstallPrompt }); });
  window.addEventListener('appinstalled', () => update({ installed: true, prompt: undefined }));
  standalone.addEventListener('change', () => update({ installed: standalone.matches }));
  let lastCheck = 0;
  window.addEventListener('offline', () => update({ offline: true }));
  window.addEventListener('online', () => { update({ offline: false }); checkUpdate(); });
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only the window whose user pressed Reload may reload, preserving other drafts.
    if (reloadRequested) window.location.reload();
    else update({ waiting: undefined });
  });
  function checkUpdate() {
    if (!registration || !navigator.onLine || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    void registration.update().catch(() => undefined);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((value) => {
    registration = value;
    const waiting = () => { if (value.waiting) update({ waiting: value.waiting }); };
    waiting();
    const watch = () => {
      const worker = value.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') waiting(); });
    };
    value.addEventListener('updatefound', watch);
    watch();
  }).catch(() => update({ error: 'Offline support could not be prepared. Reopen Jevellan when your connection is available.' }));
}

async function install() {
  const prompt = state.prompt;
  if (!prompt) return;
  update({ prompt: undefined, error: undefined });
  try { await prompt.prompt(); await prompt.userChoice; }
  catch { update({ error: 'Use your browser’s menu to install Jevellan, or reopen this page and try again.' }); }
}
function activateUpdate() {
  const worker = state.waiting;
  if (!worker || reloadRequested) return;
  if (worker.state === 'activated' || worker.state === 'redundant') { window.location.reload(); return; }
  reloadRequested = true;
  worker.postMessage(UpdateMessageSchema.parse({ schema: 'pwa-message-v1', action: 'activate-update' }));
}

export function InstallAppButton({ navigate }: { navigate: (path: string) => void }) {
  const pwa = usePwa();
  if (pwa.installed) return null;
  return <button className="settings-link" onClick={() => pwa.prompt ? void install() : navigate('/settings/about')}>
    <img src="/icon-192.png" width="20" height="20" alt="" className="pwa-small-icon"/>Install app
  </button>;
}

export function PwaInstallCard() {
  const pwa = usePwa();
  return <section className="card pwa-install-card">
    <div className="pwa-install-heading"><img src="/icon-192.png" width="56" height="56" alt=""/><div><h2>{pwa.installed ? 'Jevellan is installed' : 'Jevellan, one tap away'}</h2><p className="muted">Open your conversations in their own app window.</p></div></div>
    {!pwa.installed && <>
      {pwa.prompt && <button onClick={() => void install()}>Install Jevellan</button>}
      <dl className="pwa-instructions">
        <dt>iPhone or iPad</dt><dd>Open this address in Safari. Choose Share, then Add to Home Screen. Keep Open as Web App enabled if shown.</dd>
        <dt>Android</dt><dd>Open this address in Chrome. Choose Install app or Add to Home screen from the browser menu.</dd>
        <dt>Desktop</dt><dd>Use the install icon in Chrome or Edge’s address bar. In Safari on Mac, choose File → Add to Dock.</dd>
      </dl>
    </>}
    <p className="muted">Keep Tailscale connected and Jevellan running on your host device. Installation may ask you to sign in again.</p>
    {pwa.error && <p role="status">{pwa.error}</p>}
    {pwa.waiting && <div><p>An update is ready. Finish your message before reloading.</p><button className="secondary" onClick={activateUpdate}>Reload to update</button></div>}
  </section>;
}

export function PwaStatus() {
  const pwa = usePwa();
  const [dismissed, setDismissed] = useState<ServiceWorker>();
  if (pwa.offline) return <aside className="pwa-notice" role="status"><strong>You’re offline</strong><span>Reconnect to receive activity and send messages.</span></aside>;
  if (!pwa.waiting || dismissed === pwa.waiting) return null;
  return <aside className="pwa-notice" aria-label="App update">
    <div role="status"><strong>An update is ready</strong><span>Finish your message, then reload.</span></div>
    <div className="actions"><button className="secondary" onClick={() => setDismissed(pwa.waiting)}>Later</button><button onClick={activateUpdate}>Reload</button></div>
  </aside>;
}
