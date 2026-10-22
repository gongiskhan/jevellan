import {AppShellViewSchema} from '@jevellan/core';
import {GitEditorViewSchema,gitEditorCommandResult} from '@jevellan/core';
import {readGitEditor,localGitEditorCommand} from './git-editor.js';
import {readAppShell} from './app-shell-view.js';
import {contextEditorDeviceResult} from '@jevellan/core';
import {localContextEditorOperation} from './context-editor.js';
import {FirstRunViewSchema, FirstRunNavigationSchema} from '@jevellan/core';
import {readFirstRun, nextFirstRun} from './first-run-view.js';
import { ProjectSetupViewSchema } from '@jevellan/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceOriginSchema, ErrorDocumentSchema, PeerLoginSessionInputSchema, ProjectDefinitionPeerRequestSchema, ProjectDefinitionEditorSchema, ProjectDefinitionsViewSchema, ProjectViewSchema } from '@jevellan/core';
import { UiAuth } from '@jevellan/mesh';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';
import { OWNER_REQUEST_TIMEOUT_MS } from './owner-proxy.js';
const path = '/api/mesh/project-definitions';
const refuse = (message: string, status: number) => Object.assign(new Error(message), { status });
/** Closed device-local operations use the same peer session authorization as device cleanup/worktrees. */
export async function handleProjectDefinitionsPeer(app: Application, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') throw refuse('Unsupported project operation.', 405);
  if (request.headers.origin || request.headers['sec-fetch-site']) throw refuse('Use the device connection for this request.', 403);
  const authorization = request.headers.authorization;
  const caller = PeerLoginSessionInputSchema.safeParse({ schema: 'peer-login-session-input-v1', sourceDeviceId: request.headers['x-jevellan-source-device'], token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined });
  if (!caller.success || !await app.peerLoginAuthenticated(caller.data)) throw refuse('Sign in to Jevellan.', 401);
  app.redactor.add(caller.data.token); const input = ProjectDefinitionPeerRequestSchema.parse(await requestBody(request));
  if(input.operation==='git-view'||input.operation==='git-command'){const result=input.operation==='git-view'?await readGitEditor(app):await localGitEditorCommand(app,input.input);json(response,app.redactor.document(result));return;}
  if (input.operation === 'app-view') { json(response, app.redactor.document(await readAppShell(app))); return; }
  if ('deviceId' in input) { json(response, app.redactor.document(await localContextEditorOperation(app, input))); return; }
  if (input.operation === 'first-run-view' || input.operation === 'first-run-next') { const result = input.operation === 'first-run-view' ? await readFirstRun(app, input.input) : await nextFirstRun(app, input.input); json(response, app.redactor.document(result)); return; }
  const result = input.operation === 'setup-view' ? await app.projectSetupView(input.projectId) : input.operation === 'view' ? await app.projectDefinitions() : input.operation === 'read' ? await app.projectDefinitionRead(input.input) : input.operation === 'preview' ? await app.projectDefinitionPreview(input.input) : await app.saveProjectDefinition(input.input);
  json(response, app.redactor.document(result));
}
export async function projectDefinitionDeviceOperation(app: Application, targetDeviceId: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
  const input = ProjectDefinitionPeerRequestSchema.parse(raw), target = (await app.roster()).devices.find(row => row.device.id === targetDeviceId);
  if (!target || target.revoked) throw refuse('The project device is no longer available in this mesh.', 409);
  if (target.status === 'offline') throw refuse(`${target.device.name} is offline. Project files remain there.`, 409);
  if(input.operation==='git-command'&&input.input.deviceId!==targetDeviceId)throw refuse('These Git settings belong to another device.',409);
  signal?.throwIfAborted();
  const auth = app.auth; if (!(auth instanceof UiAuth)) throw refuse('Owner tools must run on the state point.', 409);
  const token = auth.issue(); app.redactor.add(token);
  try {
    const url = new URL(DeviceOriginSchema.parse(target.device.url)); url.pathname = path;
    let response: Response;
    try { response = await fetch(url, { method: 'POST', redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(OWNER_REQUEST_TIMEOUT_MS), headers: { Authorization: `Bearer ${token}`, 'X-Jevellan-Source-Device': app.device.deviceId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input) }); }
    catch { throw refuse(`Can't reach ${target.device.name}. Project files remain there.`, 502); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw refuse('The project device returned an unexpected redirect.', 502); }
    const rawReply: unknown = await response.json().catch(() => null);
    if (!response.ok) { const error = ErrorDocumentSchema.safeParse(rawReply); throw refuse(error.success ? error.data.message : 'The project device could not complete the request.', error.success ? response.status : 502); }
    if(input.operation==='git-view'){const result=GitEditorViewSchema.parse(rawReply);if(result.deviceId!==targetDeviceId)throw refuse('The returned Git view belongs to another device.',502);return result;}
    if(input.operation==='git-command'){try{return gitEditorCommandResult(input.input,rawReply);}catch{throw refuse('The Git device returned an unexpected response.',502);}}
    if (input.operation === 'app-view') { const result=AppShellViewSchema.parse(rawReply); if(result.deviceId!==targetDeviceId) throw refuse('The returned app view belongs to another device.',502); return result; }
    if ('deviceId' in input) { try { return contextEditorDeviceResult(input, rawReply); } catch { throw refuse('The context device returned an unexpected response.', 502); } }
    if (input.operation === 'first-run-view' || input.operation === 'first-run-next') { const result = input.operation === 'first-run-view' ? FirstRunViewSchema.parse(rawReply) : FirstRunNavigationSchema.parse(rawReply); if (result.deviceId !== targetDeviceId) throw refuse('The returned setup belongs to another device.', 502); return result; }
    if (input.operation === 'setup-view') { const result = ProjectSetupViewSchema.parse(rawReply); if (result.deviceId !== targetDeviceId || result.projectId !== input.projectId) throw refuse('The returned setup belongs to another device or project.', 502); return result; }
    if (input.operation === 'view') { const result = ProjectDefinitionsViewSchema.parse(rawReply); if (result.currentDeviceId !== targetDeviceId) throw refuse('The returned projects belong to another device.', 502); return result; }
    if (input.operation === 'save') { const result = ProjectViewSchema.parse(rawReply); if (result.project.id !== input.input.context.projectId) throw refuse('The returned project does not match the request.', 502); return result; }
    const result = ProjectDefinitionEditorSchema.parse(rawReply), id = input.operation === 'read' ? input.input.projectId : input.input.context.projectId;
    if (result.currentDeviceId !== targetDeviceId || (id && result.context.projectId !== id)) throw refuse('The returned project draft does not match the device or request.', 502);
    return result;
  } finally { auth.logout(token); }
}
