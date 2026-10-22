import {handleFirstRunApi} from './first-run-api.js';
import { handleNativeViewerTitlePeer } from './native-viewer-title.js';
import { handleConversationStartPeer } from './conversation-start-peer.js';
import { ProjectSetupReadRequestSchema } from '@jevellan/core';
import { waitProjectSetupView } from './project-setup-wait.js';
import { readConversationCreationDraft } from './conversation-creation-draft.js';
import { ConversationNewSourceRequestSchema } from '@jevellan/core';
import { readConversationNewSource, readConversationNewView } from './conversation-new-view.js';
import { ownerConversationSidebarDrop, ownerConversationSidebarRename } from './conversation-sidebar-actions.js';
import { ConversationSidebarRequestSchema } from '@jevellan/core';
import { ownerConversationSidebar } from './conversation-sidebar-view.js';
import { ekoaEditor, prepareEkoaEditorSave, prepareEkoaEditorConnect, EkoaEditorPreviewSchema, EkoaEditorSaveSchema, EkoaEditorConnectSchema } from '@jevellan/core';
import { CleanupSettingsSaveSchema } from '@jevellan/core';
import { handleProjectDefinitionsPeer } from './project-definition-device.js';
import { handleNativeConnectionsPeer } from './native-connection-device.js';
import { GlobalThreadLimitSaveSchema, ProjectDefinitionReadSchema, ProjectDefinitionPreviewSchema, ProjectDefinitionSaveSchema } from '@jevellan/core';
import { AccountEditorReadSchema, AccountEditorSaveSchema } from '@jevellan/core';
import { RuntimeSettingsSaveSchema } from '@jevellan/core';
import { environmentSecretSummary } from '@jevellan/projects';
import { EkoaOAuthStartSchema, EkoaOAuthCallbackSchema } from '@jevellan/core';
import { DEVICE_CLEANUP_ROUTE, handleDeviceCleanup } from './device-cleanup-api.js';
import { ProjectEnvImportRequestSchema } from '@jevellan/core';
import { healthRefusal } from '@jevellan/core';
import { handleLibrary } from './library-api.js';
import { handleNotificationsApi } from './notifications-api.js';
import { ProjectEnvNameSchema } from '@jevellan/core';
import { EkoaSettingsInputSchema, EmptySchema as EkoaEmptySchema } from '@jevellan/core';
import { handleSessionListApi } from './session-list-api.js';
import { handleGitApi } from './git-api.js';
import { handleProjectWorkApi, handleProjectWorkPeer } from './project-work-api.js';
import { handleCursorApi } from './cursor-api.js';
import { projectFolders } from './project-folders.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { CorrectionsListSchema, CorrectionsReadSchema, ErrorDocumentSchema, GitHubTokenStateSchema, IdSchema, ProjectWriteSchema, SecretSummarySchema, EmptySchema, ConfigWriteSchema, SecretInputSchema, AccountListSchema, RiggingListSchema, CONFIGURATION_EXPORT_FILENAME } from '@jevellan/core';
import { HubUnavailable, clearSessionCookie, sessionCookie, sessionFromCookie, deviceAboutView } from '@jevellan/mesh';
import { AddAccountSchema, AddRiggingSchema, ReplaceCredentialSchema, UpdateAccountSchema, UpdateRiggingSchema } from '@jevellan/core';
import { Application } from './application.js';
import { conversationRoute, handleConversation } from './conversation-api.js';
import { handleOwnerRequest, proxyConversation } from './owner-proxy.js';
import { json, requestBody as body } from './http.js';
import { PROJECT_HUB_ROUTE, handleMeshDeviceApi, handleMeshUiApi } from './mesh-api.js';
import { handleLoginApi } from './login-api.js';
import { ImproverRequestSchema } from '@jevellan/core';
import { DecisionsSettingsPreviewSchema, DecisionsSettingsSaveSchema } from '@jevellan/core';
import { handleAgentAccessApi } from './agent-access-api.js';
import { handleAgentPeer } from './agent-mcp-api.js';
import { DEVICE_WORKTREES_ROUTE, handleDeviceWorktrees } from './device-worktrees-api.js';
import { handleTerminalApi, handleTerminalPeer } from './terminal-api.js';
import { ConversationListReadRequestSchema } from '@jevellan/core';
import { conversationListSource } from './conversation-list-source.js';

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
  if (!['GET', 'HEAD'].includes(request.method ?? '') || request.headers.upgrade?.toLowerCase() === 'websocket') {
    // Browser mutations always send Origin. JSON requests without it are local CLI clients.
    if (request.headers.origin && request.headers.origin !== origin) throw failure('Open Jevellan directly before changing settings.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw failure('Open Jevellan directly before changing settings.', 403);
  }
  return secure;
}

export async function handleApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, options: { allowedOrigins?: readonly string[]; secureCookies?: boolean; proxyOrigin?: string } = {}): Promise<void> {
  const send = (value: unknown, status = 200) => json(response, app.redactor.document(value), status);
  let retryable = false;
  let release: (() => void) | undefined;
  try {
    const secureRequest = requireOrigin(request, options.allowedOrigins ?? [], options.proxyOrigin);
    const secureCookies = options.secureCookies ?? secureRequest;
    const path = url.pathname; const method = request.method ?? 'GET'; const token = sessionFromCookie(request.headers.cookie);
    // Project hub requests enter the gate in their route once the operation is known: reads are admitted like GET (D247).
    if (!['GET', 'HEAD'].includes(method) && !PROJECT_HUB_ROUTE.test(path) && !DEVICE_WORKTREES_ROUTE.test(path) && !DEVICE_CLEANUP_ROUTE.test(path) && path !== '/hub/mesh/agent-access' && path !== '/api/agent-peer') release = app.lifecycle.enter({ kind: 'request' });
    if (path === '/api/mesh/conversation-start') { await handleConversationStartPeer(app, request, response); return; }
    if (path === '/api/mesh/project-definitions') { await handleProjectDefinitionsPeer(app, request, response); return; }
    if (path === '/api/mesh/native-viewer-title') { await handleNativeViewerTitlePeer(app, request, response); return; }
    if (path === '/api/mesh/native-connections') { await handleNativeConnectionsPeer(app, request, response); return; }
    if (path.startsWith('/api/mesh/devices/') && await handleDeviceCleanup(app, request, response, url)) return;
    if (path.startsWith('/api/mesh/devices/') && await handleDeviceWorktrees(app, request, response, url)) return;
    if (path === '/api/agent-peer') { await handleAgentPeer(app, request, response); return; }
    if (await handleOwnerRequest(app, request, response, url)) return;
    if (await handleTerminalPeer(app, request, response, url)) return;
    if (path.startsWith('/api/mesh/projects/') && await handleProjectWorkPeer(app, request, response, url, () => { retryable = true; })) return;
    if (path.startsWith('/api/mesh/cursor') && await handleCursorApi(app, request, response, url)) return;
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
    if (/^\/api\/projects\/[A-Za-z0-9_-]+\/library(?:\/|$)/u.test(path)) { retryable = method === 'GET' || method === 'DELETE'; if (await handleLibrary(app, request, response, url, token!)) return; }
    if (path.startsWith('/api/notifications/')) {
      retryable = method === 'GET' || method === 'DELETE' || path === '/api/notifications/subscriptions';
      if (await handleNotificationsApi(app, request, response, url, token!)) return;
    }
    if (path.startsWith('/api/setup/')) { retryable = true; if (await handleFirstRunApi(app, request, response, url)) return; }
    if (await handleTerminalApi(app, request, response, url, token!)) return;
    if (await handleDeviceCleanup(app, request, response, url, token)) return;
    if (await handleDeviceWorktrees(app, request, response, url, token)) return;
    retryable = method === 'GET' && !path.startsWith('/api/logins/');
    if (method === 'POST' && ['/hub/devices/invitations', '/api/devices/switch'].includes(path)) retryable = true;
    if (await handleMeshUiApi(app, request, response, url, secureCookies, token)) return;
    if (path === '/api/agent-access' || /^\/api\/agent-access\/[A-Za-z0-9_-]+\/revoke$/.test(path)) retryable = true;
    if (await handleAgentAccessApi(app, request, response, url, token!)) return;
    if (await handleLoginApi(app, request, response, url, token)) return;
    if (path === '/api/improver' && method === 'GET') { send(await app.improverRequest({ schema: 'improver-request-v1', operation: 'state' })); return; }
    if (path === '/api/improver' && method === 'POST') {
      const input = ImproverRequestSchema.parse(await body(request)); retryable = true; send(await app.improverRequest(input)); return;
    }
    if (path === '/hub/ekoa/editor' && method === 'GET') { send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'state' }, token!))); return; }
    if (path === '/hub/ekoa/editor/preview' && method === 'POST') { const input = EkoaEditorPreviewSchema.parse(await body(request)); send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'state' }, token!), input)); return; }
    if (path === '/hub/ekoa/editor' && method === 'PUT') { const input = EkoaEditorSaveSchema.parse(await body(request)); retryable = true; send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'save', input: prepareEkoaEditorSave(input) }, token!))); return; }
    if (path === '/hub/ekoa/editor/connect' && method === 'POST') { const input = EkoaEditorConnectSchema.parse(await body(request)); send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'oauth-start', input: prepareEkoaEditorConnect(input) }, token!))); return; }
    if (path === '/hub/ekoa/editor/callback' && method === 'POST') { const input = EkoaOAuthCallbackSchema.parse(await body(request)); send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'oauth-complete', input }, token!))); return; }
    if (path === '/hub/ekoa/editor/test' && method === 'POST') { EkoaEmptySchema.parse(await body(request)); send(ekoaEditor(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'test' }, token!))); return; }
    if (path === '/hub/ekoa' && method === 'GET') { send(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'state' }, token!)); return; }
    if (path === '/hub/ekoa' && method === 'PUT') { send(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'save', input: EkoaSettingsInputSchema.parse(await body(request)) }, token!)); return; }
    if (path === '/hub/ekoa/connect' && method === 'POST') { send(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'oauth-start', input: EkoaOAuthStartSchema.parse(await body(request)) }, token!)); return; }
    if (path === '/hub/ekoa/callback' && method === 'POST') { send(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'oauth-complete', input: EkoaOAuthCallbackSchema.parse(await body(request)) }, token!)); return; }
    if (path === '/hub/ekoa/test' && method === 'POST') { EkoaEmptySchema.parse(await body(request)); send(await app.ekoaRequest({ schema: 'ekoa-request-v1', operation: 'test' }, token!)); return; }
    if (await handleGitApi(app, request, response, url)) return;
    if (path === '/api/config/workspace' && method === 'GET') { send(await app.settingsWorkspace()); return; }
    if (path === '/api/config/cleanup' && method === 'GET') { send(await app.cleanupSettingsEditor()); return; }
    if (path === '/api/config/cleanup' && method === 'PUT') { const input = CleanupSettingsSaveSchema.parse(await body(request)); retryable = true; send(await app.saveCleanupSettings(input)); return; }
    if (path === '/api/config/limits' && method === 'GET') { send(await app.globalThreadLimitEditor()); return; }
    if (path === '/api/config/limits' && method === 'PUT') { const input = GlobalThreadLimitSaveSchema.parse(await body(request)); retryable = true; send(await app.saveGlobalThreadLimit(input)); return; }
    if (path === '/api/projects/view' && method === 'GET') { send(await app.projectDefinitions()); return; }
    if (path === '/api/projects/editor' && method === 'GET') { send(await app.projectDefinitionRead(ProjectDefinitionReadSchema.parse({ schema: 'project-definition-read-v1', ...(url.searchParams.has('projectId') ? { projectId: url.searchParams.get('projectId') } : {}) }))); return; }
    if (path === '/api/projects/editor/preview' && method === 'POST') { retryable = true; send(await app.projectDefinitionPreview(ProjectDefinitionPreviewSchema.parse(await body(request)))); return; }
    if (await handleProjectWorkApi(app, request, response, url, token!, () => { retryable = true; })) return;
    const sharedMemory = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/memory\/shared$/);
    if (sharedMemory && (method === 'GET' || method === 'POST')) {
      retryable = true;
      send(await app.ownerProjectMemory({ schema: 'project-memory-request-v1', projectId: sharedMemory[1], ...(method === 'GET' ? { operation: 'view' } : (await body(request) as object)) }, token!)); return;
    }
    if (await handleSessionListApi(app, request, response, url)) return;
    if (await handleCursorApi(app, request, response, url, token)) return;
    if (path === '/api/project-folders' && method === 'GET') { send(await projectFolders(app.homes.userHome, url.searchParams.get('path') ?? undefined)); return; }
    // Phase 5: the hub's vault, and restoring a project's work from its vault folder.
    if (path === '/api/vault' && method === 'GET') { send(app.vaultView()); return; }
    const vaultRestore = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/vault-restore$/);
    if (vaultRestore && method === 'POST') { retryable = true; send(await app.restoreProjectFromVault(IdSchema.parse(vaultRestore[1]))); return; }
    if (path === '/hub/projects' && method === 'GET') { await app.conversations.ready; send((await app.conversations.projects())); return; }
    if (path === '/hub/projects' && method === 'PUT') {
      const input = z.union([ProjectWriteSchema, ProjectDefinitionSaveSchema]).parse(await body(request)); retryable = input.clientRequestId !== undefined;
      send(input.schema === 'project-definition-save-v1' ? await app.saveProjectDefinition(input) : await app.conversations.saveProject(input)); return;
    }
    const visibility = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/visibility$/);
    if (visibility && method === 'GET') {
      await app.conversations.ready;
      const project = (await app.conversations.projects()).projects.find((row) => row.project.id === IdSchema.parse(visibility[1]))?.project;
      if (!project) throw failure('Project not found.', 404);
      send(await app.projectVisibility.inspect(project, app.device.deviceId)); return;
    }
    const setupRead = path.match(/^\/api\/projects\/([A-Za-z0-9_-]+)\/setup-(view|wait)$/);
    if (setupRead) {
      ProjectSetupReadRequestSchema.parse({ schema: 'project-setup-read-request-v1', ...Object.fromEntries(url.searchParams) });
      const id = IdSchema.parse(setupRead[1]);
      if (setupRead[2] === 'view') { if (method !== 'GET') throw failure('This setup view does not support that method.', 405); send(await app.projectSetupView(id)); }
      else { if (method !== 'POST') throw failure('This setup wait does not support that method.', 405); send(await waitProjectSetupView(app, id, app.device.deviceId, await body(request))); }
      return;
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
        // First use includes isolated provider startup and foreground sync; each native tool still has its own 30-second limit.
        const controller = new AbortController(); const disconnected = () => controller.abort();
        response.once('close', disconnected); if (response.destroyed) disconnected();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        try {
          const memory = await app.conversations.memory(id); signal.throwIfAborted(); const permalink = url.searchParams.get('permalink');
          if (permalink) send(await memory.read(permalink, signal));
          else { const query = url.searchParams.get('query'); if (!query?.trim()) throw new Error('Enter a memory search.'); send(await memory.search(query, signal)); }
        } finally { response.off('close', disconnected); }
      }
      return;
    }
    if (path === '/api/conversation-composer' && method === 'POST') { send(await app.conversations.composerDraft(await body(request))); return; }
    if (path === '/api/conversation-new/start') {
      if (method !== 'POST') throw failure('This creation write does not support that method.', 405);
      send(await app.startConversation(await body(request), undefined, token)); return;
    }
    if (path === '/api/conversation-new/draft') {
      if (method !== 'POST') throw failure('This creation draft read does not support that method.', 405);
      send(await readConversationCreationDraft(app, await body(request))); return;
    }
    if (path === '/api/conversation-new/source' || path === '/api/conversation-new/view') {
      ConversationNewSourceRequestSchema.parse({ schema: 'conversation-new-source-request-v1', ...Object.fromEntries(url.searchParams) });
      if (path.endsWith('/source')) {
        if (method !== 'GET') throw failure('This composer source read does not support that method.', 405);
        send(await readConversationNewSource(app));
      } else {
        if (method !== 'POST') throw failure('This composer view does not support that method.', 405);
        send(await readConversationNewView(app, await body(request)));
      }
      return;
    }
    if (path === '/api/conversation-list/order' || path === '/api/conversation-list/rename') {
      if (method !== 'POST') throw failure('This sidebar change does not support that method.', 405);
      const input = await body(request);
      send(path.endsWith('/order') ? await ownerConversationSidebarDrop(app, input, token) : await ownerConversationSidebarRename(app, input, token)); return;
    }
    if (path === '/api/conversation-list/sidebar') {
      if (method !== 'GET') throw failure('This sidebar read does not support that method.', 405);
      const query = Object.fromEntries(url.searchParams);
      const parsed = ConversationSidebarRequestSchema.parse({ schema: 'conversation-sidebar-request-v1', ...query,
        ...(query.shells === undefined ? {} : { shells: query.shells === 'true' ? true : query.shells === 'false' ? false : query.shells }) });
      send(await ownerConversationSidebar(app, parsed, token)); return;
    }
    if (path === '/api/conversation-list/view') {
      if (method !== 'GET') throw failure('This conversation list operation does not support that method.', 405);
      ConversationListReadRequestSchema.parse({ schema: 'conversation-list-read-request-v1', ...Object.fromEntries(url.searchParams) });
      send(await conversationListSource(app)); return;
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
    if (path === '/api/config/about' && method === 'GET') { send(deviceAboutView(await app.roster(), app.device.deviceId)); return; }
    if (['/api/config/decisions', '/api/jev/menu-candidates', '/api/jev/effort-guide'].includes(path) && method === 'GET') { send(await app.state.configuration.decisionsEditor()); return; }
    if (['/api/config/decisions/preview', '/api/jev/menu', '/api/jev/effort-guide/reset'].includes(path) && method === 'POST') {
      const input = DecisionsSettingsPreviewSchema.parse(await body(request)); retryable = true;
      if (path === '/api/jev/menu' && input.command?.kind !== 'add-model' || path === '/api/jev/effort-guide/reset' && input.command?.kind !== 'reset-effort-guide') throw failure('Choose the matching decisions editor action.', 400);
      send(await app.state.configuration.decisionsEditor(input)); return;
    }
    if (path === '/api/config/decisions' && method === 'PUT') {
      const input = DecisionsSettingsSaveSchema.parse(await body(request)); retryable = true;
      send(await app.saveDecisionsSettings(input)); return;
    }
    if (path === '/api/jev/connection' && method === 'GET') { send(await app.state.jev.connection()); return; }
    if (path === '/api/config/editor' && method === 'GET') { send(await app.configurationEditor()); return; }
    if (path === '/api/config/yaml' && method === 'GET') { send(await app.configurationYaml()); return; }
    if (path === '/api/config/import-preview' && method === 'POST') { send(await app.configurationImportPreview(await body(request))); return; }
    if (path === '/hub/config' && method === 'PUT') {
      const input = ConfigWriteSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined;
      send(await app.writeConfiguration(input)); return;
    }
    if (path === '/hub/config/history' && method === 'GET') { send({ schema: 'config-history-v1', revisions: await app.state.configuration.history() }); return; }
    if (path === '/hub/config/export' && method === 'GET') {
      const view = await app.configurationYaml(); response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': `attachment; filename="${CONFIGURATION_EXPORT_FILENAME}"`, 'Cache-Control': 'no-store' }); response.end(view.yaml); return;
    }
    if (path === '/hub/config/import-preview' && method === 'POST') { send((await app.configurationImportPreview(await body(request))).preview); return; }
    if (path === '/api/runtimes' && method === 'GET') { send(await app.runtimeList()); return; }
    if (path === '/api/config/runtimes' && method === 'GET') { send(await app.runtimeSettings()); return; }
    if (path === '/api/config/runtimes' && method === 'PUT') { const input = RuntimeSettingsSaveSchema.parse(await body(request)); retryable = true; send(await app.saveRuntimeSettings(input)); return; }
    if (path === '/api/accounts/editor' && method === 'GET') {
      const input = AccountEditorReadSchema.parse({ schema: 'account-editor-read-v1', runtime: url.searchParams.get('runtime'), ...(url.searchParams.has('accountId') ? { accountId: url.searchParams.get('accountId') } : {}), ...(url.searchParams.has('mode') ? { mode: url.searchParams.get('mode') } : {}) });
      send(await app.accountEditorRead(input)); return;
    }
    if (path === '/api/accounts/editor/preview' && method === 'POST') { send(await app.accountEditorPreview(await body(request))); return; }
    if (path === '/api/accounts/editor/save' && method === 'POST') { const input = AccountEditorSaveSchema.parse(await body(request)); retryable = true; send(await app.accountEditorSave(input), input.context.mode === 'create' ? 201 : 200); return; }
    if (path === '/api/accounts/view' && method === 'GET') { send(await app.accountsSettings()); return; }
    if (path === '/hub/accounts' && method === 'GET') { send(AccountListSchema.parse({ schema: 'accounts-list-v1', accounts: (await app.accounts.list()) })); return; }
    if (path === '/hub/accounts' && method === 'POST') {
      const input = AddAccountSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined;
      send(await app.createAccount(input), 201); return;
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
    const environmentImport = /^\/api\/projects\/([A-Za-z0-9_-]+)\/env-secrets\/([A-Z_][A-Z0-9_]{0,63})\/import$/u.exec(path);
    if (environmentImport && method === 'POST') {
      const input = ProjectEnvImportRequestSchema.parse(await body(request));
      send(await app.state.environment.copy(IdSchema.parse(environmentImport[1]), ProjectEnvNameSchema.parse(environmentImport[2]), input.source)); return;
    }
    const environmentSecret = /^\/api\/projects\/([A-Za-z0-9_-]+)\/env-secrets\/([A-Z_][A-Z0-9_]{0,63})$/u.exec(path);
    if (environmentSecret) {
      const projectId = IdSchema.parse(environmentSecret[1]), name = ProjectEnvNameSchema.parse(environmentSecret[2]); retryable = true;
      if (method === 'GET') { send(environmentSecretSummary(await app.state.environment.summary(projectId, name))); return; }
      if (method === 'PUT') { const input = SecretInputSchema.parse(await body(request)); send(environmentSecretSummary(await app.state.environment.put(projectId, name, input.value))); return; }
      if (method === 'DELETE') { EmptySchema.parse(await body(request)); send(environmentSecretSummary(await app.state.environment.remove(projectId, name))); return; }
    }
    if (path === '/hub/secrets/github') {
      const projectId = url.searchParams.has('projectId') ? IdSchema.parse(url.searchParams.get('projectId')) : undefined;
      // Summary only, never the token (D57). Removing twice leaves the same state, so a removal may wait for the hub.
      if (method === 'GET') { send(GitHubTokenStateSchema.parse(await app.state.github.summary(projectId))); return; }
      if (method === 'PUT') { const input = SecretInputSchema.parse(await body(request)); retryable = input.clientRequestId !== undefined; send(GitHubTokenStateSchema.parse(await app.state.github.put(input.value, input.clientRequestId, projectId))); return; }
      if (method === 'DELETE') { EmptySchema.parse(await body(request)); retryable = true; send(GitHubTokenStateSchema.parse(await app.state.github.remove(undefined, projectId))); return; }
    }
    if (path === '/hub/devices' && method === 'GET') { send({ schema: 'devices-list-v1', currentDeviceId: app.device.deviceId, devices: (await app.roster()).devices.map((row) => row.device) }); return; }
    throw failure('Not found.', 404);
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 400;
    send(ErrorDocumentSchema.parse({ schema: 'error-v1', code: error instanceof HubUnavailable ? 'hub-unavailable' : status === 409 ? 'conflict' : status === 401 ? 'unauthenticated' : status === 404 ? 'not-found' : 'request-failed', ...(error instanceof HubUnavailable ? { retryable } : {}), message: healthRefusal(error) ?? (error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.redactor.text(candidate.message) : 'The request could not complete.') }), status);
  } finally { release?.(); }
}
