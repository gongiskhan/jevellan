import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { NotificationsViewSchema, PushSubscriptionSchema, ProjectNotificationSchema, PushDeliverySchema, PushKeysSchema, NotificationOwnerRequestSchema,
  ProjectDecisionSchema, ProjectSchema, StoredProjectWorkSettingsSchema, clipRedacted, type ProjectNotification, type DocumentSchema } from '@jevellan/core';
import { notificationQuestionTitle, NOTIFICATION_TEST_BODY, NOTIFICATION_TEST_TITLE } from '@jevellan/projects';
import type { HubDatabase } from '@jevellan/mesh';
export type PushSend = typeof webpush.sendNotification;
const key = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');
const time = (now: number) => new Date(now).toISOString();
export function notificationAllowed(kind: ProjectNotification['kind'], level: string): boolean {
  if (kind === 'test') return true;
  if (level === 'off') return false;
  if (kind === 'thread-finished') return level === 'everything';
  if (kind === 'coordinator-reply') return level === 'everything' || level === 'standard';
  return true;
}
/** Hub-only durable delivery, using the existing vault and document database. */
export class HubNotifications {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  #keys: ReturnType<typeof PushKeysSchema.parse> | undefined;
  constructor(readonly hub: HubDatabase, readonly url: () => string, readonly send: PushSend = webpush.sendNotification.bind(webpush), readonly now = Date.now) {
  }
  #vapid() {
    if (this.#keys) return this.#keys;
    let keys;
    try { keys = PushKeysSchema.parse(JSON.parse(this.hub.vault.forLaunch('web-push'))); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'Saved secret is unavailable.') throw error;
      keys = PushKeysSchema.parse({ schema: 'web-push-keys-v1', ...webpush.generateVAPIDKeys() }); this.hub.vault.put('web-push', JSON.stringify(keys));
    }
    this.#keys = keys; this.hub.redactor.add(keys.privateKey); return keys;
  }
  #put<T extends { revision: number }>(namespace: string, id: string, schema: DocumentSchema<T>, document: T, revision: number) {
    return this.hub.put(namespace, id, schema, { ...document, revision: revision + 1 }, revision);
  }
  start() { if (!this.#closed && !this.#timer) { this.#timer = setInterval(() => { void this.sweep().catch(() => undefined); }, 2000); this.#timer.unref(); } }
  request(raw: unknown) {
    const input = NotificationOwnerRequestSchema.parse(raw);
    if (input.operation === 'subscribe') {
      const id = `push_${key(input.input.endpoint)}`, current = this.hub.get('push-subscriptions', id, PushSubscriptionSchema);
      this.#put('push-subscriptions', id, PushSubscriptionSchema, { schema: 'push-subscription-v1', revision: 0, id, endpoint: input.input.endpoint, keys: input.input.keys, label: input.input.label, createdAt: current?.document.createdAt ?? time(this.now()), failures: current?.document.failures ?? 0 }, current?.revision ?? 0);
    } else if (input.operation === 'remove') this.hub.delete('push-subscriptions', input.id);
    else if (input.operation === 'test') this.enqueue({ schema: 'project-notification-v1', revision: 0, id: `notify_${key(time(this.now()), String(Math.random()))}`, projectId: null,
      kind: 'test', title: NOTIFICATION_TEST_TITLE, body: NOTIFICATION_TEST_BODY, url: '/', tag: 'jevellan:test', createdAt: time(this.now()) });
    return NotificationsViewSchema.parse({ schema: 'notifications-view-v1', publicKey: this.#vapid().publicKey, httpsUrl: this.url().startsWith('https://') ? this.url() : null,
      subscriptions: this.hub.list('push-subscriptions', PushSubscriptionSchema).map(({ document }) => { const { keys, endpoint, ...view } = document; void keys; void endpoint; return view; }) });
  }
  enqueue(document: ProjectNotification): void {
    if (!this.hub.get('project-notifications', document.id, ProjectNotificationSchema)) this.#put('project-notifications', document.id, ProjectNotificationSchema, document, 0);
  }
  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running) return this.#running;
    const task = this.#sweep(); this.#running = task;
    void task.finally(() => { if (this.#running === task) this.#running = undefined; }).catch(() => undefined); return task;
  }
  async #sweep(): Promise<void> {
    const now = this.now(), at = time(now), cutoff = now - 7 * 86400000;
    for (const { document } of this.hub.list('project-decisions', ProjectDecisionSchema)) {
      if (document.answer || document.withdrawnAt || Date.parse(document.createdAt) < cutoff) continue;
      const project = this.hub.get('projects', document.projectId, ProjectSchema)?.document; if (!project) continue;
      this.enqueue({ schema: 'project-notification-v1', revision: 0, id: `question_${key(document.id)}`, projectId: project.id, kind: 'needs-you',
        title: clipRedacted(this.hub.redactor.text(notificationQuestionTitle(project.name)), 80), body: clipRedacted(this.hub.redactor.text(document.question), 180),
        url: `/projects/${project.id}?view=overview`, tag: `${project.id}:decision:${document.id}`.slice(0, 100), createdAt: document.createdAt });
    }
    let notifications = this.hub.list('project-notifications', ProjectNotificationSchema);
    for (const row of notifications) if (Date.parse(row.document.createdAt) < cutoff) this.hub.delete('project-notifications', row.document.id);
    notifications = notifications.filter(row => Date.parse(row.document.createdAt) >= cutoff);
    for (const receipt of this.hub.list('push-deliveries', PushDeliverySchema)) if (!notifications.some(row => row.document.id === receipt.document.notificationId)) this.hub.delete('push-deliveries', receipt.document.id);
    // Keep only the newest pending reply, including replies received during the30-second send interval.
    const replies = this.hub.listByField('project-notifications', 'kind', 'coordinator-reply', ProjectNotificationSchema, { order: 'insertion-desc' }).filter(row => !row.document.sentAt && !row.document.dropped);
    for (const row of replies) if (replies.some(other => other.document.projectId === row.document.projectId && (other.document.createdAt > row.document.createdAt || other.document.createdAt === row.document.createdAt && replies.indexOf(other) < replies.indexOf(row)))) {
      this.#put('project-notifications', row.document.id, ProjectNotificationSchema, { ...row.document, dropped: 'Replaced by a newer coordinator reply.' }, row.revision);
    }
    const retrying = new Set(this.hub.list('push-deliveries', PushDeliverySchema).filter(row => !row.document.sentAt && !row.document.dropped).map(row => row.document.notificationId));
    for (const item of notifications) {
      if (this.#closed) break;
      if (item.document.sentAt && !retrying.has(item.document.id)) continue;
      let row = this.hub.get('project-notifications', item.document.id, ProjectNotificationSchema)!;
      if (row.document.dropped) continue;
      const notification = row.document;
      const level = notification.projectId ? this.hub.get('project-work-settings', notification.projectId, StoredProjectWorkSettingsSchema)?.document.notifications ?? 'standard' : 'everything';
      if (!notificationAllowed(notification.kind, level)) { this.#put('project-notifications', notification.id, ProjectNotificationSchema, { ...notification, dropped: 'Not enabled by the project notification setting.' }, row.revision); continue; }
      if (notification.kind === 'coordinator-reply' && !notification.sentAt && notifications.some(other => other.document.projectId === notification.projectId && other.document.kind === 'coordinator-reply' && other.document.sentAt && Date.parse(other.document.sentAt) > now - 30_000)) continue;
      const prior = this.hub.listByField('push-deliveries', 'notificationId', notification.id, PushDeliverySchema);
      const subscriptions = this.hub.list('push-subscriptions', PushSubscriptionSchema).filter(sub => !notification.sentAt || prior.some(receipt => receipt.document.subscriptionId === sub.document.id));
      let complete = subscriptions.length > 0, sent = Boolean(notification.sentAt);
      for (const subscription of subscriptions) {
        if (this.#closed) { complete = false; break; }
        const id = `delivery_${key(notification.id, subscription.document.id)}`;
        let delivery = this.hub.get('push-deliveries', id, PushDeliverySchema);
        if (!delivery) delivery = this.#put('push-deliveries', id, PushDeliverySchema, { schema: 'push-delivery-v1', revision: 0, id, notificationId: notification.id, subscriptionId: subscription.document.id, attempts: 0, nextAt: at }, 0);
        if (delivery.document.sentAt || delivery.document.dropped) continue;
        if (Date.parse(delivery.document.nextAt) > now) { complete = false; continue; }
        const attempts = delivery.document.attempts + 1;
        try {
          await this.send(subscription.document, JSON.stringify({ schema: 'project-push-v1', title: notification.title, body: notification.body, url: notification.url, tag: notification.tag }),
            { TTL: 3600, urgency: ['needs-you', 'thread-failed', 'coordinator-unavailable'].includes(notification.kind) ? 'high' : 'normal', timeout: 10_000,
              vapidDetails: { subject: 'https://gongiskhan.github.io/jevellan/', ...this.#vapid() } });
          sent = true;
          this.#put('push-deliveries', id, PushDeliverySchema, { ...delivery.document, attempts, sentAt: at }, delivery.revision);
          const current = this.hub.get('push-subscriptions', subscription.document.id, PushSubscriptionSchema);
          if (current) this.#put('push-subscriptions', current.document.id, PushSubscriptionSchema, { ...current.document, lastSentAt: at }, current.revision);
        } catch (error) {
          const code = (error as { statusCode?: number }).statusCode;
          const removed = code === 404 || code === 410;
          if (removed) this.hub.delete('push-subscriptions', subscription.document.id);
          else {
            const current = this.hub.get('push-subscriptions', subscription.document.id, PushSubscriptionSchema);
            if (current) this.#put('push-subscriptions', current.document.id, PushSubscriptionSchema, { ...current.document, failures: current.document.failures + 1 }, current.revision);
          }
          const delay = [10_000, 60_000, 300_000][attempts - 1];
          const dropped = removed ? 'The push subscription is no longer available.' : delay === undefined ? 'Push delivery failed after three retries.' : undefined;
          this.#put('push-deliveries', id, PushDeliverySchema, { ...delivery.document, attempts, ...(dropped ? { dropped } : { nextAt: time(now + delay!) }) }, delivery.revision);
          if (!dropped) complete = false;
        }
      }
      row = this.hub.get('project-notifications', notification.id, ProjectNotificationSchema)!;
      if (sent && !row.document.sentAt) this.#put('project-notifications', notification.id, ProjectNotificationSchema, { ...row.document, sentAt: at }, row.revision);
      else if (complete && !sent) this.#put('project-notifications', notification.id, ProjectNotificationSchema, { ...row.document, dropped: 'No subscription could receive this notification.' }, row.revision);
    }
  }
  async close() { this.#closed = true; if (this.#timer) clearInterval(this.#timer); await this.#running?.catch(() => undefined); }
}
