import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmptySchema, IdSchema, NotificationSubscribeSchema, VapidPublicKeySchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
export async function handleNotificationsApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string): Promise<boolean> {
  if (!url.pathname.startsWith('/api/notifications/')) return false;
  const method = request.method ?? 'GET'; const path = url.pathname;
  if (['/api/notifications/subscriptions', '/api/notifications/vapid-public-key'].includes(path) && method === 'GET') {
    const view = await app.notificationsRequest({ schema: 'notifications-owner-request-v1', operation: 'view' }, token);
    json(response, path.endsWith('vapid-public-key') ? VapidPublicKeySchema.parse({ schema: 'vapid-public-key-v1', publicKey: view.publicKey }) : view); return true;
  }
  if (path === '/api/notifications/subscriptions' && method === 'POST') {
    json(response, await app.notificationsRequest({ schema: 'notifications-owner-request-v1', operation: 'subscribe', input: NotificationSubscribeSchema.parse(await requestBody(request)) }, token)); return true;
  }
  const remove = path.match(/^\/api\/notifications\/subscriptions\/([A-Za-z0-9_-]+)$/u);
  if (remove && method === 'DELETE') { EmptySchema.parse(await requestBody(request)); json(response, await app.notificationsRequest({ schema: 'notifications-owner-request-v1', operation: 'remove', id: IdSchema.parse(remove[1]) }, token)); return true; }
  if (path === '/api/notifications/test' && method === 'POST') {
    EmptySchema.parse(await requestBody(request)); json(response, await app.notificationsRequest({ schema: 'notifications-owner-request-v1', operation: 'test' }, token)); return true;
  }
  throw Object.assign(new Error('Notification operation not found.'), { status: 404 });
}
