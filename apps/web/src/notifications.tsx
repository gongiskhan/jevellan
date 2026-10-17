import { useEffect, useState } from 'react';
import { NotificationsViewSchema, type NotificationsView } from '@jevellan/core/client';
import { api } from './api.js';
import { SectionHeading, dateTime, useTask, type PageProps } from './components.js';
import * as copy from './project-work-copy.js';
const empty = { schema: 'empty-request-v1' };
export async function browserPushId(): Promise<string | undefined> {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription();
  if (!subscription) return;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return 'push_' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function registration(): Promise<ServiceWorkerRegistration> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(copy.NOTIFICATIONS_WORKER_WAIT)), 15_000); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
export function NotificationsPage(props: PageProps) {
  const [view, setView] = useState<NotificationsView>(), [ownId, setOwnId] = useState<string>();
  const task = useTask(props.onError);
  const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  const secure = window.isSecureContext;
  useEffect(() => {
    const controller = new AbortController();
    void api('/api/notifications/subscriptions', NotificationsViewSchema, 'GET', undefined, { signal: controller.signal }).then(async result => {
      const id = await browserPushId(); if (!controller.signal.aborted) { setView(result); setOwnId(id); }
    }).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => controller.abort();
  }, [props.onError]);
  const active = Boolean(ownId && view?.subscriptions.some(subscription => subscription.id === ownId));
  return <><SectionHeading title={copy.NOTIFICATIONS_TITLE} />
    <section className="card"><p role="status">{active ? copy.NOTIFICATIONS_ON : copy.NOTIFICATIONS_OFF}</p>
      <p className="hint">{copy.NOTIFICATIONS_IPHONE}</p>
      {!secure && <p className="notice">{view?.httpsUrl ? <>{copy.notificationsHttps(view.httpsUrl)} <a href={view.httpsUrl}>{view.httpsUrl}</a></> : copy.NOTIFICATIONS_HTTPS_MISSING}</p>}
      {secure && !supported && <p className="notice">{copy.NOTIFICATIONS_UNSUPPORTED}</p>}
      <div className="actions">{!active ? <button disabled={!view || !secure || !supported || task.busy} onClick={() => void task.run(async signal => {
        if (await Notification.requestPermission() !== 'granted') throw new Error(copy.NOTIFICATIONS_REFUSED);
        const worker = await registration(), key = Uint8Array.from(atob(view!.publicKey.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
        const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.buffer });
        const value = subscription.toJSON(); if (!value.keys?.p256dh || !value.keys.auth) throw new Error(copy.NOTIFICATIONS_KEYS_MISSING);
        const result = await api('/api/notifications/subscriptions', NotificationsViewSchema, 'POST', { schema: 'push-subscription-input-v1', endpoint: subscription.endpoint, keys: value.keys, label: copy.notificationBrowserLabel(navigator.userAgent) }, { signal, waitForHub: true });
        setView(result); setOwnId(await browserPushId());
      })}>{copy.NOTIFICATIONS_ENABLE}</button> : <>
        <button disabled={task.busy} onClick={() => void task.run(async signal => { setView(await api('/api/notifications/test', NotificationsViewSchema, 'POST', empty, { signal })); props.message(copy.NOTIFICATIONS_TEST_SENT); })}>{copy.NOTIFICATIONS_TEST}</button>
        <button className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => {
          setView(await api(`/api/notifications/subscriptions/${ownId}`, NotificationsViewSchema, 'DELETE', empty, { signal, waitForHub: true }));
          await (await registration()).pushManager.getSubscription().then(subscription => subscription?.unsubscribe()); setOwnId(undefined);
        })}>{copy.NOTIFICATIONS_DISABLE}</button>
      </>}</div>
    </section>
    <section className="card"><h2>{copy.NOTIFICATIONS_DEVICES}</h2>{view?.subscriptions.length ? <ul className="notification-devices">{view.subscriptions.map(subscription => <li key={subscription.id}>
      <div><strong>{subscription.label}</strong><p className="hint">{copy.notificationAdded(dateTime(subscription.createdAt))}</p></div>
      <button className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => { setView(await api(`/api/notifications/subscriptions/${subscription.id}`, NotificationsViewSchema, 'DELETE', empty, { signal, waitForHub: true })); })}>{copy.REMOVE_ENV}</button>
    </li>)}</ul> : <p className="hint">{copy.NOTIFICATIONS_EMPTY}</p>}</section>
  </>;
}
