import { ConversationEvidenceRequestSchema, ConversationEvidenceViewSchema } from '@jevellan/core';
import { PlanApprovalSchema, ConversationPlanChangesRequestSchema } from '@jevellan/core';
import { ConversationPlanReadSchema, ConversationPlanReadRequestSchema } from '@jevellan/core';
import { ConversationDecisionWhyRequestSchema, ConversationDecisionWhyViewSchema, ConversationPublicSchema, CorrectStepSchema, StepCorrectionEditorSchema, StepCorrectionPreviewSchema } from '@jevellan/core';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ComposerChoiceSchema, ConversationComposerViewSchema, DeviceOriginSchema, ErrorDocumentSchema, PeerSessionInputSchema, UiSessionTokenSchema, parseReply } from '@jevellan/core';
import { UiAuth } from '@jevellan/mesh';
import { COORDINATOR_DEVICE_REDIRECT, THREAD_DEVICE_REDIRECT, coordinatorUnreachable, threadDeviceUnreachable } from '@jevellan/projects';
import type { Application } from './application.js';
import { conversationRoute, handleConversation, type ConversationRoute } from './conversation-api.js';
import { requestBody } from './http.js';

const peerPrefix = '/api/mesh/owner/';
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const ReplayHead = z.string().max(16).regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
export const OWNER_REQUEST_TIMEOUT_MS = 20_000;
export const OWNER_STREAM_CONNECT_TIMEOUT_MS = 125_000;
/** What a proxied request is for: the texts a failure shows (the Projects pages never say conversation, D266). */
export type ProxyPurpose = 'conversation' | 'login' | 'thread' | 'coordinator' | 'device';
const proxyCopy: Record<ProxyPurpose, { redirect: string; unreachable(name: string): string }> = {
  conversation: { redirect: 'The conversation owner returned an unexpected redirect.', unreachable: (name) => `Can't reach the conversation owner (${name}). Its work remains on that device.` },
  login: { redirect: 'The login device returned an unexpected redirect.', unreachable: (name) => `Can't reach the login device (${name}). The login remains on that device.` },
  thread: { redirect: THREAD_DEVICE_REDIRECT, unreachable: threadDeviceUnreachable },
  coordinator: { redirect: COORDINATOR_DEVICE_REDIRECT, unreachable: coordinatorUnreachable },
  device: { redirect: 'The device returned an unexpected redirect.', unreachable: name => `Can't reach ${name}. Worktrees remain on that device.` },
};

export async function handleOwnerRequest(app: Application, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith(peerPrefix)) return false;
  if (request.headers.origin || request.headers['sec-fetch-site']) throw failure('Use the device connection for this request.', 403);
  const local = new URL(url); local.pathname = `/api/conversations/${url.pathname.slice(peerPrefix.length)}`;
  const route = conversationRoute(local.pathname, request.method ?? 'GET');
  if (!route) throw failure('Conversation operation not found.', 404);
  const authorization = request.headers.authorization;
  const input = PeerSessionInputSchema.safeParse({ schema: 'peer-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], conversationId: route.id, token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
  if (!input.success || !await app.peerAuthenticated(input.data)) throw failure('Sign in to Jevellan.', 401);
  app.redactor.add(input.data.token); await app.conversations.ready;
  if (!app.conversations.hasLocalConversation(route.id)) throw failure('This conversation is not available on its owner device.', 404);
  await handleConversation(app, request, response, local, route, () => app.peerAuthenticated(input.data, true));
  return true;
}

/** Routes only indexed foreign conversations. Creation and local history stay local. */
export async function proxyConversation(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, route: ConversationRoute, token: string): Promise<boolean> {
  const owner = await app.conversations.ownerDevice(route.id);
  if (owner === app.device.deviceId) return false;
  const target = (await app.roster()).devices.find(entry => entry.device.id === owner);
  if (!target || target.revoked) throw failure('The conversation owner is no longer available in this mesh.', 409);
  const upstream = new URL(DeviceOriginSchema.parse(target.device.url));
  upstream.pathname = `${peerPrefix}${url.pathname.slice('/api/conversations/'.length)}`; upstream.search = url.search;
  const body = request.method === 'POST' ? JSON.stringify(await requestBody(request)) : undefined;
  await forwardOwner(request, response, { url: upstream, ownerName: target.device.name, sourceDeviceId: app.device.deviceId, token, stream: route.operation === 'events', ...(body === undefined ? {} : { body }) });
  return true;
}

export type OwnerConversationOperation = 'evidence-read' | 'plan-approve' | 'plan-changes' | 'plan-read' | 'composer-editor' | 'composer-save' | 'decision-why' | 'step-editor' | 'step-preview' | 'correction-save';

/** Closed owner operations bind the indexed resource before issuing temporary peer authority. */
export async function ownerConversationOperation(app: Application, projectId: string, id: string, operation: OwnerConversationOperation, raw?: unknown) {
  const location = await app.conversations.location(id);
  if (location.projectId !== projectId) throw failure('This composer or decision belongs to another conversation or project.', 409);
  const spec = (() => {
    switch (operation) {
      case 'evidence-read': { const body = ConversationEvidenceRequestSchema.parse(raw); return { suffix: 'evidence-read', method: 'POST' as const, body, local: () => app.conversations.evidenceRead(id, body) }; }
      case 'plan-approve': { const body = PlanApprovalSchema.parse(raw); return { suffix: 'approve-plan', method: 'POST' as const, body, local: () => app.conversations.approvePlan(id, body) }; }
      case 'plan-changes': { const body = ConversationPlanChangesRequestSchema.parse(raw); return { suffix: 'messages', method: 'POST' as const, body, local: () => app.conversations.message(id, body) }; }
      case 'plan-read': { const body = ConversationPlanReadRequestSchema.parse(raw); return { suffix: 'plan-read', method: 'POST' as const, body, local: () => app.conversations.planRead(id, body) }; }
      case 'composer-editor': return { suffix: 'choices-view', method: 'GET' as const, body: undefined, local: () => app.conversations.composerEditor(id) };
      case 'composer-save': { const body = ComposerChoiceSchema.parse(raw); return { suffix: 'choices-editor', method: 'POST' as const, body, local: () => app.conversations.saveComposerEditor(id, body) }; }
      case 'decision-why': { const body = ConversationDecisionWhyRequestSchema.parse(raw); return { suffix: 'decision-why', method: 'POST' as const, body, local: () => app.conversations.decisionWhy(id, body) }; }
      case 'step-editor': { const n = z.number().int().positive().parse(raw); return { suffix: `step-editor/${n}`, method: 'GET' as const, body: undefined, local: () => app.conversations.stepEditor(id, n) }; }
      case 'step-preview': { const body = StepCorrectionPreviewSchema.parse(raw); return { suffix: 'step-preview', method: 'POST' as const, body, local: () => app.conversations.previewStepCorrection(id, body) }; }
      case 'correction-save': { const body = CorrectStepSchema.parse(raw); return { suffix: 'correct', method: 'POST' as const, body, local: () => app.conversations.correct(id, body) }; }
      default: throw failure('Conversation operation not found.', 404);
    }
  })();
  const path = `/api/conversations/${id}/${spec.suffix}`;
  if (!conversationRoute(path, spec.method)) throw failure('Conversation operation not found.', 404);
  const bind = (received: unknown) => {
    const value = operation === 'evidence-read' ? parseReply(ConversationEvidenceViewSchema, received) : operation === 'plan-read' ? parseReply(ConversationPlanReadSchema, received) : ['correction-save', 'plan-approve', 'plan-changes'].includes(operation) ? parseReply(ConversationPublicSchema, received)
      : operation === 'decision-why' ? parseReply(ConversationDecisionWhyViewSchema, received)
        : operation === 'step-editor' || operation === 'step-preview' ? parseReply(StepCorrectionEditorSchema, received) : parseReply(ConversationComposerViewSchema, received);
    const actual = 'conversation' in value ? { project: value.conversation.projectId, id: value.conversation.id } : { project: value.projectId, id: value.conversationId };
    if (actual.project !== projectId || actual.id !== id) throw failure('The returned model belongs to another conversation or project.', 502);
    if (operation === 'evidence-read') {
      const evidence = ConversationEvidenceViewSchema.parse(value), expected = ConversationEvidenceRequestSchema.parse(spec.body);
      if (JSON.stringify(evidence.request) !== JSON.stringify(expected) || evidence.reference.value !== expected.ref) throw failure('The returned evidence does not match the request.', 502);
    }
    if (operation === 'plan-read') {
      const plan = ConversationPlanReadSchema.parse(value), request = ConversationPlanReadRequestSchema.parse(spec.body);
      if (plan.pointer !== request.pointer || request.step !== undefined && plan.review?.step !== request.step) throw failure('The returned plan does not match the request.', 502);
    }
    if (operation === 'decision-why' && 'decisionId' in value && value.decisionId !== ConversationDecisionWhyRequestSchema.parse(spec.body).decisionId) throw failure('The returned decision does not match the request.', 502);
    if ('stretch' in value) {
      const wanted = operation === 'step-editor' ? z.number().int().positive().parse(raw) : StepCorrectionPreviewSchema.parse(spec.body).stretch;
      if (value.stretch !== wanted || value.preview.path !== `/api/conversations/${id}/step-preview`) throw failure('The returned step editor does not match the request.', 502);
    }
    return value;
  };
  if (location.ownerDeviceId === app.device.deviceId) return bind(await spec.local());
  const target = (await app.roster()).devices.find(row => row.device.id === location.ownerDeviceId);
  if (!target || target.revoked) throw failure('The conversation owner is no longer available in this mesh.', 409);
  const auth = app.auth;
  if (!(auth instanceof UiAuth)) throw failure('Owner tools must run on the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try {
    const url = new URL(DeviceOriginSchema.parse(target.device.url)); url.pathname = `${peerPrefix}${id}/${spec.suffix}`;
    let response: Response;
    try {
      response = await fetch(url, { method: spec.method, redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId, Accept: 'application/json', ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }) });
    } catch { throw failure(proxyCopy.conversation.unreachable(target.device.name), 502); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw failure(proxyCopy.conversation.redirect, 502); }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorDocumentSchema.safeParse(value);
      throw failure(error.success ? error.data.message : proxyCopy.conversation.unreachable(target.device.name), error.success ? response.status : 502);
    }
    return bind(value);
  } finally { auth.logout(token); }
}

export async function ownerConversationComposer(app: Application, projectId: string, id: string, raw?: unknown) {
  return parseReply(ConversationComposerViewSchema, await ownerConversationOperation(app, projectId, id, raw === undefined ? 'composer-editor' : 'composer-save', raw));
}

/** Preserve bytes and backpressure without collecting a growing conversation in memory. */
export async function forwardOwner(request: IncomingMessage, response: ServerResponse, options: {
  url: URL; ownerName: string; sourceDeviceId: string; token: string; stream: boolean; body?: string;
  fetch?: typeof fetch; timeoutMs?: number;
  purpose?: ProxyPurpose;
}): Promise<void> {
  const copy = proxyCopy[options.purpose ?? 'conversation'];
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort); response.once('close', abort);
  if (request.aborted || response.destroyed) abort();
  const timer = setTimeout(abort, options.timeoutMs ?? (options.stream ? OWNER_STREAM_CONNECT_TIMEOUT_MS : OWNER_REQUEST_TIMEOUT_MS)); timer.unref();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let finished = false;
  try {
    const cursor = request.headers['last-event-id'];
    const upstream = await (options.fetch ?? fetch)(options.url, { method: request.method ?? 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${UiSessionTokenSchema.parse(options.token)}`, 'X-Jevellan-Source-Device': options.sourceDeviceId, Accept: options.stream ? 'text/event-stream' : 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(typeof cursor === 'string' ? { 'Last-Event-ID': cursor } : {}) },
      ...(options.body === undefined ? {} : { body: options.body }) });
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); throw failure(copy.redirect, 502); }
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const streaming = options.stream && upstream.ok && contentType.split(';')[0]?.trim() === 'text/event-stream';
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': streaming ? 'no-cache, no-transform' : 'no-store', 'X-Content-Type-Options': 'nosniff', ...(streaming ? { 'X-Accel-Buffering': 'no' } : {}) };
    const head = upstream.headers.get('x-jevellan-ledger-head');
    if (streaming && head !== null) {
      const parsed = ReplayHead.safeParse(head);
      if (!parsed.success) throw failure('The device returned an invalid ledger replay cursor.', 502);
      headers['X-Jevellan-Ledger-Head'] = String(parsed.data);
    }
    reader = upstream.body?.getReader();
    if (streaming) { clearTimeout(timer); response.writeHead(upstream.status, headers); response.flushHeaders(); }
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (!response.headersSent) response.writeHead(upstream.status, headers);
        if (chunk.done) break;
        if (!response.write(chunk.value)) await once(response, 'drain', { signal: controller.signal });
      }
    } else if (!response.headersSent) response.writeHead(upstream.status, headers);
    finished = true; response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    if (error && typeof error === 'object' && 'status' in error) throw error;
    throw failure(copy.unreachable(options.ownerName), 502);
  } finally {
    clearTimeout(timer); request.off('aborted', abort); response.off('close', abort);
    if (!finished) { controller.abort(); await reader?.cancel().catch(() => {}); }
    reader?.releaseLock();
  }
}
