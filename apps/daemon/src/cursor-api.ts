import type { IncomingMessage, ServerResponse } from 'node:http';
import { CursorListSchema, IdSchema, PeerLoginSessionInputSchema, DeviceOriginSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { forwardOwner } from './owner-proxy.js';

const peerPrefix = '/api/mesh/cursor';
const snapshots = new WeakMap<Application, Map<string, ReturnType<typeof CursorListSchema.parse>>>();
const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
export async function handleCursorApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token?: string) {
  const peer = url.pathname === peerPrefix || url.pathname.startsWith(`${peerPrefix}/`);
  const path = peer ? url.pathname.replace(peerPrefix, '/api/cursor') : url.pathname;
  if (path !== '/api/cursor' && !path.startsWith('/api/cursor/')) return false;
  if (peer) {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw fail('Use the device connection for this request.', 403);
    const auth = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: request.headers.authorization?.replace(/^Bearer /, '') });
    if (!auth.success || !await app.peerLoginAuthenticated(auth.data)) throw fail('Sign in to Jevellan.', 401);
    app.redactor.add(auth.data.token);
  }
  const method = request.method ?? 'GET';
  const send = (value: unknown) => json(response, app.redactor.document(value));
  const gateway = IdSchema.parse(url.searchParams.get('gateway') ?? app.device.deviceId);
  if (!peer && gateway !== app.device.deviceId) {
    const target = (await app.roster()).devices.find(row => row.device.id === gateway && !row.revoked);
    if (!target) throw fail('The Cursor device is no longer available in this mesh.', 404);
    const upstream = new URL(DeviceOriginSchema.parse(target.device.url));
    upstream.pathname = path.replace('/api/cursor', peerPrefix); upstream.search = url.search; upstream.searchParams.delete('gateway');
    const body = method === 'POST' ? JSON.stringify(await requestBody(request)) : undefined;
    await forwardOwner(request, response, { url: upstream, ownerName: target.device.name, sourceDeviceId: app.device.deviceId, token: token!, stream: false, ...(body === undefined ? {} : { body }) });
    return true;
  }
  if (path === '/api/cursor/connections') {
    if (peer) throw fail('Configure the connection from its owning device.', 403);
    if (method === 'GET') send(app.cursor.connections());
    else if (method === 'POST') send(app.cursor.saveConnections(await requestBody(request)));
    else throw fail('Unsupported method.', 405);
    return true;
  }
  const deviceId = IdSchema.parse(url.searchParams.get('deviceId') ?? app.device.deviceId);
  if (path === '/api/cursor/hooks' && method === 'GET') { send(app.cursor.hookSetup(deviceId)); return true; }
  const projects = (await app.state.projects.list()).flatMap(row => row.project.paths[app.device.deviceId] ? [row.project.paths[app.device.deviceId]!] : []);
  if (path === '/api/cursor' && method === 'GET') {
    const localPromise = app.cursor.list(projects);
    const remote = peer ? [] : (await app.roster()).devices.filter(row => row.device.id !== app.device.deviceId && !row.revoked);
    const cache = snapshots.get(app) ?? new Map<string, ReturnType<typeof CursorListSchema.parse>>(); snapshots.set(app, cache);
    const peers = await Promise.all(remote.map(async row => {
      try {
        if (row.status === 'offline') throw new Error();
        const upstream = new URL('/api/mesh/cursor', DeviceOriginSchema.parse(row.device.url));
        const result = await fetch(upstream, { redirect: 'error', signal: AbortSignal.timeout(18_000), headers: {
          Authorization: `Bearer ${token!}`, 'X-Jevellan-Source-Device': app.device.deviceId,
        } });
        if (!result.ok) throw new Error();
        const list = CursorListSchema.parse(await result.json()); cache.set(row.device.id, list); return list;
      } catch {
        return { schema: 'cursor-list-v1' as const, observedAt: new Date().toISOString(), unavailable: [`${row.device.name}: Cursor sessions are unavailable.`],
          sessions: (cache.get(row.device.id)?.sessions ?? []).filter(session => Date.now() - Date.parse(session.lastActivityAt) < 5 * 86_400_000)
            .map(session => ({ ...session, connected: false, state: 'unknown' as const, canSteer: false, canSend: false })) };
      }
    }));
    const local = await localPromise;
    send(CursorListSchema.parse({ schema: 'cursor-list-v1', observedAt: new Date().toISOString(),
      sessions: [...local.sessions.map(session => ({ ...session, gatewayDeviceId: app.device.deviceId })), ...peers.flatMap(list => list.sessions)]
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
      unavailable: [...local.unavailable, ...peers.flatMap(list => list.unavailable)] }));
    return true;
  }
  const match = /^\/api\/cursor\/(cursor_[a-f0-9]{32})(?:\/messages(?:\/([A-Za-z0-9_-]+))?)?$/.exec(path);
  if (match) {
    if (method === 'GET' && !path.endsWith('/messages')) send(await app.cursor.read(deviceId, match[1]!, projects));
    else if (method === 'POST' && path.endsWith('/messages')) send(await app.cursor.send(deviceId, match[1]!, await requestBody(request)));
    else if (method === 'DELETE' && match[2]) send(await app.cursor.cancel(deviceId, match[1]!, match[2]));
    else throw fail('Unsupported Cursor operation.', 405);
    return true;
  }
  throw fail('Cursor operation not found.', 404);
}
