import { useEffect, useState } from 'react';
import { NotificationEditorSchema, NotificationsViewSchema, notificationSubscriptionId, type NotificationEditor, type NotificationBrowserFacts } from '@jevellan/core/client';
import { api } from './api.js';
import { SectionHeading, dateTime, useTask, type PageProps } from './components.js';

/** Subscription discovery and WebCrypto remain local browser capabilities. */
export async function browserPushId(): Promise<string | undefined> {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const subscription = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription();
  if (!subscription) return;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return notificationSubscriptionId([...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}
export async function browserNotificationEditor(signal?: AbortSignal): Promise<NotificationEditor> {
  const browser: NotificationBrowserFacts = { schema: 'notification-browser-facts-v1', secure: window.isSecureContext, notification: 'Notification' in window,
    push: 'PushManager' in window, serviceWorker: 'serviceWorker' in navigator, ownId: await browserPushId() ?? null };
  return api('/api/notifications/editor', NotificationEditorSchema, 'POST', { schema: 'notification-editor-request-v1', browser }, { signal });
}
async function registration(native: NotificationEditor['native']): Promise<ServiceWorkerRegistration> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(native.workerWait)), native.workerWaitMs); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
export function NotificationsPage(props: PageProps) {
  const [editor, setEditor] = useState<NotificationEditor>(); const task = useTask(props.onError);
  useEffect(() => {
    const controller = new AbortController();
    void browserNotificationEditor(controller.signal).then(result => { if (!controller.signal.aborted) setEditor(result); }).catch(error => { if (!controller.signal.aborted) props.onError(error); });
    return () => controller.abort();
  }, [props.onError]);
  if (!editor) return <p role="status">Loading notifications…</p>;
  const { view, labels, native } = editor;
  const refresh = async (signal: AbortSignal) => setEditor(await browserNotificationEditor(signal));
  const run = async (action: NonNullable<NotificationEditor['actions']['disable']>, signal: AbortSignal) => {
    await api(action.path, NotificationsViewSchema, action.method, action.body, { signal, waitForHub: true }); await refresh(signal);
  };
  return <><SectionHeading title={labels.title} />
    <section className="card"><p role="status">{editor.statusText}</p><p className="hint">{labels.iphone}</p>
      {editor.blockedReason && <p className="notice">{editor.blockedReason}{editor.helpUrl && <>{' '}<a href={editor.helpUrl}>{editor.helpUrl}</a></>}</p>}
      <div className="actions">{!editor.active ? <button disabled={!editor.canEnable || task.busy} onClick={() => void task.run(async signal => {
        if (await Notification.requestPermission() !== 'granted') throw new Error(native.refused);
        const worker = await registration(native), key = Uint8Array.from(atob(view.publicKey.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
        const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.buffer });
        const value = subscription.toJSON(); if (!value.keys?.p256dh || !value.keys.auth) throw new Error(native.keysMissing);
        await api(editor.actions.subscribePath, NotificationsViewSchema, 'POST', { schema: 'push-subscription-input-v2', endpoint: subscription.endpoint, keys: value.keys, userAgent: navigator.userAgent }, { signal, waitForHub: true }); await refresh(signal);
      })}>{labels.enable}</button> : <>
        <button disabled={task.busy} onClick={() => void task.run(async signal => { await run(editor.actions.test, signal); props.message(labels.testSent); })}>{labels.test}</button>
        <button className="secondary" disabled={task.busy} onClick={() => void task.run(async signal => {
          if (!editor.actions.disable) return; await run(editor.actions.disable, signal);
          await (await registration(native)).pushManager.getSubscription().then(subscription => subscription?.unsubscribe()); await refresh(signal);
        })}>{labels.disable}</button>
      </>}</div>
    </section>
    <section className="card"><h2>{labels.devices}</h2>{editor.devices.length ? <ul className="notification-devices">{editor.devices.map(device => <li key={device.id}>
      <div><strong>{device.label}</strong><p className="hint">{labels.addedPrefix}{dateTime(device.createdAt)}</p></div>
      <button className="secondary" disabled={task.busy} onClick={() => void task.run(signal => run(device.remove, signal))}>{labels.remove}</button>
    </li>)}</ul> : <p className="hint">{labels.empty}</p>}</section>
  </>;
}
