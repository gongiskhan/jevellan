import { UiAuth } from '@jevellan/mesh';
import { CursorMessageInputSchema, CursorMessageSchema, DeviceOriginSchema, ErrorDocumentSchema, NativeConversationCommandSchema, NativeMessageReceiptSchema,
  NativeSessionRefSchema, applyNativeTranscriptRead, nativeConversationPresentation, nativeTranscriptInitial, type NativeConversationCommand } from '@jevellan/core';
import type { Application } from './application.js';
import { readNativeTranscriptView } from './native-reading-view.js';
import { readNativeViewerTitle } from './native-viewer-title.js';
import { OWNER_REQUEST_TIMEOUT_MS } from './owner-proxy.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
export async function readNativeConversationView(app: Application, rawRef: unknown, viewerDeviceId = app.device.deviceId, token?: string) {
  const ref = NativeSessionRefSchema.parse(rawRef);
  const [reading, viewer] = await Promise.all([readNativeTranscriptView(app, ref, token), readNativeViewerTitle(app, { schema: 'native-viewer-title-request-v1', deviceId: viewerDeviceId, ref })]);
  const state = applyNativeTranscriptRead(nativeTranscriptInitial(ref), reading);
  return { schema: 'native-conversation-read-view-v1' as const, reading, viewer, presentation: nativeConversationPresentation(state, viewer) };
}
async function messageSource(app: Application, command: NativeConversationCommand, token?: string) {
  const { ref } = command;
  const input = command.operation === 'send' ? CursorMessageInputSchema.parse({ ...command.payload, schema: 'cursor-message-input-v1' }) : null;
  if (ref.gatewayDeviceId === app.device.deviceId) return command.operation === 'send'
    ? app.cursor.send(ref.ownerDeviceId, ref.id, input) : app.cursor.cancel(ref.ownerDeviceId, ref.id, command.clientMessageId);
  const target = (await app.roster()).devices.find(row => row.device.id === ref.gatewayDeviceId && !row.revoked);
  if (!target) throw refuse('The native session device is no longer available in this mesh.', 404);
  const url = new URL(DeviceOriginSchema.parse(target.device.url));
  url.pathname = `/api/mesh/cursor/${ref.id}/messages${command.operation === 'cancel' ? `/${command.clientMessageId}` : ''}`;
  url.searchParams.set('deviceId', ref.ownerDeviceId);
  let response: Response;
  try { response = await fetch(url, { method: command.operation === 'send' ? 'POST' : 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token!}`, 'X-Jevellan-Source-Device': app.device.deviceId, 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}) }); }
  catch { throw refuse(`Can't reach ${target.device.name}. The message receipt could not be read.`, 502); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw refuse('The native session device returned an unexpected redirect.', 502); }
  const reply: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = ErrorDocumentSchema.safeParse(reply); throw refuse(error.success ? error.data.message : 'The native session device could not answer.', error.success ? response.status : 502); }
  return CursorMessageSchema.parse(reply);
}
/** The canonical writer enforces fresh resources and accepted replay; never add a discovery read before it. */
export async function executeNativeMessage(app: Application, raw: unknown, providedToken?: string) {
  const command = NativeConversationCommandSchema.parse(raw), auth = app.auth;
  if (!providedToken && !(auth instanceof UiAuth)) throw refuse('Native owner tools must run through the state point.', 409);
  const token = providedToken ?? (auth as UiAuth).issue(); app.redactor.add(token);
  try {
    const message = CursorMessageSchema.parse(await messageSource(app, command, token));
    const clientMessageId = command.operation === 'send' ? command.payload.clientMessageId : command.clientMessageId;
    if (message.clientMessageId !== clientMessageId) throw refuse('The message receipt belongs to another command.', 502);
    return NativeMessageReceiptSchema.parse({ schema: 'native-message-receipt-v1', ref: command.ref, message });
  } finally { if (!providedToken) (auth as UiAuth).logout(token); }
}
