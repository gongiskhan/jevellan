import { afterEach, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { conversationRoute } from '../apps/daemon/dist/conversation-api.js';
import { forwardOwner } from '../apps/daemon/dist/owner-proxy.js';
import { json, requestBody } from '../apps/daemon/dist/http.js';

const servers: Server[] = []; const controllers: AbortController[] = [];
const fixtureToken = 'Zml4dHVyZQ.c2lnbmF0dXJl';
async function serve(listener: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(listener); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function relay(upstream: string, options: Partial<Parameters<typeof forwardOwner>[2]> = {}) {
  return serve((request, response) => { void (async () => {
    try {
      const body = request.method === 'POST' ? JSON.stringify(await requestBody(request)) : undefined;
      await forwardOwner(request, response, { url: new URL(request.url ?? '/', upstream), ownerName: 'Fixture owner', sourceDeviceId: 'source', token: fixtureToken, stream: false, ...options, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
      json(response, { schema: 'error-v1', code: 'request-failed', message: error instanceof Error ? error.message : 'Failed.' }, status);
    }
  })(); });
}
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
});

test('the owner route table preserves conversation reads and controls without allowing remote creation or other APIs', () => {
  for (const operation of ['', '/read', '/events', '/file', '/changes/2']) expect(conversationRoute(`/api/conversations/example${operation}`, 'GET')?.id).toBe('example');
  for (const operation of ['messages', 'manual', 'resume', 'retry-external', 'choices', 'cancel', 'approve-plan', 'settle', 'correct', 'retry-redo', 'adopt-changes', 'rename', 'finish-outside']) expect(conversationRoute(`/api/conversations/example/${operation}`, 'POST')?.operation).toBe(operation);
  for (const path of ['/api/conversations', '/hub/config', '/api/bridge', '/api/conversations/example/arbitrary', '/api/conversations/example/read/2', '/api/conversations/example/changes', '/api/conversations/../events', '/api/conversations/a%2fb/events']) expect(conversationRoute(path, 'POST')).toBeNull();
  expect(() => conversationRoute('/api/conversations/example', 'DELETE')).toThrow('method');
  expect(() => conversationRoute('/api/conversations/example/messages', 'GET')).toThrow('method');
});

test('forwarding preserves method, query, JSON and a conflict response without forwarding browser cookies or setting them', async () => {
  let seen: { method: string | undefined; url: string | undefined; headers: IncomingMessage['headers']; body: unknown } | undefined;
  const conflict = { schema: 'error-v1', code: 'conflict', message: 'The step has already changed.' };
  const upstream = await serve((request, response) => { void (async () => {
    seen = { method: request.method, url: request.url, headers: request.headers, body: await requestBody(request) };
    response.setHeader('Set-Cookie', 'fixture=not-forwarded'); json(response, conflict, 409);
  })(); });
  const base = await relay(upstream); const input = { schema: 'conversation-message-v1', clientMessageId: 'message', text: 'A correction from another device.' };
  const response = await fetch(`${base}/api/mesh/owner/example/messages?cursor=7`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'private-browser-cookie', Origin: base }, body: JSON.stringify(input) });
  expect(response.status).toBe(409); expect(await response.json()).toEqual(conflict); expect(response.headers.get('set-cookie')).toBeNull();
  expect(seen).toMatchObject({ method: 'POST', url: '/api/mesh/owner/example/messages?cursor=7', body: input });
  expect(seen?.headers.authorization).toBe(`Bearer ${fixtureToken}`); expect(seen?.headers['x-jevellan-source-device']).toBe('source');
  expect(seen?.headers.cookie).toBeUndefined(); expect(seen?.headers.origin).toBeUndefined();
});

test('owner responses retain non-UTF8 bytes without buffering the whole response', async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
  const upstream = await serve((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(bytes.subarray(0, 17)); response.end(bytes.subarray(17)); });
  const base = await relay(upstream); const response = await fetch(`${base}/api/mesh/owner/example/file`);
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); expect(response.headers.get('cache-control')).toBe('no-store');
});

test('SSE forwards the reconnect cursor, survives its connect deadline and closes upstream when the viewer leaves', async () => {
  let cursor: string | string[] | undefined; let closed!: () => void; const close = new Promise<void>(resolve => { closed = resolve; });
  const upstream = await serve((request, response) => {
    cursor = request.headers['last-event-id']; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('id: 8\ndata: first\n\n');
    const timer = setTimeout(() => response.write('id: 9\ndata: still live\n\n'), 150);
    response.on('close', () => { clearTimeout(timer); closed(); });
  });
  const base = await relay(upstream, { stream: true, timeoutMs: 100 }); const controller = new AbortController(); controllers.push(controller);
  const response = await fetch(`${base}/api/mesh/owner/example/events`, { headers: { 'Last-Event-ID': '7' }, signal: controller.signal });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-transform'); expect(cursor).toBe('7');
  const reader = response.body!.getReader(); let text = Buffer.from((await reader.read()).value!).toString(); expect(text).toContain('id: 8');
  while (!text.includes('id: 9')) { const chunk = await reader.read(); expect(chunk.done).toBe(false); text += Buffer.from(chunk.value!).toString(); }
  controller.abort(); await close; reader.releaseLock();
});

test('an owner that never sends headers times out with a readable failure', async () => {
  const upstream = await serve(() => {}); const base = await relay(upstream, { stream: true, timeoutMs: 30 });
  const response = await fetch(`${base}/api/mesh/owner/example/events`);
  expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ schema: 'error-v1', message: expect.stringContaining("Can't reach the conversation owner") });
});

test('an unreadable upstream body before its first bytes remains a structured failure', async () => {
  const base = await relay('http://127.0.0.1', { fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('Simulated unreadable response.')); } })) });
  const response = await fetch(`${base}/api/mesh/owner/example/read`); expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ schema: 'error-v1' });
});

test('owner redirects are not followed or relayed to the browser', async () => {
  let calls = 0; const upstream = await serve((_request, response) => { calls++; response.writeHead(302, { Location: '/elsewhere' }); response.end(); });
  const base = await relay(upstream); const response = await fetch(`${base}/api/mesh/owner/example`);
  expect(response.status).toBe(502); expect(response.headers.get('location')).toBeNull(); expect(calls).toBe(1);
});

test('each purpose has its own failure texts: Projects threads and coordinators never say conversation, the others are unchanged (D266)', async () => {
  const unreachable = await serve(() => {}); const redirecting = await serve((_request, response) => { response.writeHead(302, { Location: '/elsewhere' }); response.end(); });
  const failures = async (purpose?: 'login' | 'thread' | 'coordinator') => {
    const options = { timeoutMs: 30, ...(purpose ? { purpose } : {}) };
    const late = await (await fetch(`${await relay(unreachable, options)}/api/mesh/projects/example`)).json() as { message: string };
    const moved = await (await fetch(`${await relay(redirecting, options)}/api/mesh/projects/example`)).json() as { message: string };
    return [late.message, moved.message];
  };
  expect(await failures()).toEqual(["Can't reach the conversation owner (Fixture owner). Its work remains on that device.", 'The conversation owner returned an unexpected redirect.']);
  expect(await failures('login')).toEqual(["Can't reach the login device (Fixture owner). The login remains on that device.", 'The login device returned an unexpected redirect.']);
  expect(await failures('thread')).toEqual(["Can't reach Fixture owner. This thread's work stays on that device.", "The thread's device returned an unexpected redirect."]);
  expect(await failures('coordinator')).toEqual(["Can't reach Fixture owner. The coordinator stays on that device.", "The coordinator's device returned an unexpected redirect."]);
  for (const text of [...await failures('thread'), ...await failures('coordinator')]) expect(text.toLowerCase()).not.toContain('conversation');
});
