import { z } from 'zod';
import { NotificationEditorSchema, ProjectNotificationInfoSchema, QuietHoursSchema, type NotificationBrowserFacts, type NotificationsView } from '@jevellan/core';

export function projectNotificationInfo() {
  return ProjectNotificationInfoSchema.parse({ schema: 'project-notification-info-v1',
    levels: [{ value: 'everything', label: 'Everything', help: 'Also each time a thread finishes a turn' }, { value: 'standard', label: 'Standard', help: 'Coordinator replies, questions for you and failures' }, { value: 'needs-you', label: 'Only what needs me', help: 'Questions for you and failures' }, { value: 'off', label: 'Off', help: '' }],
    deviceHelp: 'Turn on notifications for this device in Settings → Notifications.',
    quietHours: { label: 'Quiet hours', startLabel: 'Quiet hours start', endLabel: 'Quiet hours end', timezoneLabel: 'Quiet hours timezone', timePattern: z.toJSONSchema(QuietHoursSchema.shape.start).pattern,
      timezoneMaxLength: z.toJSONSchema(QuietHoursSchema.shape.timezone).maxLength, help: 'Updates wait until quiet hours end, then arrive as one summary. Urgent production questions arrive immediately.' } });
}
export function notificationBrowserLabel(agent: string): string {
  return `${agent.includes('Edg/') ? 'Edge' : agent.includes('Firefox/') ? 'Firefox' : agent.includes('Chrome/') ? 'Chrome' : agent.includes('Safari/') ? 'Safari' : 'Browser'} on ${/iPhone|iPad/u.test(agent) ? 'iPhone or iPad' : /Mac/u.test(agent) ? 'macOS' : /Windows/u.test(agent) ? 'Windows' : /Linux/u.test(agent) ? 'Linux' : 'this device'}`;
}
export function notificationEditor(view: NotificationsView, browser: NotificationBrowserFacts | null) {
  const active = browser ? Boolean(browser.ownId && view.subscriptions.some(row => row.id === browser.ownId)) : null;
  const blockedReason = !browser ? 'Open Notifications on this device to check browser support.' : !browser.secure ? (view.httpsUrl ? `Notifications need Jevellan's HTTPS address. Open ${view.httpsUrl} to turn them on.` : 'Notifications need an HTTPS address. Reinstall with --https to use them.') : !(browser.notification && browser.push && browser.serviceWorker) ? 'This browser does not support push notifications.' : null;
  const remove = (id: string) => ({ path: `/api/notifications/subscriptions/${id}`, method: 'DELETE', body: { schema: 'empty-request-v1' } });
  return NotificationEditorSchema.parse({ schema: 'notification-editor-v1', view, active, canEnable: active === false && blockedReason === null,
    statusText: active === null ? 'Browser notification status is unavailable here.' : active ? 'On for this device.' : 'Off for this device.', blockedReason, helpUrl: browser?.secure === false ? view.httpsUrl : null,
    devices: view.subscriptions.map(row => ({ ...row, own: row.id === browser?.ownId, remove: remove(row.id) })),
    actions: { subscribePath: '/api/notifications/subscriptions', disable: active && browser?.ownId ? remove(browser.ownId) : null, test: { path: '/api/notifications/test', method: 'POST', body: { schema: 'empty-request-v1' } } },
    native: { workerWaitMs: 15000, refused: 'Notifications are blocked for this device. Allow them in the browser settings, then try again.', workerWait: 'The app is still starting. Reload and try again.', keysMissing: 'This browser did not provide notification keys. Try turning notifications on again.' },
    labels: { title: 'Notifications', enable: 'Turn on for this device', disable: 'Turn off for this device', test: 'Send a test notification', devices: 'Devices with notifications', remove: 'Remove', iphone: 'On iPhone, add Jevellan to the Home Screen from Safari first, then turn notifications on from the installed app.', empty: 'No devices have notifications turned on.', addedPrefix: 'Added ', testSent: 'Test notification queued.' } });
}
