import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceOriginSchema, PeerSessionInputSchema, UiSessionTokenSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { conversationRoute, handleConversation, type ConversationRoute } from './conversation-api.js';
import { requestBody } from './http.js';

const peerPrefix = '/api/mesh/owner/';
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
export const OWNER_REQUEST_TIMEOUT_MS = 20_000;
export const OWNER_STREAM_CONNECT_TIMEOUT_MS = 125_000;

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

/** Preserve bytes and backpressure without collecting a growing conversation in memory. */
export async function forwardOwner(request: IncomingMessage, response: ServerResponse, options: {
  url: URL; ownerName: string; sourceDeviceId: string; token: string; stream: boolean; body?: string;
  fetch?: typeof fetch; timeoutMs?: number;
  purpose?: 'login';
}): Promise<void> {
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
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); throw failure(options.purpose === 'login' ? 'The login device returned an unexpected redirect.' : 'The conversation owner returned an unexpected redirect.', 502); }
    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const streaming = options.stream && upstream.ok && contentType.split(';')[0]?.trim() === 'text/event-stream';
    const headers = { 'Content-Type': contentType, 'Cache-Control': streaming ? 'no-cache, no-transform' : 'no-store', 'X-Content-Type-Options': 'nosniff', ...(streaming ? { 'X-Accel-Buffering': 'no' } : {}) };
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
    throw failure(options.purpose === 'login' ? `Can't reach the login device (${options.ownerName}). The login remains on that device.` : `Can't reach the conversation owner (${options.ownerName}). Its work remains on that device.`, 502);
  } finally {
    clearTimeout(timer); request.off('aborted', abort); response.off('close', abort);
    if (!finished) { controller.abort(); await reader?.cancel().catch(() => {}); }
    reader?.releaseLock();
  }
}
