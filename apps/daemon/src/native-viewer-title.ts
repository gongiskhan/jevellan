import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceOriginSchema, ErrorDocumentSchema, NativeViewerTitleRequestSchema, NativeViewerTitleSchema, PeerLoginSessionInputSchema, nativeSessionKey, nativeViewerTitle } from '@jevellan/core';
import { readSessionListPreferences } from '@jevellan/conversations';
import { UiAuth } from '@jevellan/mesh';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { OWNER_REQUEST_TIMEOUT_MS } from './owner-proxy.js';

const path = '/api/mesh/native-viewer-title';
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
function localTitle(app: Application, raw: unknown) {
  const input = NativeViewerTitleRequestSchema.parse(raw);
  if (input.deviceId !== app.device.deviceId) throw refuse('Read the title from its viewing device.', 409);
  return nativeViewerTitle(app.device.deviceId, readSessionListPreferences(app.homes), input.ref);
}
/** Read only one local viewer override, through the existing authenticated state-point broker. */
export async function handleNativeViewerTitlePeer(app: Application, request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') throw refuse('Unsupported title operation.', 405);
  if (request.headers.origin || request.headers['sec-fetch-site']) throw refuse('Use the device connection for this request.', 403);
  const caller = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: request.headers.authorization?.replace(/^Bearer /u, '') });
  if (!caller.success || !await app.peerLoginAuthenticated(caller.data)) throw refuse('Sign in to Jevellan.', 401);
  app.redactor.add(caller.data.token);
  if (!(await app.roster()).devices.some(row => row.device.id === caller.data.sourceDeviceId && row.device.role === 'hub' && !row.revoked)) throw refuse('Title tools must come through the state point.', 403);
  json(response, app.redactor.document(localTitle(app, await requestBody(request))));
}
export async function readNativeViewerTitle(app: Application, raw: unknown) {
  const input = NativeViewerTitleRequestSchema.parse(raw);
  if (input.deviceId === app.device.deviceId) return localTitle(app, input);
  const target = (await app.roster()).devices.find(row => row.device.id === input.deviceId && !row.revoked);
  if (!target) throw refuse('The viewing device is no longer available in this mesh.', 409);
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw refuse('Title tools must run through the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try {
    const url = new URL(DeviceOriginSchema.parse(target.device.url)); url.pathname = path;
    let response: Response;
    try { response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), headers: {
      Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input) }); }
    catch { throw refuse(`Can't reach ${target.device.name}. Its saved titles remain there.`, 502); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw refuse('The viewing device returned an unexpected redirect.', 502); }
    const reply: unknown = await response.json().catch(() => null);
    if (!response.ok) { const error = ErrorDocumentSchema.safeParse(reply); throw refuse(error.success ? error.data.message : 'The viewing device could not answer.', error.success ? response.status : 502); }
    const title = NativeViewerTitleSchema.parse(reply);
    if (title.deviceId !== input.deviceId || title.key !== nativeSessionKey(input.ref)) throw refuse('The returned title belongs to another resource.', 502);
    return title;
  } finally { auth.logout(token); }
}
