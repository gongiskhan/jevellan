import { expect, test } from 'vitest';
import { notificationEditor } from '../packages/projects/dist/index.js';

test('notification notices link to HTTPS only for an insecure browser', () => {
  const view = { schema: 'notifications-view-v1' as const, publicKey: 'fixture', httpsUrl: 'https://fixture.example', subscriptions: [] };
  const browser = { schema: 'notification-browser-facts-v1' as const, secure: true, notification: true, push: false, serviceWorker: true, ownId: null };
  expect(notificationEditor(view, browser)).toMatchObject({ blockedReason: 'This browser does not support push notifications.', helpUrl: null });
  expect(notificationEditor(view, { ...browser, secure: false })).toMatchObject({ helpUrl: view.httpsUrl });
  expect(notificationEditor(view, null)).toMatchObject({ helpUrl: null });
});
