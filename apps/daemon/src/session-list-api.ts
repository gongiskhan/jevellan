import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionListPreferencesSchema, SessionListUpdateSchema, readDocument, writeDocument } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

export async function handleSessionListApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname !== '/api/session-list') return false;
  const path = app.homes.at('ui', 'session-list.json');
  // Parse the request before reading the current revision so concurrent writes
  // cannot both pass the revision check while awaiting the request body.
  const input = request.method === 'POST' ? SessionListUpdateSchema.parse(await requestBody(request)) : undefined;
  const current = existsSync(path) ? readDocument(path, SessionListPreferencesSchema)
    : SessionListPreferencesSchema.parse({ schema: 'session-list-preferences-v1', revision: 0, titles: {}, order: [] });
  if (input) {
    if (input.revision !== current.revision) throw Object.assign(new Error('The session list changed elsewhere. Try again with the refreshed list.'), { status: 409 });
    if (input.operation === 'rename') current.titles[input.id] = input.title;
    else current.order = [...new Set(input.order)];
    current.revision++;
    writeDocument(path, SessionListPreferencesSchema, current);
  } else if (request.method !== 'GET') throw Object.assign(new Error('Unsupported method.'), { status: 405 });
  json(response, app.redactor.document(current));
  return true;
}
