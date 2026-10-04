import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CoordinatorMessageReceiptSchema, CoordinatorMessageRequestSchema, DecisionAnswerRequestSchema, DecisionAnsweredViewSchema, EmptySchema, IdSchema, MergeResultViewSchema,
  NotebookRequestSchema, ProjectEventFrameSchema, ProjectWorkSettingsRequestSchema, ThreadCreateRequestSchema, ThreadMessageReceiptSchema, ThreadMessageRequestSchema,
  ThreadOverrideRequestSchema, ThreadStopRequestSchema, type ProjectLedgerEvent,
} from '@jevellan/core';
import { EVENT_CURSOR_AHEAD, EVENT_CURSOR_INVALID, REMOTE_THREADS_LATER, THREAD_NOT_FOUND, publicProjectData, type ProjectLedger } from '@jevellan/projects';
import type { Application } from './application.js';
import { streamLedger, type LedgerStreamFrame } from './conversation-events.js';
import { json, requestBody } from './http.js';

export type ProjectWorkRouteName = 'list' | 'view' | 'events' | 'message' | 'stop' | 'fresh' | 'settings' | 'notebook' | 'thread-create' | 'thread' | 'thread-message'
  | 'thread-stop' | 'thread-discard' | 'thread-allow' | 'thread-override' | 'pr-merge' | 'pr-refresh' | 'answer';
/** Where a route runs: this device (`local`), the project's coordinator device, the thread's owner device, or any device. */
export type ProjectWorkRoute = { name: ProjectWorkRouteName; projectId?: string; threadId?: string; decisionId?: string;
  target: 'local' | 'coordinator' | 'owner' | 'any'; stream?: boolean };
type IdName = 'projectId' | 'threadId' | 'decisionId';
/** `ids` names the captured ids in order (default project then thread); `stream` marks the event stream. */
type Row = { name: ProjectWorkRouteName; pattern: RegExp; methods: readonly ('GET' | 'POST' | 'PUT')[]; target: ProjectWorkRoute['target']; ids?: readonly IdName[]; stream?: true };

// The closed route table (brief 11, design 2.10), phases 1 to 4. Paths are matched whole; ids are validated after a match.
const rows: readonly Row[] = [
  { name: 'list', pattern: /^\/api\/project-work$/, methods: ['GET'], target: 'any' },
  { name: 'view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work$/, methods: ['GET'], target: 'any' },
  { name: 'events', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/events$/, methods: ['GET'], target: 'coordinator', stream: true },
  { name: 'message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/messages$/, methods: ['POST'], target: 'coordinator' },
  { name: 'stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/stop$/, methods: ['POST'], target: 'coordinator' },
  { name: 'fresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/fresh$/, methods: ['POST'], target: 'coordinator' },
  { name: 'settings', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work-settings$/, methods: ['GET', 'PUT'], target: 'any' },
  { name: 'notebook', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/notebook$/, methods: ['GET', 'PUT'], target: 'any' },
  { name: 'thread-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads$/, methods: ['POST'], target: 'coordinator' },
  { name: 'thread', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)$/, methods: ['GET'], target: 'owner' },
  { name: 'thread-message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/messages$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/stop$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-discard', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/discard$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-allow', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/allow-turns$/, methods: ['POST'], target: 'owner' },
  { name: 'thread-override', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/override$/, methods: ['POST'], target: 'owner' },
  { name: 'pr-merge', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/merge$/, methods: ['POST'], target: 'owner' },
  { name: 'pr-refresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/refresh$/, methods: ['POST'], target: 'owner' },
  { name: 'answer', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/decisions\/([A-Za-z0-9_-]+)\/answer$/, methods: ['POST'], target: 'any', ids: ['projectId', 'decisionId'] },
];
/** Requests carrying a client id repeat safely, so a hub outage during them is reported as retryable (settings only when the body has one). */
const withClientId = new Set<ProjectWorkRouteName>(['message', 'thread-create', 'thread-message', 'thread-override', 'answer']);
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * The Projects route for a path: null for any path this table does not own (other `/api/projects/:id/...` routes such as
 * visibility, context and memory stay with `api.ts`), 405 for a known path with another method.
 */
export function projectWorkRoute(path: string, method: string): ProjectWorkRoute | null {
  for (const row of rows) {
    const match = path.match(row.pattern); if (!match) continue;
    if (!(row.methods as readonly string[]).includes(method)) throw failure('This operation does not support that method.', 405);
    const ids = (row.ids ?? ['projectId', 'threadId']).flatMap((name, index) => match[index + 1] === undefined ? [] : [[name, IdSchema.parse(match[index + 1])] as const]);
    return { name: row.name, target: row.target, ...(row.stream ? { stream: true } : {}), ...Object.fromEntries(ids) };
  }
  return null;
}

/** The coordinator chat frame (brief 5.13, 11): `event: project`, blob payloads resolved, redacted again, native identities left out. */
function projectFrame(ledger: ProjectLedger): LedgerStreamFrame<ProjectLedgerEvent> {
  return { name: 'project', invalidCursor: EVENT_CURSOR_INVALID, aheadCursor: EVENT_CURSOR_AHEAD,
    payload: (event) => ProjectEventFrameSchema.parse(ledger.redact({ schema: 'project-event-v1', event: { ...event, data: publicProjectData(ledger.data(event)) } })) };
}

/**
 * Projects routes, called after browser authentication and origin checks (brief 11). Thread routes run on the thread's
 * owner device and coordinator routes on the coordinator device; before phase 5 another device's thread or coordinator is
 * refused (D170, D192). Thread actions answer 202 with the thread view after the action, coordinator Stop and Fresh with
 * the project view (D207), an override 200 with `thread-override-view-v1` (design 2.10). `token` is the browser session, checked again on every flush of the chat stream.
 */
export async function handleProjectWorkApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string, retryable: () => void): Promise<boolean> {
  const route = projectWorkRoute(url.pathname, request.method ?? 'GET'); if (!route) return false;
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  const work = app.projectWork; await work.ready;
  const projectId = route.projectId ?? ''; const threadId = route.threadId ?? ''; const decisionId = route.decisionId ?? '';
  const write = request.method !== 'GET';
  if (withClientId.has(route.name)) retryable();
  if (route.target === 'owner') {
    const owner = await work.threadOwner(projectId, threadId);
    if (owner === null) throw failure(THREAD_NOT_FOUND, 404);
    if (owner !== app.device.deviceId) throw failure(REMOTE_THREADS_LATER, 409);
  }
  switch (route.name) {
    case 'list': send(await work.list()); return true;
    case 'view': send(await work.view(projectId)); return true;
    case 'events': {
      const ledger = await work.coordinatorEvents(projectId);
      streamLedger(ledger, request, response, url, () => app.streamAuthenticated(token), projectFrame(ledger)); return true;
    }
    case 'message': {
      const { repeated } = await work.postMessage(projectId, CoordinatorMessageRequestSchema.parse(await requestBody(request)));
      send(CoordinatorMessageReceiptSchema.parse({ schema: 'coordinator-message-receipt-v1', repeated }), 202); return true;
    }
    case 'stop': EmptySchema.parse(await requestBody(request)); await work.stopCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'fresh': EmptySchema.parse(await requestBody(request)); await work.freshCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'settings': {
      if (!write) { send(await work.settingsView(projectId)); return true; }
      // The body is parsed before the revision is compared on the hub.
      const input = ProjectWorkSettingsRequestSchema.parse(await requestBody(request));
      if (input.clientRequestId !== undefined) retryable();
      send(await work.putSettings(projectId, input)); return true;
    }
    case 'notebook':
      send(write ? await work.putNotebook(projectId, NotebookRequestSchema.parse(await requestBody(request))) : await work.notebookView(projectId)); return true;
    case 'answer': {
      const { repeated } = await work.answerDecision(projectId, decisionId, DecisionAnswerRequestSchema.parse(await requestBody(request)));
      send(DecisionAnsweredViewSchema.parse({ schema: 'decision-answered-view-v1', repeated }), 202); return true;
    }
    case 'thread-create': send(await work.createThread(projectId, ThreadCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'thread': send(await work.threadView(projectId, threadId)); return true;
    case 'thread-message': {
      const { repeated } = await work.threadMessage(projectId, threadId, ThreadMessageRequestSchema.parse(await requestBody(request)));
      send(ThreadMessageReceiptSchema.parse({ schema: 'thread-message-receipt-v1', repeated }), 202); return true;
    }
    case 'pr-merge': EmptySchema.parse(await requestBody(request)); send(MergeResultViewSchema.parse(await work.mergePullRequest(projectId, threadId))); return true;
    // A restart answers with the new thread's id, which the page opens.
    case 'thread-override': send(await work.overrideThread(projectId, threadId, ThreadOverrideRequestSchema.parse(await requestBody(request)))); return true;
    case 'thread-stop': await work.stopThread(projectId, threadId, ThreadStopRequestSchema.parse(await requestBody(request))); break;
    case 'thread-discard': EmptySchema.parse(await requestBody(request)); await work.discardThread(projectId, threadId); break;
    case 'thread-allow': EmptySchema.parse(await requestBody(request)); await work.allowTurns(projectId, threadId); break;
    case 'pr-refresh': EmptySchema.parse(await requestBody(request)); await work.refreshPullRequest(projectId, threadId); break;
  }
  send(await work.threadView(projectId, threadId), 202); return true;
}
