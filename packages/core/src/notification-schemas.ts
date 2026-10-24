import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
const revision = z.number().int().nonnegative();
export const NotificationLevelSchema = z.enum(['everything', 'standard', 'needs-you', 'off']);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
// Supported names are stable within one Intl implementation, including aliases. Never cache a refusal.
const supportedTimeZones = new Set<string>();
let timeZoneImplementation = Intl.DateTimeFormat;
export function supportedTimeZone(value: string): boolean {
  if (timeZoneImplementation !== Intl.DateTimeFormat) { supportedTimeZones.clear(); timeZoneImplementation = Intl.DateTimeFormat; }
  if (supportedTimeZones.has(value)) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { return false; }
  if (supportedTimeZones.size >= 256) { const first = supportedTimeZones.values().next().value; if (first !== undefined) supportedTimeZones.delete(first); }
  supportedTimeZones.add(value); return true;
}
export const QuietHoursSchema = z.strictObject({ enabled: z.boolean(), start: clock, end: clock,
  timezone: z.string().min(1).max(120).refine(supportedTimeZone, 'Use a supported time zone.') });
export const defaultQuietHours = { enabled: false, start: '23:00', end: '08:00', timezone: 'Europe/Lisbon' };
export const ProjectNotificationPreferencesSchema = z.strictObject({ level: NotificationLevelSchema, quietHours: QuietHoursSchema.default(() => ({ ...defaultQuietHours })) });
export const defaultProjectNotifications = { level: 'standard' as const, quietHours: defaultQuietHours };
const keys = z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) });
export const PushSubscriptionSchema = z.strictObject({ schema: z.literal('push-subscription-v1'), revision, id: IdSchema,
  endpoint: z.url(), keys, label: z.string().min(1).max(80), createdAt: TimestampSchema, lastSentAt: TimestampSchema.optional(), failures: z.number().int().nonnegative() });
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
const ProjectNotificationDocumentSchema = z.strictObject({ schema: z.literal('project-notification-v1'), revision, id: IdSchema, projectId: IdSchema.nullable(),
  heldAt: TimestampSchema.optional(), updateCount: z.number().int().positive().optional(), urgent: z.boolean().optional(), kind: z.enum(['deploy', 'coordinator-reply', 'needs-you', 'thread-failed', 'thread-finished', 'coordinator-unavailable', 'quiet-summary', 'test']), title: z.string().min(1).max(80), body: z.string().min(1).max(2000).refine(value => new TextEncoder().encode(value).length <= 3000, 'Push text exceeds its byte budget.'),
  url: z.string().startsWith('/').max(500).refine(path => !path.startsWith('//')), tag: z.string().min(1).max(100), createdAt: TimestampSchema, sentAt: TimestampSchema.optional(), dropped: z.string().max(200).optional() });
export const ProjectNotificationSchema = ProjectNotificationDocumentSchema.refine(value => value.kind === 'deploy' || value.body.length <= 180, 'Ordinary notification text has at most 180 characters.');
export type ProjectNotification = z.infer<typeof ProjectNotificationSchema>;
export const ProjectPushSchema = ProjectNotificationDocumentSchema.pick({ title: true, body: true, url: true, tag: true }).extend({ schema: z.literal('project-push-v1') });
export const PushKeysSchema = z.strictObject({ schema: z.literal('web-push-keys-v1'), publicKey: z.string().min(1), privateKey: z.string().min(1) });
export const PushDeliverySchema = z.strictObject({ schema: z.literal('push-delivery-v1'), revision, id: IdSchema, notificationId: IdSchema, subscriptionId: IdSchema,
  attempts: z.number().int().nonnegative(), nextAt: TimestampSchema, sentAt: TimestampSchema.optional(), dropped: z.string().max(200).optional() });
export const NotificationSubscribeSchema = z.strictObject({ schema: z.literal('push-subscription-input-v1'), endpoint: z.url(), keys, label: PushSubscriptionSchema.shape.label });
export const NotificationBrowserSubscribeSchema = z.strictObject({ schema: z.literal('push-subscription-input-v2'), endpoint: z.url(), keys, userAgent: z.string().max(4000) });
export const NotificationOwnerRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema: z.literal('notifications-owner-request-v1'), operation: z.literal('view'), ownerSession: z.string().min(1).max(4096) }),
  z.strictObject({ schema: z.literal('notifications-owner-request-v1'), operation: z.literal('subscribe'), ownerSession: z.string().min(1).max(4096), input: NotificationSubscribeSchema }),
  z.strictObject({ schema: z.literal('notifications-owner-request-v1'), operation: z.literal('remove'), ownerSession: z.string().min(1).max(4096), id: IdSchema }),
  z.strictObject({ schema: z.literal('notifications-owner-request-v1'), operation: z.literal('test'), ownerSession: z.string().min(1).max(4096) }),
]);
export const NotificationsViewSchema = z.strictObject({ schema: z.literal('notifications-view-v1'), publicKey: z.string().min(1), httpsUrl: z.url().nullable(),
  subscriptions: z.array(PushSubscriptionSchema.omit({ keys: true, endpoint: true })) });
export type NotificationsView = z.infer<typeof NotificationsViewSchema>;
export const VapidPublicKeySchema = z.strictObject({ schema: z.literal('vapid-public-key-v1'), publicKey: z.string().min(1) });
