import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ConfigurationSchema, DeviceSchema, ErrorDocumentSchema, IdSchema, RiggingViewSchema, SecretSummarySchema, exportConfiguration, parseConfiguration, stableJson } from '@jevellan/core';
import { AccountViewSchema, OfferedModelsSchema } from '@jevellan/accounts';
import { clearSessionCookie, sessionCookie, sessionFromCookie } from '@jevellan/mesh';
import { Application, RiggingApplicationSchema } from './application.js';

const EmptySchema = z.strictObject({ schema: z.literal('empty-request-v1') });
const ConfigWriteSchema = z.strictObject({ schema: z.literal('config-write-v1'), revision: z.number().int().nonnegative(), configuration: ConfigurationSchema });
const ImportSchema = z.strictObject({ schema: z.literal('config-import-v1'), yaml: z.string().max(1024 * 1024) });
const LoginCodeSchema = z.strictObject({ schema: z.literal('login-code-v1'), code: z.string().min(1).max(16_384) });
const SecretInputSchema = z.strictObject({ schema: z.literal('save-secret-v1'), value: z.string().min(1).max(65_536) });
const AccountListSchema = z.strictObject({ schema: z.literal('accounts-list-v1'), accounts: z.array(AccountViewSchema) });
const RiggingListSchema = z.strictObject({ schema: z.literal('rigging-list-v1'), items: z.array(RiggingViewSchema), application: RiggingApplicationSchema.nullable() });
const CapabilitiesSchema = z.strictObject({ edit: z.boolean(), shell: z.boolean(), mcp: z.boolean(), images: z.boolean(), interrupt: z.boolean(), usage: z.boolean(), continueSession: z.boolean(), perLaunchConfig: z.boolean(), readOnlyEnforced: z.boolean() });
const RuntimeListSchema = z.strictObject({ schema: z.literal('runtimes-list-v1'), runtimes: z.array(z.strictObject({ id: IdSchema, displayName: z.string(), enabled: z.boolean(), accountKinds: z.array(z.enum(['subscription', 'api-key'])), riggingKinds: z.array(z.enum(['skill', 'mcp', 'hook', 'rule', 'setting', 'command'])), capabilities: CapabilitiesSchema })), offered: z.array(OfferedModelsSchema) });

export function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value));
}
function failure(message: string, status: number) { return Object.assign(new Error(message), { status }); }
function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return Promise.reject(failure('Send this request as JSON.', 415));
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return Promise.reject(failure('Compressed request bodies are not supported.', 415));
  const limit = 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = []; let settled = false;
    const refuse = (error: Error) => { if (!settled) { settled = true; chunks.length = 0; reject(error); } };
    request.on('data', (chunk: Buffer) => {
      if (settled) return; size += chunk.length;
      if (size > limit) refuse(failure('This request is too large.', 413)); else chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); settled = true; resolve(value); }
      catch { refuse(failure('Invalid JSON request.', 400)); }
    });
    request.on('error', () => refuse(failure('The request was interrupted.', 400)));
    request.on('aborted', () => refuse(failure('The request was interrupted.', 400)));
  });
}
export function requireOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): void {
  const host = request.headers.host;
  if (!host || host.includes('@') || host.includes('/') || host.includes('\\')) throw failure('Unknown request host.', 403);
  const secure = 'encrypted' in request.socket && request.socket.encrypted;
  const origin = `${secure ? 'https' : 'http'}://${host}`;
  const local = new URL(origin);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname) && Number(local.port || (secure ? 443 : 80)) === request.socket.localPort;
  if (!isLocal && !allowedOrigins.includes(origin)) throw failure('Unknown request host.', 403);
  if (!['GET', 'HEAD'].includes(request.method ?? '')) {
    // Browser mutations always send Origin. JSON requests without it are local CLI clients.
    if (request.headers.origin && request.headers.origin !== origin) throw failure('Open Jevellan directly before changing settings.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw failure('Open Jevellan directly before changing settings.', 403);
  }
}
function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (stableJson(before) === stableJson(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>; const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((key) => changedPaths(a[key], b[key], `${path}/${key}`));
  }
  return [path || '/'];
}

export async function handleApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, options: { allowedOrigins?: readonly string[]; secureCookies?: boolean } = {}): Promise<void> {
  const send = (value: unknown, status = 200) => json(response, app.hub.redactor.document(value), status);
  try {
    requireOrigin(request, options.allowedOrigins ?? []);
    const path = url.pathname; const method = request.method ?? 'GET'; const token = sessionFromCookie(request.headers.cookie);
    if (path === '/api/auth' && method === 'GET') { send(app.auth.state(token)); return; }
    if (['/api/auth/setup', '/api/auth/login'].includes(path) && method === 'POST') {
      const input = await body(request);
      const session = path.endsWith('/setup') ? await app.auth.setup(input) : await app.auth.login(input, request.socket.remoteAddress ?? 'unknown');
      response.setHeader('Set-Cookie', sessionCookie(session, options.secureCookies)); send(app.auth.state(session)); return;
    }
    if (!app.auth.verify(token)) throw failure('Sign in to Jevellan.', 401);
    if (path === '/api/auth/logout' && method === 'POST') {
      EmptySchema.parse(await body(request)); app.auth.logout(token); response.setHeader('Set-Cookie', clearSessionCookie(options.secureCookies)); send(app.auth.state(undefined)); return;
    }
    if (path === '/hub/config' && method === 'GET') { send(app.hub.configuration.current()); return; }
    if (path === '/hub/config' && method === 'PUT') {
      const input = ConfigWriteSchema.parse(await body(request));
      if (app.hub.redactor.text(JSON.stringify(input.configuration)) !== JSON.stringify(input.configuration)) throw failure('Store credentials in their Settings fields, not in configuration.', 400);
      const revision = app.hub.configuration.put(input.configuration, input.revision, { deviceId: app.device.deviceId, source: 'ui' });
      app.hub.configuration.materialise(app.homes); await app.applyRigging(); send(revision); return;
    }
    if (path === '/hub/config/history' && method === 'GET') { send({ schema: 'config-history-v1', revisions: app.hub.configuration.history() }); return; }
    if (path === '/hub/config/export' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Content-Disposition': 'attachment; filename="apm.yml"', 'Cache-Control': 'no-store' }); response.end(app.hub.redactor.text(exportConfiguration(app.hub.configuration.current()!.configuration))); return;
    }
    if (path === '/hub/config/import-preview' && method === 'POST') {
      const input = ImportSchema.parse(await body(request)); const proposed = parseConfiguration(input.yaml); const current = app.hub.configuration.current()!;
      if (app.hub.redactor.text(JSON.stringify(proposed)) !== JSON.stringify(proposed)) throw failure('Remove credentials from this configuration before importing it.', 400);
      send({ schema: 'config-preview-v1', revision: current.revision, configuration: proposed, before: exportConfiguration(current.configuration), after: exportConfiguration(proposed), changedPaths: changedPaths(current.configuration, proposed) }); return;
    }
    if (path === '/api/runtimes' && method === 'GET') {
      const config = app.hub.configuration.current()!.configuration['x-jevellan'];
      send(RuntimeListSchema.parse({ schema: 'runtimes-list-v1', runtimes: [...app.runtimes.values()].map((runtime) => ({ id: runtime.id, displayName: runtime.displayName, enabled: config.runtimes[runtime.id]?.enabled === true, accountKinds: runtime.accountKinds, riggingKinds: runtime.riggingKinds, capabilities: runtime.capabilities })), offered: app.accounts.offered() })); return;
    }
    if (path === '/hub/accounts' && method === 'GET') { send(AccountListSchema.parse({ schema: 'accounts-list-v1', accounts: app.accounts.list() })); return; }
    if (path === '/hub/accounts' && method === 'POST') {
      const view = app.accounts.add(await body(request));
      await app.applyRigging();
      if (view.account.secretRef) { await app.accounts.check(view.account.id); if (app.accounts.status(view.account.id).auth === 'ready') await app.accounts.discover(view.account.id).catch(() => undefined); }
      send(app.accounts.get(view.account.id), 201); return;
    }
    const account = path.match(/^\/hub\/accounts\/([A-Za-z0-9_-]+)(\/credential)?$/);
    if (account) {
      const id = IdSchema.parse(account[1]);
      if (method === 'GET' && !account[2]) { send(app.accounts.get(id)); return; }
      if (method === 'PATCH' && !account[2]) { send(app.accounts.update(id, await body(request))); return; }
      if (method === 'PUT' && account[2]) { send(await app.accounts.replaceCredential(id, await body(request))); return; }
    }
    const action = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/(check|models|login)$/);
    if (action && method === 'POST') {
      EmptySchema.parse(await body(request)); const id = IdSchema.parse(action[1]);
      if (action[2] === 'login') send(await app.accounts.beginLogin(id), 201);
      else if (action[2] === 'models') send(await app.accounts.discover(id));
      else { const status = await app.accounts.check(id); if (status.auth === 'ready') await app.accounts.discover(id).catch(() => undefined); send(app.accounts.get(id)); }
      return;
    }
    const login = path.match(/^\/api\/logins\/([A-Za-z0-9_-]+)$/);
    if (login) {
      const id = IdSchema.parse(login[1]);
      if (method === 'GET') { send(await app.accounts.pollLogin(id)); return; }
      if (method === 'POST') { const input = LoginCodeSchema.parse(await body(request)); send(await app.accounts.submitLogin(id, input.code)); return; }
      if (method === 'DELETE') { EmptySchema.parse(await body(request)); await app.accounts.cancelLogin(id); send(await app.accounts.pollLogin(id)); return; }
    }
    if (path === '/hub/rigging' && method === 'GET') { send(RiggingListSchema.parse({ schema: 'rigging-list-v1', items: app.rigging.list(), application: app.hub.get('rigging-application', app.device.deviceId, RiggingApplicationSchema)?.document ?? null })); return; }
    if (path === '/hub/rigging' && method === 'POST') { const item = app.rigging.add(await body(request)); send({ schema: 'rigging-save-v1', item, application: await app.applyRigging() }, 201); return; }
    const rigging = path.match(/^\/hub\/rigging\/([A-Za-z0-9_-]+)$/);
    if (rigging && method === 'PUT') { const item = app.rigging.update(IdSchema.parse(rigging[1]), await body(request)); send({ schema: 'rigging-save-v1', item, application: await app.applyRigging() }); return; }
    if (path === '/api/rigging/apply' && method === 'POST') { EmptySchema.parse(await body(request)); send(await app.applyRigging()); return; }
    if (path === '/hub/secrets/jev' && method === 'PUT') { const input = SecretInputSchema.parse(await body(request)); send(SecretSummarySchema.parse(app.hub.vault.put('jev', input.value))); return; }
    if (path === '/hub/secrets/jev' && method === 'GET') {
      try { send(app.hub.vault.summary('jev')); }
      catch { send({ schema: 'secret-state-v1', id: 'jev', saved: false }); }
      return;
    }
    if (path === '/hub/devices' && method === 'GET') { send({ schema: 'devices-list-v1', currentDeviceId: app.device.deviceId, devices: app.hub.list('devices', DeviceSchema).map((row) => row.document) }); return; }
    throw failure('Not found.', 404);
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 400;
    send(ErrorDocumentSchema.parse({ schema: 'error-v1', code: status === 409 ? 'conflict' : status === 401 ? 'unauthenticated' : status === 404 ? 'not-found' : 'request-failed', message: error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate?.message === 'string' ? app.hub.redactor.text(candidate.message) : 'The request could not complete.' }), status);
  }
}
