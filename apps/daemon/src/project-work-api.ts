import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmptySchema, IdSchema, MergeResultViewSchema, ThreadCreateRequestSchema, ThreadMessageReceiptSchema, ThreadMessageRequestSchema, ThreadStopRequestSchema } from '@jevellan/core';
import { REMOTE_THREADS_LATER, THREAD_NOT_FOUND } from '@jevellan/projects';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

export type ProjectWorkRouteName = 'list' | 'view' | 'thread-create' | 'thread' | 'thread-message' | 'thread-stop' | 'thread-discard' | 'thread-allow' | 'pr-merge' | 'pr-refresh';
/** Where a route runs: this device (`local`), the project's coordinator device, the thread's owner device, or any device. */
export type ProjectWorkRoute = { name: ProjectWorkRouteName; projectId?: string; threadId?: string; decisionId?: string;
  target: 'local' | 'coordinator' | 'owner' | 'any'; stream?: boolean };
type Row = { name: ProjectWorkRouteName; pattern: RegExp; method: 'GET' | 'POST'; target: ProjectWorkRoute['target'] };

// The closed route table (brief 11, design 2.10), phase 1 rows. Paths are matched whole; ids are validated after a match.
const rows: readonly Row[] = [
  { name: 'list', pattern: /^\/api\/project-work$/, method: 'GET', target: 'any' },
  { name: 'view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work$/, method: 'GET', target: 'any' },
  { name: 'thread-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads$/, method: 'POST', target: 'coordinator' },
  { name: 'thread', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)$/, method: 'GET', target: 'owner' },
  { name: 'thread-message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/messages$/, method: 'POST', target: 'owner' },
  { name: 'thread-stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/stop$/, method: 'POST', target: 'owner' },
  { name: 'thread-discard', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/discard$/, method: 'POST', target: 'owner' },
  { name: 'thread-allow', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/allow-turns$/, method: 'POST', target: 'owner' },
  { name: 'pr-merge', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/merge$/, method: 'POST', target: 'owner' },
  { name: 'pr-refresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/refresh$/, method: 'POST', target: 'owner' },
];
/** Requests carrying a client id repeat safely, so a hub outage during them is reported as retryable. */
const withClientId = new Set<ProjectWorkRouteName>(['thread-create', 'thread-message']);
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * The Projects route for a path: null for any path this table does not own (other `/api/projects/:id/...` routes such as
 * visibility, context and memory stay with `api.ts`), 405 for a known path with another method.
 */
export function projectWorkRoute(path: string, method: string): ProjectWorkRoute | null {
  for (const row of rows) {
    const match = path.match(row.pattern); if (!match) continue;
    if (method !== row.method) throw failure('This operation does not support that method.', 405);
    return { name: row.name, target: row.target, ...(match[1] === undefined ? {} : { projectId: IdSchema.parse(match[1]) }),
      ...(match[2] === undefined ? {} : { threadId: IdSchema.parse(match[2]) }) };
  }
  return null;
}

/**
 * Projects routes, called after browser authentication and origin checks (brief 11). Thread routes run on the thread's
 * owner device; before phase 5 a thread owned elsewhere is refused (D170). Actions answer 202 with the thread view after
 * the action. `token` is the browser session, for stream re-authentication and owner proxying in later phases.
 */
export async function handleProjectWorkApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string, retryable: () => void): Promise<boolean> {
  const route = projectWorkRoute(url.pathname, request.method ?? 'GET'); if (!route) return false;
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  const work = app.projectWork; await work.ready;
  const projectId = route.projectId ?? ''; const threadId = route.threadId ?? '';
  if (withClientId.has(route.name)) retryable();
  if (route.target === 'owner') {
    const owner = await work.threadOwner(projectId, threadId);
    if (owner === null) throw failure(THREAD_NOT_FOUND, 404);
    if (owner !== app.device.deviceId) throw failure(REMOTE_THREADS_LATER, 409);
  }
  switch (route.name) {
    case 'list': send(await work.list()); return true;
    case 'view': send(await work.view(projectId)); return true;
    case 'thread-create': send(await work.createThread(projectId, ThreadCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'thread': send(await work.threadView(projectId, threadId)); return true;
    case 'thread-message': {
      const { repeated } = await work.threadMessage(projectId, threadId, ThreadMessageRequestSchema.parse(await requestBody(request)));
      send(ThreadMessageReceiptSchema.parse({ schema: 'thread-message-receipt-v1', repeated }), 202); return true;
    }
    case 'pr-merge': EmptySchema.parse(await requestBody(request)); send(MergeResultViewSchema.parse(await work.mergePullRequest(projectId, threadId))); return true;
    case 'thread-stop': await work.stopThread(projectId, threadId, ThreadStopRequestSchema.parse(await requestBody(request))); break;
    case 'thread-discard': EmptySchema.parse(await requestBody(request)); await work.discardThread(projectId, threadId); break;
    case 'thread-allow': EmptySchema.parse(await requestBody(request)); await work.allowTurns(projectId, threadId); break;
    case 'pr-refresh': EmptySchema.parse(await requestBody(request)); await work.refreshPullRequest(projectId, threadId); break;
  }
  send(await work.threadView(projectId, threadId), 202); return true;
}
