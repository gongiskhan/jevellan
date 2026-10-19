import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Homes, SecretRedactor, EkoaOAuthVaultSchema, EkoaSettingsSchema } from '../packages/core/dist/index.js';
import { HubDatabase } from '../packages/mesh/dist/index.js';
import { EkoaOAuthService } from '../apps/daemon/dist/ekoa-oauth.js';
import { EkoaMirrorService } from '../apps/daemon/dist/ekoa-mirror.js';
let root: string, hub: HubDatabase, server: ReturnType<typeof createServer>, origin: string, clock: number;
let dcr: boolean, registrations: number, exchanges: number, rotation: number, challenge: string;
let service: EkoaOAuthService;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-oauth-')); hub = new HubDatabase(new Homes(join(root, 'hub'), join(root, 'user')), 'hub', new SecretRedactor());
  clock = Date.parse('2026-10-19T12:00:00.000Z'); dcr = true; registrations = exchanges = rotation = 0; challenge = '';
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin); const reply = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/oauth-protected-resource') return reply({ resource: origin, authorization_servers: [origin], scopes_supported: ['ekoa.read', 'ekoa.write'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return reply({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', ...(dcr ? { registration_endpoint: origin + '/register' } : {}), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['ekoa.read', 'ekoa.write'] });
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks).toString('utf8');
    if (url.pathname === '/register') {
      registrations++; const input = JSON.parse(raw) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(input.redirect_uris).toEqual(['https://hub.example/settings/ekoa/callback']); expect(input.token_endpoint_auth_method).toBe('none');
      return reply({ client_id: 'fixture_client', redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
    }
    if (url.pathname === '/token') {
      exchanges++; const form = new URLSearchParams(raw);
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('code')).toBe('fixture_code'); expect(form.get('redirect_uri')).toBe('https://hub.example/settings/ekoa/callback');
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(challenge);
      } else if (form.get('refresh_token') !== `fixture_refresh_${rotation}`) return reply({ error: 'invalid_grant' }, 400);
      rotation++; return reply({ access_token: `fixture_access_${rotation}`, refresh_token: `fixture_refresh_${rotation}`, token_type: 'Bearer', expires_in: 120, scope: 'ekoa.read ekoa.write' });
    }
    reply({ error: 'not_found' }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  service = new EkoaOAuthService(hub, () => 'https://hub.example', fetch, () => clock);
});
afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); hub.close(); rmSync(root, { recursive: true, force: true }); });
async function signIn() {
  const input = { schema: 'ekoa-oauth-start-v1' as const, clientRequestId: 'sign_in_one', url: origin + '/mcp' };
  const result = await service.start(input, 'fixture.owner'), url = new URL(result.authorizationUrl!); challenge = url.searchParams.get('code_challenge')!;
  expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('resource')).toBe(origin);
  expect((await service.start(input, 'fixture.owner')).authorizationUrl).toBe(url.href);
  return { schema: 'ekoa-oauth-callback-v1' as const, state: url.searchParams.get('state')!, code: 'fixture_code' };
}
test('fake OAuth discovery, dynamic registration, PKCE, owner binding and callback retries keep tokens encrypted', async () => {
  const callback = await signIn(); expect(registrations).toBe(1);
  await expect(service.complete(callback, 'another_owner')).rejects.toThrow('another browser'); expect(exchanges).toBe(0);
  expect((await service.complete(callback, 'fixture.owner')).connected).toBe(true);
  expect((await service.complete(callback, 'fixture.owner')).connected).toBe(true); expect(exchanges).toBe(1);
  expect(await service.accessToken(origin + '/mcp')).toBe('fixture_access_1');
  const ciphertext = String(hub.db.prepare('SELECT document FROM secrets WHERE id=?').get('ekoa-oauth')!.document);
  expect(ciphertext).not.toContain('fixture_access'); expect(ciphertext).not.toContain('fixture_refresh');
  expect(JSON.stringify(service.status())).not.toContain('fixture_access'); expect(hub.redactor.text('fixture_access_1 fixture_refresh_1')).toBe('[redacted] [redacted]');
});
test('concurrent refreshes use the rotated token once and persist it before returning access', async () => {
  await service.complete(await signIn(), 'fixture.owner'); clock += 90_000;
  const restarted = new EkoaOAuthService(hub, () => 'https://hub.example', fetch, () => clock);
  const access = await Promise.all([restarted.accessToken(origin + '/mcp'), restarted.accessToken(origin + '/mcp')]);
  expect(access).toEqual(['fixture_access_2', 'fixture_access_2']); expect(exchanges).toBe(2);
  expect(EkoaOAuthVaultSchema.parse(JSON.parse(hub.vault.forLaunch('ekoa-oauth'))).tokens?.refreshToken).toBe('fixture_refresh_2');
  clock += 90_000; expect(await restarted.accessToken(origin + '/mcp')).toBe('fixture_access_3');
});
test('a vault failure prevents a newly rotated access token from being used', async () => {
  await service.complete(await signIn(), 'fixture.owner'); clock += 90_000;
  vi.spyOn(hub.vault, 'put').mockImplementation(() => { throw new Error('Fixture vault write unavailable.'); });
  await expect(service.accessToken(origin + '/mcp')).rejects.toThrow('vault write unavailable');
});
test('missing dynamic registration records the exact client requirements and refuses token exchange', async () => {
  dcr = false;
  await expect(service.start({ schema: 'ekoa-oauth-start-v1', clientRequestId: 'no_dcr', url: origin + '/mcp' }, 'fixture.owner')).rejects.toThrow('redirect https://hub.example/settings/ekoa/callback');
  expect(registrations).toBe(0); expect(exchanges).toBe(0); expect(service.status().connected).toBe(false);
});
test('expired state, a declined sign-in and a different resource cannot grant access', async () => {
  const callback = await signIn(); clock += 16 * 60000;
  await expect(service.complete(callback, 'fixture.owner')).rejects.toThrow('expired');
  const renewed = await service.start({ schema: 'ekoa-oauth-start-v1', clientRequestId: 'sign_in_two', url: origin + '/mcp' }, 'fixture.owner');
  await expect(service.complete({ schema: 'ekoa-oauth-callback-v1', state: new URL(renewed.authorizationUrl!).searchParams.get('state')!, error: 'access_denied' }, 'fixture.owner')).rejects.toThrow('not completed');
  await expect(service.accessToken(origin + '/other')).rejects.toThrow('Connect'); expect(exchanges).toBe(0);
});
test('an invalid saved OAuth document blocks connection without preventing the daemon service from starting', async () => {
  hub.vault.put('ekoa-oauth', JSON.stringify({ schema: 'ekoa-oauth-vault-v1', tokens: null }));
  expect(() => { service = new EkoaOAuthService(hub, () => 'https://hub.example'); }).not.toThrow();
  expect(service.status()).toMatchObject({ connected: false, reason: expect.stringContaining('Connect again') });
  expect((await service.start({ schema: 'ekoa-oauth-start-v1', clientRequestId: 'repair_sign_in', url: origin + '/mcp' }, 'fixture.owner')).connecting).toBe(true);
});
test('invalid token JSON never includes response bytes in its failure sentence', async () => {
  const callback = await signIn();
  const malformed = new EkoaOAuthService(hub, () => 'https://hub.example', async (input, init) => String(input).endsWith('/token') ? new Response('fixture_private_token_value malformed', { status: 200 }) : fetch(input, init), () => clock);
  let message = ''; try { await malformed.complete(callback, 'fixture.owner'); } catch (error) { message = (error as Error).message; }
  expect(message).toBe('Ekoa OAuth returned invalid JSON.'); expect(message).not.toContain('fixture_private_token_value');
});
test('an owner settings save during sign-in is preserved when the token request completes', async () => {
  const callback = await signIn();
  hub.put('ekoa-settings', 'current', EkoaSettingsSchema, { schema: 'ekoa-settings-v1', revision: 1, url: origin + '/mcp', enabled: false }, 0);
  let entered!: () => void, release!: () => void;
  const received = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (url, init) => { const response = await fetch(url, init); if (String(url).endsWith('/token')) { entered(); await held; } return response; };
  const mirror = new EkoaMirrorService(hub, () => 'https://hub.example', async () => { throw new Error('Fixture MCP unavailable.'); }, () => clock, fetcher);
  try {
    const completion = mirror.request({ schema: 'ekoa-request-v1', operation: 'oauth-complete', ownerSession: 'fixture.owner', input: callback }, 'hub');
    await Promise.race([received, completion.then(() => { throw new Error('The token request did not start.'); })]);
    await mirror.request({ schema: 'ekoa-request-v1', operation: 'save', ownerSession: 'fixture.owner', input: { schema: 'ekoa-settings-input-v1', clientRequestId: 'owner_pause', revision: 1, url: origin + '/mcp', enabled: false } }, 'hub');
    release(); expect((await completion).settings.enabled).toBe(false);
  } finally { release(); await mirror.close(); }
});
