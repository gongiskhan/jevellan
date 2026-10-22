import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceOriginSchema, ErrorDocumentSchema, NativeConnectionsEditorSchema, NativeConnectionsOperationSchema, NativeConnectionsSavedSchema,
  PeerLoginSessionInputSchema, nativeConnectionsEditor, newId, prepareNativeConnectionCommand } from '@jevellan/core';
import { UiAuth } from '@jevellan/mesh';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { OWNER_REQUEST_TIMEOUT_MS } from './owner-proxy.js';

const path = '/api/mesh/native-connections';
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
function localOperation(app: Application, raw: unknown) {
  const input = NativeConnectionsOperationSchema.parse(raw);
  if (input.deviceId !== app.device.deviceId) throw refuse('Configure the connection from its owning device.', 409);
  const editor = () => nativeConnectionsEditor(app.cursor.connections(), { schema: 'native-connection-context-v1', deviceId: app.device.deviceId, draftId: newId('cursor_remote') });
  if (input.operation === 'read') return editor();
  // No await between the current read and the existing canonical writer.
  const prepared = prepareNativeConnectionCommand(app.cursor.connections(), input.request, app.device.deviceId);
  if (!prepared.repeated) app.cursor.saveConnections(prepared.connections);
  return NativeConnectionsSavedSchema.parse({ schema: 'native-connections-saved-v1', repeated: prepared.repeated, editor: editor() });
}

/** A closed owner-tool operation; the existing generic Cursor peer configuration route remains refused. */
export async function handleNativeConnectionsPeer(app: Application, request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') throw refuse('Unsupported connection operation.', 405);
  if (request.headers.origin || request.headers['sec-fetch-site']) throw refuse('Use the device connection for this request.', 403);
  const caller = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: request.headers.authorization?.replace(/^Bearer /u, '') });
  if (!caller.success || !await app.peerLoginAuthenticated(caller.data)) throw refuse('Sign in to Jevellan.', 401);
  app.redactor.add(caller.data.token);
  const broker = (await app.roster()).devices.find(row => row.device.id === caller.data.sourceDeviceId && row.device.role === 'hub' && !row.revoked);
  if (!broker) throw refuse('Connection tools must come through the state point.', 403);
  json(response, app.redactor.document(localOperation(app, await requestBody(request))));
}

export async function nativeConnectionsDeviceOperation(app: Application, targetDeviceId: string, raw: unknown) {
  const input = NativeConnectionsOperationSchema.parse(raw);
  if (input.deviceId !== targetDeviceId || (input.operation === 'command' && input.request.context.deviceId !== targetDeviceId)) throw refuse('Configure the connection from its owning device.', 409);
  if (targetDeviceId === app.device.deviceId) return localOperation(app, input);
  const target = (await app.roster()).devices.find(row => row.device.id === targetDeviceId && !row.revoked);
  if (!target) throw refuse('The connection device is no longer available in this mesh.', 409);
  if (target.status === 'offline') throw refuse(`${target.device.name} is offline. Its connections remain there.`, 409);
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw refuse('Connection tools must run through the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try {
    const url = new URL(DeviceOriginSchema.parse(target.device.url)); url.pathname = path;
    let response: Response;
    try { response = await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), headers: {
      Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input) }); }
    catch { throw refuse(`Can't reach ${target.device.name}. Its connections remain there.`, 502); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw refuse('The connection device returned an unexpected redirect.', 502); }
    const reply: unknown = await response.json().catch(() => null);
    if (!response.ok) { const error = ErrorDocumentSchema.safeParse(reply); throw refuse(error.success ? error.data.message : 'The device could not complete the connection request.', error.success ? response.status : 502); }
    const result = input.operation === 'read' ? NativeConnectionsEditorSchema.parse(reply) : NativeConnectionsSavedSchema.parse(reply);
    const editor = 'editor' in result ? result.editor : result;
    if (editor.deviceId !== targetDeviceId) throw refuse('The returned connection settings belong to another device.', 502);
    return result;
  } finally { auth.logout(token); }
}
