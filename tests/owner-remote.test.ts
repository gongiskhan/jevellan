// Journey H (bridge specification, "Remote MCP"), simulated: a fake GitHub-compatible identity provider, the real daemon over HTTP with
// the tunnel's Host header, and the official MCP client.
import { afterEach, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DoctorControlSchema, doctorControlPath, readDocument } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

const HOST = 'mcp.example.test';
let f: ProjectFixture | undefined; let idp: Server | undefined; let login = 'owner-login';
afterEach(async () => { await f?.close(); f = undefined; await new Promise(resolve => idp ? idp.close(resolve) : resolve(undefined)); idp = undefined; });

/** fetch through the loopback origin with the tunnel's Host header, as cloudflared delivers it. */
function tunnelFetch(origin: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); const target = new URL(origin);
    const headers = Object.fromEntries(new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ host: target.hostname, port: target.port, path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', headers: { ...headers, host: HOST } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => resolve(new Response(response.statusCode === 204 || response.statusCode === 202 && !chunks.length ? null : Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: response.headers as Record<string, string> })));
      });
      request.on('error', reject); if (body) request.write(body); request.end();
    });
  }) as typeof fetch;
}

async function setup() {
  f = await projectFixture({ control: true });
  idp = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://idp');
    if (url.pathname === '/login/oauth/authorize') { const back = new URL(url.searchParams.get('redirect_uri')!); back.searchParams.set('code', 'upstream-code'); back.searchParams.set('state', url.searchParams.get('state')!); response.writeHead(302, { Location: back.toString() }); response.end(); return; }
    if (url.pathname === '/login/oauth/access_token') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ access_token: 'upstream-token' })); return; }
    if (url.pathname === '/user') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ login })); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => idp!.listen(0, '127.0.0.1', resolve));
  const port = (idp.address() as { port: number }).port;
  f.app.ownerTools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, enabled: true, hostname: HOST, identityBaseUrl: `http://127.0.0.1:${port}`, allowedIdentity: 'owner-login' } }));
  f.app.hub.vault.put('remote-oauth-client-id', 'upstream-client'); f.app.hub.vault.put('remote-oauth-client-secret', 'upstream-secret');
  const control = readDocument(doctorControlPath(f.homes), DoctorControlSchema);
  return { fetcher: tunnelFetch(control.origin), control };
}
async function signIn(fetcher: typeof fetch): Promise<{ status: number; tokens?: { access_token: string; refresh_token: string }; clientId: string }> {
  const metadata = await (await fetcher(`https://${HOST}/.well-known/oauth-authorization-server`)).json() as { registration_endpoint: string; authorization_endpoint: string; token_endpoint: string };
  const client = await (await fetcher(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'test', redirect_uris: ['http://127.0.0.1:9/callback'] }) })).json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(metadata.authorization_endpoint); for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })) authorize.searchParams.set(key, value);
  const toIdp = await fetcher(authorize.toString()); const upstream = toIdp.headers.get('location')!;
  const back = await fetch(upstream, { redirect: 'manual' }); const callback = new URL(back.headers.get('location')!);
  const toClient = await fetcher(callback.toString());
  if (toClient.status !== 302) return { status: toClient.status, clientId: client.client_id };
  const code = new URL(toClient.headers.get('location')!).searchParams.get('code')!;
  const tokens = await (await fetcher(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9/callback' }) })).json() as { access_token: string; refresh_token: string };
  return { status: 302, tokens, clientId: client.client_id };
}
async function mcp(fetcher: typeof fetch, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://${HOST}/remote/mcp`), { fetch: fetcher, requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }) as Transport);
  return client;
}

test('Journey H: a client registers, signs in with PKCE as the one allowed identity, lists twelve tools, reads, and is refused writes, deploys, other identities, a disabled endpoint and revoked tokens', async () => {
  const { fetcher, control } = await setup();
  const signed = await signIn(fetcher); expect(signed.status).toBe(302);
  const client = await mcp(fetcher, signed.tokens!.access_token);
  expect((await client.listTools()).tools).toHaveLength(12);
  const status = await client.callTool({ name: 'status', arguments: {} }); expect(status.isError).toBeFalsy();
  expect(await client.callTool({ name: 'work', arguments: { action: 'add', title: 'Remote task' } })).toMatchObject({ isError: true, content: [{ text: 'Write actions are off for remote access. They can be turned on with config remote.write_enabled.' }] });
  expect((await client.callTool({ name: 'respond', arguments: { item: 'W9', answer: 'yes' } })).content).toMatchObject([{ text: expect.stringMatching(/^W9 is not waiting on you\./u) }]);
  f!.app.ownerTools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, writeEnabled: true } }));
  expect(await client.callTool({ name: 'jobs', arguments: { action: 'rollback', confirm: true } })).toMatchObject({ isError: true, content: [{ text: 'Deploys and rollbacks are not available remotely.' }] });
  expect((await client.callTool({ name: 'work', arguments: { action: 'add', title: 'Remote task' } })).isError).toBeFalsy();
  expect(f!.app.ownerTools.callerLog().map(row => row.caller)).toContain('remote:owner-login');
  // Refresh tokens rotate: the first works once.
  const refresh = async (token: string) => (await fetcher(`https://${HOST}/remote/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token, client_id: signed.clientId }) })).status;
  expect(await refresh(signed.tokens!.refresh_token)).toBe(200); expect(await refresh(signed.tokens!.refresh_token)).toBe(400);
  // Another identity is refused at sign-in.
  login = 'someone-else'; expect((await signIn(fetcher)).status).toBe(403); login = 'owner-login';
  // Disabling remote access cuts everything at once; revoke kills existing tokens.
  f!.app.ownerTools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, enabled: false } }));
  expect((await fetcher(`https://${HOST}/remote/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${signed.tokens!.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(503);
  f!.app.ownerTools.updateInstallationSettings(settings => ({ ...settings, remote: { ...settings.remote, enabled: true } }));
  const revoked = await fetch(`${control.origin}/api/local/remote`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'owner-remote-request-v1', operation: 'revoke', port: 1 }) });
  expect(((await revoked.json()) as { text: string }).text).toMatch(/^Revoked \d+ remote tokens and sign-ins\./u);
  expect((await fetcher(`https://${HOST}/remote/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${signed.tokens!.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })).status).toBe(401);
  // The endpoint does not exist for any other host (the loopback origin, the tailnet).
  expect((await fetch(`${control.origin}/remote/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
  await client.close();
});

test('remote setup writes a valid cloudflared configuration and lists the owner steps', async () => {
  const { control } = await setup();
  const response = await fetch(`${control.origin}/api/local/remote`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'owner-remote-request-v1', operation: 'setup', port: 9771 }) });
  const text = ((await response.json()) as { text: string }).text;
  expect(text).toMatch(/^Wrote .+cloudflared\.yml\.\nSteps that need you:\n1\. cloudflared tunnel login/u);
  const yaml = readFileSync(text.split('\n')[0]!.slice('Wrote '.length, -1), 'utf8');
  expect(yaml).toBe(`tunnel: jevellan\ncredentials-file: ${f!.homes.root}/remote/jevellan-tunnel.json\ningress:\n  - hostname: ${HOST}\n    service: http://127.0.0.1:9771\n  - service: http_status:404\n`);
});
