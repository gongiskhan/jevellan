import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemas.js';
const revision = z.number().int().nonnegative();
const keys = z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) });
export const PushSubscriptionSchema = z.strictObject({ schema: z.literal('push-subscription-v1'), revision, id: IdSchema,
  endpoint: z.url(), keys, label: z.string().min(1).max(80), createdAt: TimestampSchema, lastSentAt: TimestampSchema.optional(), failures: z.number().int().nonnegative() });
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
const ProjectNotificationDocumentSchema = z.strictObject({ schema: z.literal('project-notification-v1'), revision, id: IdSchema, projectId: IdSchema.nullable(),
  urgent: z.boolean().optional(), kind: z.enum(['deploy', 'coordinator-reply', 'needs-you', 'thread-failed', 'thread-finished', 'coordinator-unavailable', 'test']), title: z.string().min(1).max(80), body: z.string().min(1).max(2000).refine(value => new TextEncoder().encode(value).length <= 3000, 'Push text exceeds its byte budget.'),
  url: z.string().startsWith('/').max(500).refine(path => !path.startsWith('//')), tag: z.string().min(1).max(100), createdAt: TimestampSchema, sentAt: TimestampSchema.optional(), dropped: z.string().max(200).optional() });
export const ProjectNotificationSchema = ProjectNotificationDocumentSchema.refine(value => value.kind === 'deploy' || value.body.length <= 180, 'Ordinary notification text has at most 180 characters.');
export type ProjectNotification = z.infer<typeof ProjectNotificationSchema>;
export const ProjectPushSchema = ProjectNotificationDocumentSchema.pick({ title: true, body: true, url: true, tag: true }).extend({ schema: z.literal('project-push-v1') });
export const PushKeysSchema = z.strictObject({ schema: z.literal('web-push-keys-v1'), publicKey: z.string().min(1), privateKey: z.string().min(1) });
export const PushDeliverySchema = z.strictObject({ schema: z.literal('push-delivery-v1'), revision, id: IdSchema, notificationId: IdSchema, subscriptionId: IdSchema,
  attempts: z.number().int().nonnegative(), nextAt: TimestampSchema, sentAt: TimestampSchema.optional(), dropped: z.string().max(200).optional() });
export const NotificationSubscribeSchema = z.strictObject({ schema: z.literal('push-subscription-input-v1'), endpoint: z.url(), keys, label: PushSubscriptionSchema.shape.label });
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
