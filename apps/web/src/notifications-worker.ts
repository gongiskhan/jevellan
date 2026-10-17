import { ProjectPushSchema } from '@jevellan/core/client';
type Client = { url: string; focused?: boolean; visibilityState?: string; focus(): Promise<Client>; navigate(url: string): Promise<Client | null> };
type PushEvent = { data?: { json(): unknown }; waitUntil(work: Promise<unknown>): void };
type ClickEvent = { notification: { data: unknown; close(): void }; waitUntil(work: Promise<unknown>): void };
const worker = globalThis as unknown as {
  location: { origin: string };
  clients: { matchAll(options: { type: string; includeUncontrolled?: boolean }): Promise<Client[]>; openWindow(url: string): Promise<Client | null> };
  registration: { showNotification(title: string, options: { body: string; tag: string; data: { url: string }; icon: string; badge: string }): Promise<void> };
  addEventListener(name: 'push', handler: (event: PushEvent) => void): void;
  addEventListener(name: 'notificationclick', handler: (event: ClickEvent) => void): void;
};
worker.addEventListener('push', event => {
  let raw: unknown; try { raw = event.data?.json(); } catch { return; }
  const parsed = ProjectPushSchema.safeParse(raw); if (!parsed.success) return;
  event.waitUntil((async () => {
    const notification = parsed.data, path = new URL(notification.url, worker.location.origin).pathname;
    const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some(client => client.focused && client.visibilityState === 'visible' && new URL(client.url).pathname === path)) return;
    await worker.registration.showNotification(notification.title, { body: notification.body, tag: notification.tag, data: { url: notification.url }, icon: '/icon-192.png', badge: '/favicon-32.png' });
  })());
});
worker.addEventListener('notificationclick', event => {
  event.notification.close();
  const parsed = ProjectPushSchema.shape.url.safeParse((event.notification.data as { url?: unknown } | null)?.url); if (!parsed.success) return;
  event.waitUntil((async () => {
    const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find(client => new URL(client.url).origin === worker.location.origin);
    if (client) { await client.focus(); await client.navigate(parsed.data); } else await worker.clients.openWindow(parsed.data);
  })());
});
