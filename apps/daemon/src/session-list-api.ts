import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionListUpdateSchema, sessionListView } from '@jevellan/core';
import { readSessionListPreferences, saveSessionListPreferences } from '@jevellan/conversations';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

export async function handleSessionListApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname !== '/api/session-list' && url.pathname !== '/api/session-list/view') return false;
  const input = request.method === 'POST' ? SessionListUpdateSchema.parse(await requestBody(request)) : undefined;
  if (!input && request.method !== 'GET') throw Object.assign(new Error('Unsupported method.'), { status: 405 });
  const current = input ? saveSessionListPreferences(app.homes, input) : readSessionListPreferences(app.homes);
  json(response, app.redactor.document(url.pathname.endsWith('/view') ? sessionListView(app.device.deviceId, current) : current));
  return true;
}
