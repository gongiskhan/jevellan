import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeviceSchema, GitHubTokenStateSchema, Homes, SecretRedactor } from '../packages/core/dist/index.js';
import { HubUnavailable, MemberHubClient, MemberState, joinHub } from '../packages/mesh/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string; let cookie: string;
const empty = { schema: 'empty-request-v1' };
/** Shaped like a classic GitHub token, so the redactor's pattern also matches it; built at runtime for the secret scan. */
const githubToken = () => `${['gh', 'p_'].join('')}${randomBytes(18).toString('hex')}`;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-github-token-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'hub'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = app.hub.get('devices', app.device.deviceId, DeviceSchema)!; app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...hub.document, url: base }, hub.revision);
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) });
  expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); rmSync(root, { recursive: true, force: true }); });
function request(path: string, method = 'GET', value?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: base, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function member(id: string, fetcher?: typeof fetch) {
  const redactor = new SecretRedactor();
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, { schema: 'join-device-v1', requestId: `join_${id}`, code: app.mesh.invite().code, device: { id, name: id, url: `http://127.0.0.1:${id === 'left' ? 9773 : 9774}`, os: 'linux', version: '0.1.0' } });
  const client = new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: id, token: () => joined.membership.token, redactor, ...(fetcher ? { fetch: fetcher } : {}) });
  return { state: new MemberState(client, ['codex']), redactor, token: joined.membership.token };
}
const stored = () => JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all());

test('the GitHub token routes return a masked summary, never the token, and remove it on request', async () => {
  expect((await fetch(`${base}/hub/secrets/github`)).status).toBe(401);
  expect(await (await request('/hub/secrets/github')).json()).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false });
  const value = githubToken(); const before = Date.now();
  const saved = await request('/hub/secrets/github', 'PUT', { schema: 'save-secret-v1', value }); const text = await saved.text();
  expect(saved.status).toBe(200); expect(text).not.toContain(value);
  const summary = GitHubTokenStateSchema.parse(JSON.parse(text));
  expect(summary).toMatchObject({ schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: value.slice(-4) });
  expect(summary.saved && Date.parse(summary.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
  expect(await (await request('/hub/secrets/github')).json()).toEqual(summary);
  expect(await app.state.github.credential()).toBe(value); expect(stored()).not.toContain(value);
  expect(await (await request('/hub/secrets/jev')).json()).toEqual({ schema: 'secret-state-v1', id: 'jev', saved: false });
  expect((await request('/hub/secrets/github', 'PUT', { schema: 'save-secret-v1', value: '' })).status).toBe(400);
  expect((await request('/hub/secrets/github', 'POST', empty)).status).toBe(404);

  const removed = await request('/hub/secrets/github', 'DELETE', empty);
  expect(removed.status).toBe(200); expect(await removed.json()).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false });
  expect(await app.state.github.credential()).toBeUndefined();
  expect(await (await request('/hub/secrets/github', 'DELETE', empty)).json()).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false });
  expect((await request('/hub/secrets/github', 'DELETE', { schema: 'empty-request-v1', value })).status).toBe(400);
});

test('a GitHub token save recovers a committed result by request id, and a removal may wait for the hub', async () => {
  const outage = new HubUnavailable('Fixture hub'); const value = githubToken();
  const put = app.state.github.put.bind(app.state.github);
  vi.spyOn(app.state.github, 'put').mockImplementationOnce(async (...args) => { await put(...args); throw outage; });
  const input = { schema: 'save-secret-v1', clientRequestId: 'github_save_lost', value };
  const lost = await request('/hub/secrets/github', 'PUT', input); expect(lost.status).toBe(503); expect(await lost.json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
  const retried = await request('/hub/secrets/github', 'PUT', input); expect(retried.status).toBe(200); expect(await retried.json()).toMatchObject({ saved: true, lastFour: value.slice(-4) });
  expect(await app.state.github.credential()).toBe(value);
  expect((await request('/hub/secrets/github', 'PUT', { ...input, value: githubToken() })).status).toBe(409);
  vi.spyOn(app.state.github, 'remove').mockRejectedValueOnce(outage);
  expect(await (await request('/hub/secrets/github', 'DELETE', empty)).json()).toMatchObject({ code: 'hub-unavailable', retryable: true });
});

test('members save, read and remove the GitHub token; only the credential reply carries it, unredacted', async () => {
  let lose = false;
  const left = await member('left', async (...args) => {
    const response = await fetch(...args); const body = args[1]?.body;
    if (lose && typeof body === 'string' && (JSON.parse(body) as { operation?: string }).operation === 'github-put') { lose = false; await response.body?.cancel(); throw new Error('Simulated lost reply'); }
    return response;
  });
  const right = await member('right'); const value = githubToken();
  expect(await left.state.github.summary()).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false }); expect(await left.state.github.credential()).toBeUndefined();
  const summary = await left.state.github.put(value); expect(summary).toMatchObject({ schema: 'github-token-summary-v1', id: 'github', saved: true, lastFour: value.slice(-4) });
  expect(JSON.stringify(summary)).not.toContain(value); expect(left.redactor.text(value)).toBe('[redacted]');
  expect(await right.state.github.summary()).toEqual(summary);
  expect(await right.state.github.credential()).toBe(value); expect(right.redactor.text(`token ${value}`)).toBe('token [redacted]');
  const device = (operation: string) => fetch(`${base}/hub/mesh/state`, { method: 'POST', headers: { Authorization: `Bearer ${right.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'shared-state-request-v1', operation }) });
  expect(await (await device('github-credential')).json()).toEqual({ schema: 'shared-github-credential-v1', value });
  expect(await (await device('github-summary')).text()).not.toContain(value);
  expect(stored()).not.toContain(value);

  const replacement = githubToken(); lose = true;
  await expect(left.state.github.put(replacement, 'github_lost')).rejects.toBeInstanceOf(HubUnavailable);
  expect(await right.state.github.credential()).toBe(replacement);
  expect(await right.state.github.remove()).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false });
  expect(await left.state.github.put(replacement, 'github_lost')).toEqual({ schema: 'secret-state-v1', id: 'github', saved: false });
  await expect(left.state.github.put(githubToken(), 'github_lost')).rejects.toMatchObject({ status: 409 });
  expect(await left.state.github.credential()).toBeUndefined(); expect(await right.state.jev.summary()).toMatchObject({ id: 'jev', saved: false });
  // A token without a recognizable shape is redacted only because the member learned it from its own save or a credential reply.
  const plain = `fixture-${randomUUID()}`; expect(right.redactor.text(plain)).toBe(plain);
  await left.state.github.put(plain); expect(left.redactor.text(plain)).toBe('[redacted]'); expect(right.redactor.text(plain)).toBe(plain);
  expect(await right.state.github.credential()).toBe(plain); expect(right.redactor.text(plain)).toBe('[redacted]');
});
