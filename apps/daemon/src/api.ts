import { handleGitApi } from './git-api.js';
import { projectFolders } from './project-folders.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { CorrectionsListSchema, CorrectionsReadSchema, ErrorDocumentSchema, IdSchema, ProjectWriteSchema, SecretSummarySchema, EmptySchema, ConfigWriteSchema, ImportSchema, SecretInputSchema, AccountListSchema, RiggingListSchema, RuntimeListSchema, exportConfiguration, parseConfiguration, stableJson } from '@jevellan/core';
import { HubUnavailable, clearSessionCookie, sessionCookie, sessionFromCookie } from '@jevellan/mesh';
import { AddAccountSchema, AddRiggingSchema, ReplaceCredentialSchema, UpdateAccountSchema, UpdateRiggingSchema } from '@jevellan/core';
import { Application } from './application.js';
import { conversationRoute, handleConversation } from './conversation-api.js';
import { handleOwnerRequest, proxyConversation } from './owner-proxy.js';
import { json, requestBody as body } from './http.js';
import { handleMeshDeviceApi, handleMeshUiApi } from './mesh-api.js';
import { handleLoginApi } from './login-api.js';

export { json } from './http.js';
function failure(message: string, status: number) { return Object.assign(new Error(message), { status }); }
export function requireOrigin(request: IncomingMessage, allowedOrigins: readonly string[], proxyOrigin?: string): boolean {
  const host = request.headers.host;
  if (!host || host.includes('@') || host.includes('/') || host.includes('\\')) throw failure('Unknown request host.', 403);
  const loopback = (address: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
  const forwarded = proxyOrigin?.startsWith('https://') && loopback(request.socket.remoteAddress) && loopback(request.socket.localAddress) && request.headers['x-forwarded-proto'] === 'https' && request.headers['x-forwarded-host'] === new URL(proxyOrigin).host;
  const secure = Boolean('encrypted' in request.socket && request.socket.encrypted || forwarded);
  const origin = forwarded ? proxyOrigin! : `${secure ? 'https' : 'http'}://${host}`;
  const local = new URL(origin);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) && Number(local.port || (secure ? 443 : 80)) === request.socket.localPort;
  if (!isLocal && !allowedOrigins.includes(origin)) throw failure('Unknown request host.', 403);
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    // Browser mutations always send Origin. JSON requests without it are local CLI clients.
    if (request.headers.origin && request.headers.origin !== origin) throw failure('Open Jevellan directly before changing settings.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw failure('Open Jevellan directly before changing settings.', 403);
  }
  return secure;
}
function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (stableJson(before) === stableJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>; const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((key) => changedPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path || '/'];
}

export async function handleApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, options: { allowedOrigins?: readonly string[]; secureCookies?: boolean; proxyOrigin?: string } = {}): Promise<void> {
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  let retryable = false;
  let release: (() => void) | undefined;
  try {
    const secureRequest = requireOrigin(request, options.allowedOrigins ?? [], options.proxyOrigin);
    const secureCookies = options.secureCookies ?? secureRequest;
    const path = url.pathname; const method = request.method ?? 'GET'; const token = sessionFromCookie(request.headers.cookie);
    if (!['GET', 'HEAD'].includes(method)) release = app.lifecycle.enter({ kind: 'request' });
    if (await handleOwnerRequest(app, request, response, url)) return;
    if (path.startsWith('/api/mesh/login/') && await handleLoginApi(app, request, response, url)) return;
    if (await handleMeshDeviceApi(app, request, response, url)) return;
    if (path === '/switch' && method === 'GET') { await handleMeshUiApi(app, request, response, url, secureCookies); return; }
    if (path === '/api/bridge' && method === 'POST') {
      const authorization = request.headers.authorization;
      const stretchToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      send(await app.bridges.request(stretchToken, await body(request))); return;
    }
    if (path === '/api/auth' && method === 'GET') { retryable = true; send(await app.auth.state(token)); return; }
    if (['/api/auth/setup', '/api/auth/login'].includes(path) && method === 'POST') {
      const input = await body(request);
      retryable = path === '/api/auth/login';
      const session = path.endsWith('/setup') ? await app.auth.setup(input) : await app.auth.login(input, request.socket.remoteAddress ?? 'unknown');
      response.setHeader('Set-Cookie', sessionCookie(session, secureCookies)); send(await app.auth.state(session)); return;
    }
    retryable = true; // No UI operation has been admitted before authentication succeeds.
    if (!await app.auth.verify(token)) throw failure('Sign in to Jevellan.', 401);
    retryable = method === 'GET' && !path.startsWith('/api/logins/');
    if (method === 'POST' && ['/hub/devices/invitations', '/api/devices/switch'].includes(path)) retryable = true;
    if (await handleMeshUiApi(app, request, response, url, secureCookies)) return;
    if (await handleLoginApi(app, request, response, url, token)) return;
    if (await handleGitApi(app, request, response, url)) return;
    if (path === '/api/project-folders' && method === 'GET') { send(await projectFolders(app.homes.userHome, url.searchParams.get('path') ?? undefined)); return; }
    if (path === '/hub/projects' && method === 'GET') { await app.conversations.ready; send((await app.conversations.projects())); return; }
    if (path === '/hub/projects' && method === 'PUT') { const input = ProjectWriteSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; send(await app.conversations.saveProject(input)); return; }
    const visibility = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/visibility$/);
    if (visibility && method === 'GET') {
      await app.conversations.ready;
      const project = (await app.conversations.projects()).projects.find((row) => row.project.id === IdSchema.parse(visibility[1]))?.project;
      if (!project) throw failure('Project not found.', 404);
      send(await app.projectVisibility.inspect(project, app.device.deviceId)); return;
    }
    const contextOperation = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/context\/(operations|continue|review)$/);
    if (contextOperation) {
      await app.conversations.ready; const id = IdSchema.parse(contextOperation[1]);
      if (method === 'GET' && contextOperation[2] === 'operations') { send((await app.conversations.contextPanel(id))); return; }
      if (method === 'GET' && contextOperation[2] === 'review') { send(await app.conversations.reviewContext(id, url.searchParams.get('operation') ?? '')); return; }
      if (method === 'POST' && contextOperation[2] !== 'review') { retryable = true; send(contextOperation[2] === 'continue' ? await app.conversations.continueContext(id, await body(request)) : await app.conversations.configureContext(id, await body(request)), 202); return; }
    }
    const project = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/(context|memory)$/);
    if (project && method === 'GET') {
      await app.conversations.ready; const id = IdSchema.parse(project[1]);
      if (project[2] === 'context') send((await app.conversations.context(id)));
      else {
        const signal = AbortSignal.timeout(30_000); const memory = (await app.conversations.memory(id)); const permalink = url.searchParams.get('permalink');
        if (permalink) send(await memory.read(permalink, signal));
        else { const query = url.searchParams.get('query'); if (!query?.trim()) throw new Error('Enter a memory search.'); send(await memory.search(query, signal)); }
      }
      return;
    }
    if (path === '/api/conversations' && method === 'GET') { await app.conversations.ready; send(await app.conversations.list()); return; }
    if (path === '/api/conversations' && method === 'POST') { retryable = true; send(await app.conversations.create(await body(request)), 201); return; }
    const route = conversationRoute(path, method);
    if (route) {
      if (await proxyConversation(app, request, response, url, route, token!)) return;
      await handleConversation(app, request, response, url, route, () => app.streamAuthenticated(token)); return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      EmptySchema.parse(await body(request)); await app.auth.logout(token); response.setHeader('Set-Cookie', clearSessionCookie(secureCookies)); send(await app.auth.state(undefined)); return;
    }
    if (path === '/hub/config' && method === 'GET') { send(await app.configuration()); return; }
    if (path === '/hub/config' && method === 'PUT') {
      const input = ConfigWriteSchema.parse(await body(request));
      retryable = input.clientRequestId !== undefined;
      if (app.redactor.text(JSON.stringify(input.configuration)) !== JSON.stringify(input.configuration)) throw failure('Store credentials in their Settings fields, not in configuration.', 400);
      const revision = await app.state.configuration.put(input);
      await app.configuration(); await app.applyRigging(); send(revision); return;
    }
    if (path === '/hub/config/history' && method === 'GET') { send({ schema: 'config-history-v1', revisions: await app.state.configuration.history() }); return; }
    if (path === '/hub/config/export' && method === 'GET') {
      const revision = await app.configuration(); response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="apm.yml"', 'Cache-Control': 'no-store' }); response.end(app.redactor.text(exportConfiguration(revision.configuration))); return;
    }
    if (path === '/hub/config/import-preview' && method === 'POST') {
      const input = ImportSchema.parse(await body(request)); const proposed = parseConfiguration(input.yaml); const current = await app.configuration();
      if (app.redactor.text(JSON.stringify(proposed)) !== JSON.stringify(proposed)) throw failure('Remove credentials from this configuration before importing it.', 400);
      send({ schema: 'config-preview-v1', revision: current.revision, configuration: proposed, before: exportConfiguration(current.configuration), after: exportConfiguration(proposed), changedPaths: changedPaths(current.configuration, proposed) }); return;
    }
    if (path === '/api/runtimes' && method === 'GET') {
      const config = (await app.configuration()).configuration['x-jevellan'];
      send(RuntimeListSchema.parse({ schema: 'runtimes-list-v1', runtimes: [...app.runtimes.values()].map((runtime) => ({ id: runtime.id, displayName: runtime.displayName, enabled: config.runtimes[runtime.id]?.enabled === true, accountKinds: runtime.accountKinds, riggingKinds: runtime.riggingKinds, capabilities: runtime.capabilities })), offered: (await app.accounts.offered()) })); return;
    }
    if (path === '/hub/accounts' && method === 'GET') { send(AccountListSchema.parse({ schema: 'accounts-list-v1', accounts: (await app.accounts.list()) })); return; }
    if (path === '/hub/accounts' && method === 'POST') {
      const input = AddAccountSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined;
      const view = (await app.accounts.add(input));
      await app.applyRigging();
      if (view.account.secretRef) { await app.accounts.check(view.account.id); if ((await app.accounts.status(view.account.id)).auth === 'ready') await app.accounts.discover(view.account.id).catch(() => undefined); }
      send((await app.accounts.get(view.account.id)), 201); return;
    }
    const account = path.match(/^\/hub\/accounts\/([A-Za-z0-9_-]+)(\/credential)?$/);
    if (account) {
      const id = IdSchema.parse(account[1]);
      if (method === 'GET' && !account[2]) { send((await app.accounts.get(id))); return; }
      if (method === 'PATCH' && !account[2]) { const input = UpdateAccountSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; send(await app.accounts.update(id, input)); return; }
      if (method === 'PUT' && account[2]) { const input = ReplaceCredentialSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; send(await app.accounts.replaceCredential(id, input)); return; }
    }
    const action = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/(check|models)$/);
    if (action && method === 'POST') {
      const id = IdSchema.parse(action[1]); const input = await body(request);
      EmptySchema.parse(input); retryable = true;
      if (action[2] === 'models') send(await app.accounts.discover(id));
      else { const status = await app.accounts.check(id); if (status.auth === 'ready') await app.accounts.discover(id).catch(() => undefined); send((await app.accounts.get(id))); }
      return;
    }
    if (path === '/api/rigging/homes' && method === 'GET') { send(app.riggingDisk.list((await app.accounts.list()).map((view) => view.account))); return; }
    const promotion = path.match(/^\/api\/rigging\/homes\/(claude|codex)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/promote$/);
    if (promotion) {
      retryable = true; // Promotion has a durable request receipt; cancellation is entirely local after admission.
      const runtime = promotion[1] as 'claude' | 'codex'; const accountId = IdSchema.parse(promotion[2]); const id = IdSchema.parse(promotion[3]);
      if ((await app.accounts.get(accountId)).account.runtime !== runtime) throw Object.assign(new Error('Account does not belong to this runtime.'), { status: 404 });
      if (method === 'POST') { const item = await app.riggingDisk.promote(runtime, accountId, id, await body(request), app.rigging); send({ schema: 'rigging-save-v1', item, application: await app.applyRigging() }); return; }
      if (method === 'PATCH') { send(await app.riggingDisk.cancelPromotion(runtime, accountId, id, await body(request))); return; }
    }
    const diskItem = path.match(/^\/api\/rigging\/homes\/(claude|codex)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (diskItem) {
      retryable = true; // Only account admission needs the hub; these file operations use local authority.
      const runtime = diskItem[1] as 'claude' | 'codex'; const accountId = IdSchema.parse(diskItem[2]); const id = IdSchema.parse(diskItem[3]);
      if (!(await app.accounts.list()).some((view) => view.account.id === accountId && view.account.runtime === runtime)) throw failure('Account not found.', 404);
      if (method === 'GET') { send(app.riggingDisk.detail(runtime, accountId, id)); return; }
      if (method === 'PUT') { send(await app.riggingDisk.edit(runtime, accountId, id, await body(request))); return; }
      if (method === 'POST') { send(await app.riggingDisk.transition(runtime, accountId, id, await body(request))); return; }
      if (method === 'PATCH') { send(await app.riggingDisk.cancel(runtime, accountId, id, await body(request))); return; }
    }
    if (path === '/hub/rigging' && method === 'GET') { send(RiggingListSchema.parse({ schema: 'rigging-list-v1', items: (await app.rigging.list()), application: app.riggingApplication() })); return; }
    if (path === '/hub/rigging' && method === 'POST') { const input = AddRiggingSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; const item = await app.rigging.add(input); send({ schema: 'rigging-save-v1', item, application: await app.applyRigging() }, 201); return; }
    const rigging = path.match(/^\/hub\/rigging\/([A-Za-z0-9_-]+)$/);
    if (rigging && method === 'PUT') { const input = UpdateRiggingSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; const item = await app.rigging.update(IdSchema.parse(rigging[1]), input); send({ schema: 'rigging-save-v1', item, application: await app.applyRigging() }); return; }
    if (path === '/api/rigging/apply' && method === 'POST') { EmptySchema.parse(await body(request)); retryable = true; send(await app.applyRigging()); return; }
    if (path === '/hub/secrets/jev' && method === 'PUT') { const input = SecretInputSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; send(SecretSummarySchema.parse(await app.state.jev.put(input.value, input.clientRequestId))); return; }
    if (path === '/hub/overrides' && method === 'GET') {
      const input = CorrectionsReadSchema.parse({ schema: 'corrections-read-v1', ids: url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [] });
      send(CorrectionsListSchema.parse({ schema: 'corrections-list-v1', records: await app.conversations.corrections([...new Set(input.ids)]) })); return;
    }
    if (path === '/api/decisions/check' && method === 'POST') { EmptySchema.parse(await body(request)); retryable = true; send(await app.checkJev()); return; }
    if (path === '/hub/secrets/jev' && method === 'GET') {
      send(await app.state.jev.summary());
      return;
    }
    if (path === '/hub/devices' && method === 'GET') { send({ schema: 'devices-list-v1', currentDeviceId: app.device.deviceId, devices: (await app.roster()).devices.map((row) => row.device) }); return; }
    throw failure('Not found.', 404);
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 400;
    send(ErrorDocumentSchema.parse({ schema: 'error-v1', code: error instanceof HubUnavailable ? 'hub-unavailable' : status === 409 ? 'conflict' : status === 401 ? 'unauthenticated' : status === 404 ? 'not-found' : 'request-failed', ...(error instanceof HubUnavailable ? { retryable } : {}), message: error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.redactor.text(candidate.message) : 'The request could not complete.' }), status);
  } finally { release?.(); }
}
