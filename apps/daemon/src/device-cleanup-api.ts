import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceOriginSchema, IdSchema, PeerLoginSessionInputSchema, EmptySchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { forwardOwner } from './owner-proxy.js';
export const DEVICE_CLEANUP_ROUTE = /^\/api\/(mesh\/)?devices\/([A-Za-z0-9_-]+)\/cleanup$/u;
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
/** Closed owner-authenticated path: no arbitrary remote filesystem or command operation. */
export async function handleDeviceCleanup(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token?: string) {
  const match = url.pathname.match(DEVICE_CLEANUP_ROUTE); if (!match) return false;
  const deviceId = IdSchema.parse(match[2]), peer = !!match[1];
  if (!['GET', 'POST'].includes(request.method ?? 'GET')) throw fail('Operation not found.', 404);
  if (peer) {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw fail('Use the device connection for this request.', 403);
    const authorization = request.headers.authorization;
    const input = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
    if (!input.success || !await app.peerLoginAuthenticated(input.data)) throw fail('Sign in to Jevellan.', 401);
    app.redactor.add(input.data.token);
    if (deviceId !== app.device.deviceId) throw fail('This cleanup request belongs to another device.', 403);
  } else if (deviceId !== app.device.deviceId) {
    const target = (await app.roster()).devices.find(row => row.device.id === deviceId && !row.revoked);
    if (!target || target.status === 'offline') throw fail('This device is offline.');
    const upstream = new URL(DeviceOriginSchema.parse(target.device.url)); upstream.pathname = `/api/mesh/devices/${deviceId}/cleanup`;
    const body = request.method === 'POST' ? JSON.stringify(EmptySchema.parse(await requestBody(request))) : undefined;
    await forwardOwner(request, response, { url: upstream, token: token!, sourceDeviceId: app.device.deviceId, ownerName: target.device.name,
      stream: false, purpose: 'device', timeoutMs: 60_000, ...(body ? { body } : {}) }); return true;
  }
  json(response, await localDeviceCleanup(app, request.method === 'GET' ? 'GET' : 'POST', request.method === 'GET' ? undefined : await requestBody(request)));
  return true;
}
/** The same canonical operation for authenticated HTTP and trusted owner tools. */
export async function localDeviceCleanup(app: Application, method: 'GET'|'POST', raw?: unknown) {
  await app.started;
  if (method === 'GET') return app.cleanup.state();
  EmptySchema.parse(raw); return app.cleanup.run();
}
