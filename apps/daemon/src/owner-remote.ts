import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { IdSchema, OWNER_TOOLS, TimestampSchema, VERSION, OwnerToolResultSchema, ownerTool, ownerToolAction, ownerToolInputSchema, ownerToolOutput } from '@jevellan/core';
import type { Application } from './application.js';

const CLIENTS = 'owner-remote-clients', GRANTS = 'owner-remote-grants', TOKENS = 'owner-remote-tokens';
const ACCESS_MS = 60 * 60_000, REFRESH_MS = 30 * 24 * 3600_000, CODE_MS = 10 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const ClientSchema = z.strictObject({ schema: z.literal('owner-remote-client-v1'), id: IdSchema, name: z.string().max(200), redirectUris: z.array(z.url()).min(1).max(10), createdAt: TimestampSchema });
// A pending authorization (`stage: 'authorize'`) or an issued code (`stage: 'code'`), keyed by a random id or the code's hash.
const GrantSchema = z.strictObject({ schema: z.literal('owner-remote-grant-v1'), id: IdSchema, stage: z.enum(['authorize', 'code']), clientId: IdSchema, redirectUri: z.url(), challenge: z.string().min(43).max(128),
  state: z.string().max(500).optional(), identity: z.string().max(200).optional(), expiresAt: TimestampSchema });
const TokenSchema = z.strictObject({ schema: z.literal('owner-remote-token-v1'), id: IdSchema, kind: z.enum(['access', 'refresh']), clientId: IdSchema, identity: z.string().max(200), expiresAt: TimestampSchema });
export const REMOTE_WRITES_OFF = 'Write actions are off for remote access. They can be turned on with config remote.write_enabled.';
export const REMOTE_DEPLOYS = 'Deploys and rollbacks are not available remotely.';

class Refusal extends Error { constructor(message: string, readonly status: number, readonly code = 'invalid_request') { super(message); } }

/**
 * The remote MCP endpoint (bridge specification, "Remote MCP"): the same twelve tools over Streamable HTTP for the Claude app and other
 * clients, reached only through a Cloudflare tunnel to `remote.hostname` (a request for any other host is not found). It is an OAuth
 * authorization server with PKCE, dynamic client registration, short-lived access tokens and rotated refresh tokens stored hashed;
 * identity comes from an upstream GitHub-compatible login with exactly one allowed identity. Off by default; writes off by default.
 */
export class OwnerRemote {
  constructor(private readonly app: Application, readonly now: () => number = Date.now, readonly fetcher: typeof fetch = fetch) {}
  get settings() { return this.app.ownerTools.installationSettings().remote; }
  #base(): string { return `https://${this.settings.hostname}`; }
  /** True when this request is for the remote endpoint (its host is the configured hostname). */
  owns(request: IncomingMessage, url: URL): boolean {
    const host = (request.headers.host ?? '').toString().split(':')[0]!.toLowerCase();
    const hostname = this.settings.hostname?.toLowerCase();
    return Boolean(hostname && host === hostname && (url.pathname.startsWith('/remote/') || url.pathname.startsWith('/.well-known/oauth-')));
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      if (!this.settings.enabled) throw new Refusal('Remote access is off.', 503, 'remote_disabled');
      const path = url.pathname;
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/remote/mcp') return this.#json(response, { resource: `${this.#base()}/remote/mcp`, authorization_servers: [this.#base()], bearer_methods_supported: ['header'] });
      if (path === '/.well-known/oauth-authorization-server') return this.#json(response, { issuer: this.#base(), authorization_endpoint: `${this.#base()}/remote/oauth/authorize`, token_endpoint: `${this.#base()}/remote/oauth/token`,
        registration_endpoint: `${this.#base()}/remote/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (path === '/remote/oauth/register' && request.method === 'POST') return this.#register(request, response);
      if (path === '/remote/oauth/authorize' && request.method === 'GET') return this.#authorize(url, response);
      if (path === '/remote/oauth/callback' && request.method === 'GET') return await this.#callback(url, response);
      if (path === '/remote/oauth/token' && request.method === 'POST') return await this.#token(request, response);
      if (path === '/remote/mcp') return await this.#mcp(request, response);
      throw new Refusal('Not found.', 404, 'not_found');
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof Refusal ? error.status : 400;
      if (status === 401) response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${this.#base()}/.well-known/oauth-protected-resource"`);
      this.#json(response, { error: error instanceof Refusal ? error.code : 'invalid_request', error_description: error instanceof Error ? error.message : 'The request could not complete.' }, status);
    }
  }
  #json(response: ServerResponse, body: unknown, status = 200): void { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
  async #body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 64 * 1024) throw new Refusal('The request is too large.', 413); chunks.push(chunk as Buffer); }
    const text = Buffer.concat(chunks).toString('utf8'); const type = (request.headers['content-type'] ?? '').toString();
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try { return JSON.parse(text || '{}') as Record<string, unknown>; } catch { throw new Refusal('The body is not JSON.', 400); }
  }
  async #register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.#body(request);
    const uris = z.array(z.url()).min(1).max(10).safeParse(body.redirect_uris); if (!uris.success) throw new Refusal('redirect_uris must list the client\'s redirect addresses.', 400, 'invalid_redirect_uri');
    const id = `client_${token().slice(0, 24)}`;
    this.app.hub.put(CLIENTS, id, ClientSchema, { schema: 'owner-remote-client-v1', id, name: String(body.client_name ?? 'client').slice(0, 200), redirectUris: uris.data, createdAt: new Date(this.now()).toISOString() }, 0);
    this.#json(response, { client_id: id, redirect_uris: uris.data, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  }
  #authorize(url: URL, response: ServerResponse): void {
    const query = Object.fromEntries(url.searchParams); const client = this.app.hub.get(CLIENTS, String(query.client_id ?? ''), ClientSchema)?.document;
    if (!client) throw new Refusal('Unknown client. Register it first.', 400, 'invalid_client');
    if (!client.redirectUris.includes(String(query.redirect_uri))) throw new Refusal('This redirect address is not registered for the client.', 400, 'invalid_redirect_uri');
    if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || !query.code_challenge) throw new Refusal('Use the code flow with PKCE S256.', 400);
    if (!this.settings.allowedIdentity) throw new Refusal('No identity is allowed yet. Set it with config set remote allowedIdentity <login>.', 403, 'access_denied');
    const id = `auth_${token().slice(0, 24)}`;
    this.app.hub.put(GRANTS, id, GrantSchema, { schema: 'owner-remote-grant-v1', id, stage: 'authorize', clientId: client.id, redirectUri: String(query.redirect_uri), challenge: String(query.code_challenge),
      ...(query.state ? { state: String(query.state).slice(0, 500) } : {}), expiresAt: new Date(this.now() + CODE_MS).toISOString() }, 0);
    const upstream = new URL('/login/oauth/authorize', this.settings.identityBaseUrl);
    upstream.searchParams.set('client_id', this.#upstreamClient().id); upstream.searchParams.set('redirect_uri', `${this.#base()}/remote/oauth/callback`); upstream.searchParams.set('state', id); upstream.searchParams.set('scope', 'read:user');
    response.writeHead(302, { Location: upstream.toString(), 'Cache-Control': 'no-store' }); response.end();
  }
  /** The upstream OAuth app (an owner step); its id and secret live in the vault. */
  #upstreamClient(): { id: string; secret: string } {
    const read = (name: string) => { try { return this.app.hub.vault.forLaunch(name); } catch { return ''; } };
    const id = read('remote-oauth-client-id'), secret = read('remote-oauth-client-secret');
    if (!id || !secret) throw new Refusal('The upstream sign-in app is not set up. Store its id and secret with jevellan remote setup.', 503, 'server_error');
    return { id, secret };
  }
  async #callback(url: URL, response: ServerResponse): Promise<void> {
    const pending = this.app.hub.get(GRANTS, String(url.searchParams.get('state') ?? ''), GrantSchema);
    if (!pending || pending.document.stage !== 'authorize' || Date.parse(pending.document.expiresAt) < this.now()) throw new Refusal('This sign-in expired. Start again from the client.', 400, 'invalid_grant');
    this.app.hub.delete(GRANTS, pending.document.id);
    const client = this.#upstreamClient(); const api = this.settings.identityBaseUrl === 'https://github.com' ? 'https://api.github.com' : this.settings.identityBaseUrl.replace(/\/$/u, '');
    const exchange = await this.fetcher(new URL('/login/oauth/access_token', this.settings.identityBaseUrl), { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: client.id, client_secret: client.secret, code: url.searchParams.get('code'), redirect_uri: `${this.#base()}/remote/oauth/callback` }), signal: AbortSignal.timeout(15_000) });
    const upstream = await exchange.json().catch(() => ({})) as { access_token?: string };
    if (!upstream.access_token) throw new Refusal('The upstream sign-in did not complete.', 502, 'server_error');
    const user = await (await this.fetcher(`${api}/user`, { headers: { Authorization: `Bearer ${upstream.access_token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })).json().catch(() => ({})) as { login?: string };
    if (!user.login || user.login.toLowerCase() !== (this.settings.allowedIdentity ?? '').toLowerCase()) throw new Refusal('This identity is not allowed to use this Jevellan.', 403, 'access_denied');
    const code = token();
    this.app.hub.put(GRANTS, `code_${hash(code).slice(0, 40)}`, GrantSchema, { ...pending.document, id: `code_${hash(code).slice(0, 40)}`, stage: 'code', identity: user.login, expiresAt: new Date(this.now() + CODE_MS).toISOString() }, 0);
    const back = new URL(pending.document.redirectUri); back.searchParams.set('code', code); if (pending.document.state) back.searchParams.set('state', pending.document.state);
    response.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' }); response.end();
  }
  #issue(clientId: string, identity: string) {
    const access = token(), refresh = token();
    this.app.hub.put(TOKENS, `t_${hash(access).slice(0, 40)}`, TokenSchema, { schema: 'owner-remote-token-v1', id: `t_${hash(access).slice(0, 40)}`, kind: 'access', clientId, identity, expiresAt: new Date(this.now() + ACCESS_MS).toISOString() }, 0);
    this.app.hub.put(TOKENS, `t_${hash(refresh).slice(0, 40)}`, TokenSchema, { schema: 'owner-remote-token-v1', id: `t_${hash(refresh).slice(0, 40)}`, kind: 'refresh', clientId, identity, expiresAt: new Date(this.now() + REFRESH_MS).toISOString() }, 0);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh };
  }
  async #token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.#body(request);
    if (body.grant_type === 'authorization_code') {
      const code = this.app.hub.get(GRANTS, `code_${hash(String(body.code ?? '')).slice(0, 40)}`, GrantSchema)?.document;
      if (!code || code.stage !== 'code' || Date.parse(code.expiresAt) < this.now() || code.clientId !== body.client_id || code.redirectUri !== body.redirect_uri) throw new Refusal('The code is invalid or expired.', 400, 'invalid_grant');
      const challenge = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url');
      if (challenge.length !== code.challenge.length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(code.challenge))) throw new Refusal('The code verifier does not match.', 400, 'invalid_grant');
      this.app.hub.delete(GRANTS, code.id);
      return this.#json(response, this.#issue(code.clientId, code.identity!));
    }
    if (body.grant_type === 'refresh_token') {
      const key = `t_${hash(String(body.refresh_token ?? '')).slice(0, 40)}`; const stored = this.app.hub.get(TOKENS, key, TokenSchema)?.document;
      if (!stored || stored.kind !== 'refresh' || Date.parse(stored.expiresAt) < this.now() || (body.client_id && body.client_id !== stored.clientId)) throw new Refusal('The refresh token is invalid.', 400, 'invalid_grant');
      this.app.hub.delete(TOKENS, key); // rotated: each refresh token works once
      return this.#json(response, this.#issue(stored.clientId, stored.identity));
    }
    throw new Refusal('grant_type must be authorization_code or refresh_token.', 400, 'unsupported_grant_type');
  }
  identity(authorization: string | undefined): string | null {
    if (!authorization?.startsWith('Bearer ')) return null;
    const stored = this.app.hub.get(TOKENS, `t_${hash(authorization.slice(7)).slice(0, 40)}`, TokenSchema)?.document;
    if (!stored || stored.kind !== 'access' || Date.parse(stored.expiresAt) < this.now()) return null;
    if (stored.identity.toLowerCase() !== (this.settings.allowedIdentity ?? '').toLowerCase()) return null;
    return stored.identity;
  }
  /** Revocation: every token and pending grant is deleted at once. */
  revoke(): number {
    let count = 0;
    for (const row of this.app.hub.list(TOKENS, TokenSchema)) { this.app.hub.delete(TOKENS, row.document.id); count++; }
    for (const row of this.app.hub.list(GRANTS, GrantSchema)) { this.app.hub.delete(GRANTS, row.document.id); count++; }
    return count;
  }
  async #mcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const identity = this.identity(request.headers.authorization);
    if (!identity) throw new Refusal('Sign in to use this Jevellan.', 401, 'invalid_token');
    const caller = `remote:${identity.replace(/[^A-Za-z0-9._@-]/gu, '_').slice(0, 120)}`;
    const server = new Server({ name: 'jevellan', version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OWNER_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: ownerToolInputSchema(tool) as { type: 'object' } })) }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const args = (call.params.arguments ?? {}) as Record<string, unknown>; const tool = ownerTool(call.params.name);
      const action = tool ? ownerToolAction(tool, args, typeof args.action === 'string' ? args.action : undefined) : undefined;
      // Writes, deploys and rollbacks are refused before anything runs; every refusal is logged like any call.
      const refuse = (text: string) => { this.app.ownerTools.logRefusal(caller, tool?.name ?? 'status', action?.name ?? 'unknown', action?.access ?? 'write', args, 'remote_refused'); return { content: [{ type: 'text' as const, text }], isError: true }; };
      if (!this.settings.enabled) return refuse('Remote access is off.');
      if (tool?.name === 'jobs' && (action?.name === 'rollback' || (action?.name === 'run' && await this.app.ownerTools.isDeployJob(args)))) return refuse(REMOTE_DEPLOYS);
      if (action?.access === 'write' && tool?.name !== 'respond' && !this.settings.writeEnabled) return refuse(REMOTE_WRITES_OFF);
      const { action: _a, ...rest } = args; void _a;
      const result = await this.app.ownerTools.call(call.params.name, { schema: 'owner-tool-request-v1', ...(action ? { action: action.name } : {}), args: rest, caller });
      return ownerToolOutput(call.params.name, args, OwnerToolResultSchema.parse(this.app.redactor.document(result)));
    });
    const transport = new StreamableHTTPServerTransport({});
    response.once('close', () => { void transport.close().catch(() => undefined); void server.close().catch(() => undefined); });
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, request.method === 'POST' ? await this.#body(request) : undefined);
  }

  /** `jevellan remote setup`: the cloudflared configuration for the hostname and the steps only the owner can do. */
  setup(port: number, credentials?: { clientId: string; clientSecret: string }): string {
    const hostname = this.settings.hostname; if (!hostname) throw new Refusal('Set the hostname first: config set remote hostname mcp.example.com.', 400);
    if (credentials) { this.app.hub.vault.put('remote-oauth-client-id', credentials.clientId); this.app.hub.vault.put('remote-oauth-client-secret', credentials.clientSecret); }
    const folder = join(this.app.homes.root, 'remote'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, 'cloudflared.yml');
    writeFileSync(file, ['tunnel: jevellan', `credentials-file: ${join(folder, 'jevellan-tunnel.json')}`, 'ingress:', `  - hostname: ${hostname}`, `    service: http://127.0.0.1:${port}`, '  - service: http_status:404', ''].join('\n'), { mode: 0o600 });
    return [`Wrote ${file}.`, 'Steps that need you:', '1. cloudflared tunnel login', `2. cloudflared tunnel create jevellan, then move its credentials file to ${join(folder, 'jevellan-tunnel.json')}`, `3. cloudflared tunnel route dns jevellan ${hostname}`,
      `4. cloudflared tunnel --config ${file} run jevellan (or install it as a service)`, `5. Create a GitHub OAuth app with the callback https://${hostname}/remote/oauth/callback and run jevellan remote setup --client-id <id> (the secret is asked at a hidden prompt).`,
      '6. config set remote allowedIdentity <your GitHub login>, then config set remote enabled true.', `7. In the Claude app, add a custom connector at https://${hostname}/remote/mcp.`].join('\n');
  }
}
