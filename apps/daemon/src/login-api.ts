import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { DeviceOriginSchema, EmptySchema, ErrorDocumentSchema, HubUnavailable, IdSchema, LoginCodeSchema, LoginStartSchema, PeerLoginSessionInputSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { forwardOwner } from './owner-proxy.js';

const peerPrefix = '/api/mesh/login/';
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/** A narrow peer endpoint: provider login only, never arbitrary authenticated APIs. */
export async function handleLoginApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, token?: string): Promise<boolean> {
  const peer = url.pathname.startsWith(peerPrefix);
  const path = peer ? `/api/${url.pathname.slice(peerPrefix.length)}` : url.pathname;
  const start = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/login$/);
  const login = path.match(/^\/api\/logins\/([A-Za-z0-9_-]+)$/);
  if (!start && !login) { if (peer) throw failure('Login operation not found.', 404); return false; }
  const method = request.method ?? 'GET'; let retryable = true;
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  try {
    if (start ? method !== 'POST' : !['GET', 'POST', 'DELETE'].includes(method)) throw failure('Unsupported login method.', 405);
    if (peer) {
      if (request.headers.origin || request.headers['sec-fetch-site']) throw failure('Use the device connection for this request.', 403);
      const authorization = request.headers.authorization;
      const input = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
      if (!input.success || !await app.peerLoginAuthenticated(input.data)) throw failure('Sign in to Jevellan.', 401);
      app.redactor.add(input.data.token);
    } else {
      const deviceId = IdSchema.parse(url.searchParams.get('deviceId') ?? app.device.deviceId);
      if (deviceId !== app.device.deviceId) {
        const target = (await app.roster()).devices.find(row => row.device.id === deviceId);
        if (!target || target.revoked) throw failure('The login device is no longer available in this mesh.', 409);
        if (target.status === 'offline') throw failure(`${target.device.name} is offline. Log in when it is back.`, 409);
        const upstream = new URL(DeviceOriginSchema.parse(target.device.url)); upstream.pathname = `${peerPrefix}${path.slice('/api/'.length)}`;
        const body = method === 'GET' ? undefined : JSON.stringify(await requestBody(request));
        await forwardOwner(request, response, { url: upstream, ownerName: target.device.name, sourceDeviceId: app.device.deviceId, token: token!, stream: false, purpose: 'login', ...(body === undefined ? {} : { body }) });
        return true;
      }
    }
    if (start) {
      const input = LoginStartSchema.parse(await requestBody(request)); const requestId = input.schema === 'login-start-v1' ? input.clientRequestId : undefined;
      retryable = requestId !== undefined; send(await app.accounts.beginLogin(IdSchema.parse(start[1]), requestId), 201);
    } else {
      const id = IdSchema.parse(login![1]);
      if (method === 'GET') send(await app.accounts.pollLogin(id));
      else if (method === 'DELETE') { EmptySchema.parse(await requestBody(request)); await app.accounts.cancelLogin(id); send(await app.accounts.pollLogin(id)); }
      else {
        const input = LoginCodeSchema.parse(await requestBody(request)); retryable = false;
        try { send(await app.accounts.submitLogin(id, input.code)); }
        catch (error) { retryable = app.accounts.loginSubmissionAccepted(id); throw error; }
      }
    }
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 400;
    send(ErrorDocumentSchema.parse({ schema: 'error-v1', code: error instanceof HubUnavailable ? 'hub-unavailable' : status === 409 ? 'conflict' : status === 401 ? 'unauthenticated' : status === 404 ? 'not-found' : 'request-failed', ...(error instanceof HubUnavailable ? { retryable } : {}), message: error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.redactor.text(candidate.message) : 'The login could not complete.' }), status);
  }
  return true;
}
