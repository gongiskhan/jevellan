import { UiAuth } from '@jevellan/mesh';
import { CursorTranscriptSchema, DeviceOriginSchema, ErrorDocumentSchema, NativeSessionRefSchema, nativeListFailed, nativeListReady,
  nativeTranscriptFailed, nativeTranscriptReady, type NativeListReadView, type NativeSessionRef, type NativeTranscriptReadView } from '@jevellan/core';
import type { Application } from './application.js';
import { cursorListSource } from './cursor-api.js';
import { OWNER_REQUEST_TIMEOUT_MS } from './owner-proxy.js';

const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
const errorText = (app: Application, error: unknown) => app.redactor.text(error instanceof Error ? error.message : 'The native session could not be read.').slice(0, 4000);
async function withOwnerToken<T>(app: Application, provided: string | undefined, operation: (token: string | undefined) => Promise<T>): Promise<T> {
  if (provided) return operation(provided);
  const auth = app.auth;
  if (!(auth instanceof UiAuth)) throw refuse('Native owner tools must run through the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try { return await operation(token); } finally { auth.logout(token); }
}
/** List metadata uses the established local/peer reader; there is no new transcript cache or discovery pass. */
export async function readNativeListView(app: Application, token?: string, peer = false): Promise<NativeListReadView> {
  try { return await withOwnerToken(app, token, async session => nativeListReady(await cursorListSource(app, session, peer))); }
  catch (error) { return nativeListFailed(errorText(app, error)); }
}
async function transcriptSource(app: Application, ref: NativeSessionRef, token: string | undefined) {
  if (ref.gatewayDeviceId === app.device.deviceId) {
    const projects = (await app.state.projects.list()).flatMap(row => row.project.paths[app.device.deviceId] ? [row.project.paths[app.device.deviceId]!] : []);
    return app.cursor.read(ref.ownerDeviceId, ref.id, projects);
  }
  const target = (await app.roster()).devices.find(row => row.device.id === ref.gatewayDeviceId && !row.revoked);
  if (!target) throw refuse('The native session device is no longer available in this mesh.', 404);
  // As with the legacy raw reader, a known non-revoked device is tried even if its last heartbeat is stale.
  const url = new URL(DeviceOriginSchema.parse(target.device.url)); url.pathname = `/api/mesh/cursor/${ref.id}`; url.searchParams.set('deviceId', ref.ownerDeviceId);
  let response: Response;
  try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), headers: {
    Authorization: `Bearer ${token!}`, 'X-Jevellan-Source-Device': app.device.deviceId, Accept: 'application/json' } }); }
  catch { throw refuse(`Can't reach ${target.device.name}. Its native sessions remain there.`, 502); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw refuse('The native session device returned an unexpected redirect.', 502); }
  const reply: unknown = await response.json().catch(() => null);
  if (!response.ok) { const error = ErrorDocumentSchema.safeParse(reply); throw refuse(error.success ? error.data.message : 'The native session device could not answer.', error.success ? response.status : 502); }
  return CursorTranscriptSchema.parse(reply);
}
/** Remote purposes wrap the existing raw peer protocol, including older owners that do not implement this purpose. */
export async function readNativeTranscriptView(app: Application, rawRef: unknown, token?: string): Promise<NativeTranscriptReadView> {
  const ref = NativeSessionRefSchema.parse(rawRef);
  try { return await withOwnerToken(app, token, async session => nativeTranscriptReady(ref, await transcriptSource(app, ref, session))); }
  catch (error) { return nativeTranscriptFailed(ref, errorText(app, error)); }
}
