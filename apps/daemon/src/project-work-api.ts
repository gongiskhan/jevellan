import { JobCreateRequestSchema, JobUpdateRequestSchema, DailyCreateRequestSchema, DailyUpdateRequestSchema, ProjectRunRequestSchema } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CoordinatorMessageReceiptSchema, CoordinatorMessageRequestSchema, DecisionAnswerRequestSchema, DecisionAnsweredViewSchema, DeviceOriginSchema, EmptySchema, ErrorDocumentSchema, IdSchema,
  MergeResultViewSchema, MergeCorrectionInputSchema, NotebookRequestSchema, PeerLoginSessionInputSchema, ProjectEventFrameSchema, ProjectWorkSettingsRequestSchema, ThreadCreateRequestSchema, ThreadCreatedViewSchema,
  ThreadMessageReceiptSchema, ThreadMessageRequestSchema, ThreadOverrideRequestSchema, ThreadStopRequestSchema, UiSessionTokenSchema, boundedRedaction, type ProjectLedgerEvent,
  GoalCreateRequestSchema, GoalUpdateRequestSchema, TaskCreateRequestSchema, TaskUpdateRequestSchema, TaskActionRequestSchema,
} from '@jevellan/core';
import {
  COORDINATOR_DEVICE_REDIRECT, COORDINATOR_NOT_HERE, EVENT_CURSOR_AHEAD, EVENT_CURSOR_INVALID, PROJECT_OPERATION_NOT_FOUND, THREAD_DEVICE_GONE, THREAD_NOT_FOUND, coordinatorOfflineNotice,
  coordinatorUnreachable, publicProjectData, threadDeviceOffline, type ProjectLedger, type RemoteStart,
} from '@jevellan/projects';
import type { Application } from './application.js';
import { streamLedger, type LedgerStreamFrame } from './conversation-events.js';
import { json, requestBody } from './http.js';
import { OWNER_REQUEST_TIMEOUT_MS, forwardOwner } from './owner-proxy.js';

export type ProjectWorkRouteName = 'list' | 'view' | 'events' | 'message' | 'stop' | 'fresh' | 'move' | 'settings' | 'notebook' | 'thread-create' | 'thread' | 'thread-message'
  | 'thread-stop' | 'thread-discard' | 'thread-allow' | 'thread-override' | 'pr-merge' | 'pr-refresh' | 'pr-route' | 'pr-correction' | 'answer' | 'goal-list' | 'goal-create' | 'goal-update' | 'job-list' | 'job-create' | 'job-update' | 'job-run' | 'job-runs' | 'daily-list' | 'daily-create' | 'daily-update' | 'daily-run' | 'task-list' | 'task-create' | 'task' | 'task-update' | 'task-action';
/** Where a route runs: this device (`local`), the project's coordinator device, the thread's owner device, or any device. */
export type ProjectWorkRoute = { name: ProjectWorkRouteName; projectId?: string; threadId?: string; decisionId?: string; taskId?: string; goalId?: string; jobId?: string; dailyId?: string;
  target: 'local' | 'coordinator' | 'owner' | 'any'; stream?: boolean };
type IdName = 'projectId' | 'threadId' | 'decisionId' | 'taskId' | 'goalId' | 'jobId' | 'dailyId';
/** `ids` names the captured ids in order (default project then thread); `stream` marks the event stream. */
type Row = { name: ProjectWorkRouteName; pattern: RegExp; methods: readonly ('GET' | 'POST' | 'PUT')[]; target: ProjectWorkRoute['target']; ids?: readonly IdName[]; stream?: true };

// The closed route table (brief 11, design 2.10). Paths are matched whole; ids are validated after a match.
const rows: readonly Row[] = [
  { name: 'job-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs$/, methods: ['GET'], target: 'any' },
  { name: 'job-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs$/, methods: ['POST'], target: 'coordinator' },
  { name: 'job-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'any', ids: ['projectId', 'jobId'] },
  { name: 'job-run', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/jobs\/([A-Za-z0-9_-]+)\/run$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'jobId'] },
  { name: 'daily-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies$/, methods: ['GET'], target: 'any' },
  { name: 'daily-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies$/, methods: ['POST'], target: 'coordinator' },
  { name: 'daily-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'any', ids: ['projectId', 'dailyId'] },
  { name: 'daily-run', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/dailies\/([A-Za-z0-9_-]+)\/run$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'dailyId'] },
  { name: 'job-runs', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/job-runs$/, methods: ['GET'], target: 'any' },
  { name: 'goal-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals$/, methods: ['GET'], target: 'any' },
  { name: 'goal-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals$/, methods: ['POST'], target: 'coordinator' },
  { name: 'goal-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/goals\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'any', ids: ['projectId', 'goalId'] },
  { name: 'task-list', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks$/, methods: ['GET'], target: 'any' },
  { name: 'task-create', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks$/, methods: ['POST'], target: 'coordinator' },
  { name: 'task', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/, methods: ['GET'], target: 'any', ids: ['projectId', 'taskId'] },
  { name: 'task-update', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)\/edit$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'taskId'] },
  { name: 'task-action', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)\/action$/, methods: ['POST'], target: 'coordinator', ids: ['projectId', 'taskId'] },
  { name: 'list', pattern: /^\/api\/project-work$/, methods: ['GET'], target: 'any' },
  { name: 'view', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/work$/, methods: ['GET'], target: 'any' },
  { name: 'events', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/events$/, methods: ['GET'], target: 'coordinator', stream: true },
  { name: 'message', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/messages$/, methods: ['POST'], target: 'coordinator' },
  { name: 'stop', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/stop$/, methods: ['POST'], target: 'coordinator' },
  { name: 'fresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/fresh$/, methods: ['POST'], target: 'coordinator' },
  // Move coordinator here runs on the device the owner uses, never proxied (3.5.3).
  { name: 'move', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/coordinator\/move$/, methods: ['POST'], target: 'local' },
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
  { name: 'pr-route', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/route$/, methods: ['GET'], target: 'any' },
  { name: 'pr-correction', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/correction$/, methods: ['POST'], target: 'any' },
  { name: 'pr-refresh', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/threads\/([A-Za-z0-9_-]+)\/pr\/refresh$/, methods: ['POST'], target: 'owner' },
  { name: 'answer', pattern: /^\/api\/projects\/([A-Za-z0-9_-]+)\/decisions\/([A-Za-z0-9_-]+)\/answer$/, methods: ['POST'], target: 'any', ids: ['projectId', 'decisionId'] },
];
/**
 * Requests carrying a client id repeat safely, so a hub outage during them is reported as retryable (settings only when the body has
 * one); so does Move coordinator here, whose repeat completes the first one (D269).
 */
const withClientId = new Set<ProjectWorkRouteName>(['message', 'move', 'thread-create', 'thread-message', 'thread-override', 'answer', 'pr-correction', 'task-create', 'goal-create', 'job-create', 'daily-create', 'job-run', 'daily-run']);
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const API_PREFIX = '/api/projects/';
/** UI-proxied requests from another device (phase 5, D41, D266): the owner and coordinator routes of the table. */
const PEER_PREFIX = '/api/mesh/projects/';
/** Who asks: a browser here, or another device forwarding a signed-in owner's request (its session token and device). */
type Caller = { token: string; sourceDeviceId: string; peer: boolean; authenticated(): Promise<boolean> };

/**
 * The Projects route for a path: null for any path this table does not own (other `/api/projects/:id/...` routes such as
 * visibility, context and memory stay with `api.ts`), 405 for a known path with another method.
 */
export function projectWorkRoute(path: string, method: string): ProjectWorkRoute | null {
  for (const row of rows) {
    const match = path.match(row.pattern); if (!match) continue;
    if (!(row.methods as readonly string[]).includes(method)) { if (rows.some(other => other.pattern.source === row.pattern.source && (other.methods as readonly string[]).includes(method))) continue; throw failure('This operation does not support that method.', 405); }
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
 * The peer path of a local route. Thread creation travels as `coordinator/threads` (it runs placement on the coordinator device),
 * so the brief's `POST /api/mesh/projects/:id/threads`, a background start, stays absent (D40, D266).
 */
function peerPath(route: ProjectWorkRoute, path: string): string {
  return route.name === 'thread-create' ? `${PEER_PREFIX}${route.projectId!}/coordinator/threads` : `${PEER_PREFIX}${path.slice(API_PREFIX.length)}`;
}
/** The local path of a peer path; null for the brief's absent background start. */
function localPath(path: string): string | null {
  const suffix = path.slice(PEER_PREFIX.length);
  const create = suffix.match(/^([A-Za-z0-9_-]+)\/coordinator\/threads$/); if (create) return `${API_PREFIX}${create[1]!}/threads`;
  return /^[A-Za-z0-9_-]+\/threads$/.test(suffix) ? null : `${API_PREFIX}${suffix}`;
}
/** The roster row of a device a request goes to; a thread's owner or coordinator that left the mesh or is offline is refused here (D9a, D266). */
async function target(app: Application, deviceId: string, purpose: 'thread' | 'coordinator') {
  const row = (await app.roster()).devices.find((view) => view.device.id === deviceId);
  if (purpose === 'coordinator' && (!row || row.revoked || row.status === 'offline')) throw failure(coordinatorOfflineNotice(row?.device.name ?? deviceId), 409);
  if (!row || row.revoked) throw failure(THREAD_DEVICE_GONE, 409);
  if (row.status === 'offline') throw failure(threadDeviceOffline(row.device.name), 409);
  return row;
}
/** Sends the request to the device that runs it (2.10): the thread's owner or the coordinator device, with the owner's session. */
async function proxy(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ProjectWorkRoute, deviceId: string, caller: Caller): Promise<void> {
  const purpose = route.target === 'owner' ? 'thread' : 'coordinator'; const row = await target(app, deviceId, purpose);
  const upstream = new URL(DeviceOriginSchema.parse(row.device.url)); upstream.pathname = peerPath(route, url.pathname); upstream.search = url.search;
  const body = request.method === 'POST' ? JSON.stringify(await requestBody(request)) : undefined;
  await forwardOwner(request, response, { url: upstream, ownerName: row.device.name, sourceDeviceId: caller.sourceDeviceId, token: caller.token, stream: route.stream === true, purpose,
    ...(body === undefined ? {} : { body }) });
}
/**
 * A restart's new thread on the coordinator device when that is another device (D266): the same proxied creation as New thread,
 * made by the thread's device with the owner's session and the device that session belongs to.
 */
function remoteStart(app: Application, caller: Caller): RemoteStart {
  return async (projectId, deviceId, input) => {
    const row = await target(app, deviceId, 'coordinator');
    const upstream = new URL(DeviceOriginSchema.parse(row.device.url)); upstream.pathname = `${PEER_PREFIX}${projectId}/coordinator/threads`;
    let answer: Response;
    try {
      answer = await fetch(upstream, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), body: JSON.stringify(ThreadCreateRequestSchema.parse(input)),
        headers: { Authorization: `Bearer ${UiSessionTokenSchema.parse(caller.token)}`, 'X-Jevellan-Source-Device': caller.sourceDeviceId, Accept: 'application/json', 'Content-Type': 'application/json' } });
    } catch { throw failure(coordinatorUnreachable(row.device.name), 502); }
    if (answer.status >= 300 && answer.status < 400) { await answer.body?.cancel(); throw failure(COORDINATOR_DEVICE_REDIRECT, 502); }
    const value: unknown = await answer.json().catch(() => null);
    if (answer.ok) return ThreadCreatedViewSchema.parse(value);
    const refused = ErrorDocumentSchema.safeParse(value);
    throw refused.success ? failure(refused.data.message, answer.status) : failure(coordinatorUnreachable(row.device.name), 502);
  };
}

/**
 * Projects routes, called after browser authentication and origin checks (brief 11). Thread routes run on the thread's
 * owner device and coordinator routes on the coordinator device: another device's are proxied there with the browser session
 * (phase 5, design 2.10, D266). Thread actions answer 202 with the thread view after the action, coordinator Stop and Fresh
 * with the project view (D207), an override 200 with `thread-override-view-v1` (design 2.10). `token` is the browser
 * session, checked again on every flush of the chat stream.
 */
export async function handleProjectWorkApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token: string, retryable: () => void): Promise<boolean> {
  const route = projectWorkRoute(url.pathname, request.method ?? 'GET'); if (!route) return false;
  return run(app, request, response, url, route, { token, sourceDeviceId: app.device.deviceId, peer: false, authenticated: () => app.streamAuthenticated(token) }, retryable);
}

/**
 * The peer receiver (phase 5, design 2.10, D41): another device forwards a signed-in owner's request for a thread this device
 * owns or a coordinator it runs. Browsers are refused, the session is checked with the generic peer check, the path must be one
 * of the owner or coordinator routes (the brief's background start and coordinator event delivery do not exist, D40), and the
 * resource must be here; then the same handler runs, never proxying again.
 */
export async function handleProjectWorkPeer(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, retryable: () => void): Promise<boolean> {
  if (!url.pathname.startsWith(PEER_PREFIX)) return false;
  if (request.headers.origin || request.headers['sec-fetch-site']) throw failure('Use the device connection for this request.', 403);
  const local = localPath(url.pathname); let route: ProjectWorkRoute | null = null;
  // A method the local route does not take is as absent here as an unknown path.
  if (local !== null) { try { route = projectWorkRoute(local, request.method ?? 'GET'); } catch { route = null; } }
  if (!route || (route.target !== 'owner' && route.target !== 'coordinator')) throw failure(PROJECT_OPERATION_NOT_FOUND, 404);
  const authorization = request.headers.authorization;
  const input = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'],
    token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
  if (!input.success || !await app.peerLoginAuthenticated(input.data)) throw failure('Sign in to Jevellan.', 401);
  app.redactor.add(input.data.token);
  const here = new URL(url); here.pathname = local!;
  return run(app, request, response, here, route, { token: input.data.token, sourceDeviceId: input.data.sourceDeviceId, peer: true,
    authenticated: () => app.peerLoginAuthenticated(input.data, true) }, retryable);
}

async function run(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ProjectWorkRoute, caller: Caller, retryable: () => void): Promise<boolean> {
  // Redaction never lengthens a text past the maximum its schema checked, so proxies and devices read every view (P8 review S-1).
  const send = (value: unknown, status = 200) => json(response, boundedRedaction(app.redactor, value), status);
  const work = app.projectWork; await work.ready;
  const projectId = route.projectId ?? ''; const threadId = route.threadId ?? ''; const decisionId = route.decisionId ?? '';
  const write = request.method !== 'GET';
  if (withClientId.has(route.name)) retryable();
  if (route.name === 'answer') {
    const owner = await work.decisionOwner(projectId, decisionId);
    if (owner && owner !== app.device.deviceId) {
      if (caller.peer) throw failure(THREAD_NOT_FOUND, 404);
      await proxy(app, request, response, url, { ...route, target: 'owner' }, owner, caller); return true;
    }
  }
  if (route.target === 'owner') {
    const owner = await work.threadOwner(projectId, threadId);
    if (owner === null) throw failure(THREAD_NOT_FOUND, 404);
    if (owner !== app.device.deviceId) {
      if (caller.peer) throw failure(THREAD_NOT_FOUND, 404);
      await proxy(app, request, response, url, route, owner, caller); return true;
    }
  }
  if (route.target === 'coordinator') {
    // Before any assignment the request runs here (messages and new threads assign this device, D6); a peer needs the coordinator here.
    const coordinator = await work.coordinatorDevice(projectId);
    if (caller.peer && coordinator !== app.device.deviceId) throw failure(COORDINATOR_NOT_HERE, 404);
    if (coordinator !== null && coordinator !== app.device.deviceId) { await proxy(app, request, response, url, route, coordinator, caller); return true; }
  }
  if (route.target === 'coordinator' && /^(job|daily)-(create|run)$/u.test(route.name)) await work.prepareDailyWork(projectId);
  switch (route.name) {
    case 'job-list': send({ schema: 'project-job-list-view-v1', projectId, jobs: await work.daily.jobs(projectId) }); return true;
    case 'job-create': send(await work.daily.createJob(projectId, JobCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'job-update': send(await work.daily.updateJob(projectId, route.jobId!, JobUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'job-run': send(await work.daily.runJob(projectId, route.jobId!, ProjectRunRequestSchema.parse(await requestBody(request))), 202); return true;
    case 'job-runs': send({ schema: 'project-job-run-list-view-v1', projectId, runs: await work.jobs.runs(projectId) }); return true;
    case 'daily-list': send(await work.daily.view(projectId)); return true;
    case 'daily-create': send(await work.daily.createDaily(projectId, DailyCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'daily-update': send(await work.daily.updateDaily(projectId, route.dailyId!, DailyUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'daily-run': send(await work.daily.runDaily(projectId, route.dailyId!, ProjectRunRequestSchema.parse(await requestBody(request))), 202); return true;

    case 'goal-list': send(await work.goalList(projectId)); return true;
    case 'goal-create': send(await work.createGoal(projectId, GoalCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'goal-update': send(await work.updateGoal(projectId, route.goalId!, GoalUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'task-list': send(await work.taskList(projectId)); return true;
    case 'task-create': send(await work.createTask(projectId, TaskCreateRequestSchema.parse(await requestBody(request))), 201); return true;
    case 'task': send(await work.taskView(projectId, route.taskId!)); return true;
    case 'task-update': send(await work.updateTask(projectId, route.taskId!, TaskUpdateRequestSchema.parse(await requestBody(request)))); return true;
    case 'task-action': send(await work.taskAction(projectId, route.taskId!, TaskActionRequestSchema.parse(await requestBody(request)))); return true;
    case 'list': send(await work.list()); return true;
    case 'view': send(await work.view(projectId)); return true;
    case 'events': {
      const ledger = await work.coordinatorEvents(projectId);
      streamLedger(ledger, request, response, url, caller.authenticated, projectFrame(ledger)); return true;
    }
    case 'message': {
      const { repeated } = await work.postMessage(projectId, CoordinatorMessageRequestSchema.parse(await requestBody(request)));
      send(CoordinatorMessageReceiptSchema.parse({ schema: 'coordinator-message-receipt-v1', repeated }), 202); return true;
    }
    case 'stop': EmptySchema.parse(await requestBody(request)); await work.stopCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'fresh': EmptySchema.parse(await requestBody(request)); await work.freshCoordinator(projectId); send(await work.view(projectId), 202); return true;
    case 'move': EmptySchema.parse(await requestBody(request)); await work.moveCoordinatorHere(projectId); send(await work.view(projectId)); return true;
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
    case 'pr-route': send(await work.mergeRoute(projectId, threadId)); return true;
    case 'pr-correction': send(await work.mergeCorrection(projectId, threadId, MergeCorrectionInputSchema.parse(await requestBody(request)))); return true;
    // A restart answers with the new thread's id, which the page opens.
    case 'thread-override': send(await work.overrideThread(projectId, threadId, ThreadOverrideRequestSchema.parse(await requestBody(request)), remoteStart(app, caller))); return true;
    case 'thread-stop': await work.stopThread(projectId, threadId, ThreadStopRequestSchema.parse(await requestBody(request))); break;
    case 'thread-discard': EmptySchema.parse(await requestBody(request)); await work.discardThread(projectId, threadId); break;
    case 'thread-allow': EmptySchema.parse(await requestBody(request)); await work.allowTurns(projectId, threadId); break;
    case 'pr-refresh': EmptySchema.parse(await requestBody(request)); await work.refreshPullRequest(projectId, threadId); break;
  }
  send(await work.threadView(projectId, threadId), 202); return true;
}
