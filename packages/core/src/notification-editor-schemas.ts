import { z } from 'zod';
import { IdSchema } from './schemas.js';
import { NotificationLevelSchema, NotificationsViewSchema } from './notification-schemas.js';

export const NotificationBrowserFactsSchema = z.strictObject({ schema: z.literal('notification-browser-facts-v1'), secure: z.boolean(), notification: z.boolean(), push: z.boolean(), serviceWorker: z.boolean(), ownId: IdSchema.nullable() });
export const NotificationEditorRequestSchema = z.strictObject({ schema: z.literal('notification-editor-request-v1'), browser: NotificationBrowserFactsSchema.nullable() });
const action = z.strictObject({ path: z.string().startsWith('/api/notifications/').max(1000), method: z.enum(['POST', 'DELETE']), body: z.strictObject({ schema: z.literal('empty-request-v1') }) });
export const NotificationEditorSchema = z.strictObject({ schema: z.literal('notification-editor-v1'), view: NotificationsViewSchema,
  active: z.boolean().nullable(), canEnable: z.boolean(), statusText: z.string().min(1).max(200), blockedReason: z.string().max(1000).nullable(), helpUrl: z.url().nullable(),
  devices: z.array(NotificationsViewSchema.shape.subscriptions.element.extend({ own: z.boolean(), remove: action })),
  actions: z.strictObject({ subscribePath: z.literal('/api/notifications/subscriptions'), disable: action.nullable(), test: action }),
  native: z.strictObject({ workerWaitMs: z.number().int().positive(), refused: z.string().min(1).max(500), workerWait: z.string().min(1).max(500), keysMissing: z.string().min(1).max(500) }),
  labels: z.strictObject({ title: z.string(), enable: z.string(), disable: z.string(), test: z.string(), devices: z.string(), remove: z.string(), iphone: z.string(), empty: z.string(), addedPrefix: z.string(), testSent: z.string() }),
});
export const ProjectNotificationInfoSchema = z.strictObject({ schema: z.literal('project-notification-info-v1'),
  levels: z.array(z.strictObject({ value: NotificationLevelSchema, label: z.string().min(1).max(100), help: z.string().max(500) })).length(4), deviceHelp: z.string().min(1).max(500),
  quietHours: z.strictObject({ label: z.string(), startLabel: z.string(), endLabel: z.string(), timezoneLabel: z.string(), timePattern: z.string().min(1).max(200), timezoneMaxLength: z.number().int().positive(), help: z.string().min(1).max(500) }),
});
export type NotificationBrowserFacts = z.infer<typeof NotificationBrowserFactsSchema>;
export type NotificationEditor = z.infer<typeof NotificationEditorSchema>;
/** Platforms compute SHA-256 locally; the shared formatter never receives a browser endpoint. */
export function notificationSubscriptionId(digest: string): string { return `push_${z.string().regex(/^[a-f0-9]{64}$/u).parse(digest)}`; }
