import type { IncomingMessage, ServerResponse } from 'node:http';
import { FirstRunReadRequestSchema, FirstRunNextRequestSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { readFirstRun, nextFirstRun } from './first-run-view.js';
export async function handleFirstRunApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!['/api/setup/progress', '/api/setup/next'].includes(url.pathname)) return false;
  const read = url.pathname === '/api/setup/progress';
  if (request.method !== (read ? 'GET' : 'POST')) throw Object.assign(new Error('Unsupported setup operation.'), { status: 405 });
  for (const key of url.searchParams.keys()) if (!read || key !== 'step') throw Object.assign(new Error('Unsupported setup query.'), { status: 400 });
  const result = read ? await readFirstRun(app, FirstRunReadRequestSchema.parse({ schema: 'first-run-read-request-v1', step: url.searchParams.get('step') })) : await nextFirstRun(app, FirstRunNextRequestSchema.parse(await requestBody(request)));
  json(response, app.redactor.document(result)); return true;
}
