import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { z } from 'zod';
import { AccountViewSchema, DeviceSchema, Homes, LoginViewSchema, SecretRedactor, writeDocument } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { joinMember } from '../packages/mesh/dist/index.js';
import { FakeRuntime, type RuntimeAdapter } from '../packages/runtime-contract/dist/index.js';

type Device = { app: Application; base: string; cookie: string; starts: number; submissions: number; cancellations: number; complete?: () => void };
const devices: Device[] = []; const servers: Server[] = []; let root: string; let offline = false; let deviceCode = false;
const passphrase = 'remote-login-fixture'; const empty = { schema: 'empty-request-v1' };
const FixtureAuthSchema = z.strictObject({ schema: z.literal('fixture-login-v1'), signedIn: z.literal(true) });
async function serve(options: { application?: Application }) { const server = createDaemon(options); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
function call(device: Device, path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') { return fetch(device.base + path, { method, headers: { Cookie: device.cookie, Origin: device.base, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); }
async function body(response: Response, status = 200) { const value: unknown = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status); return value; }
async function addDevice(name: string, hub?: Device) {
  const options: { application?: Application } = {}; const base = await serve(options); const homes = new Homes(join(root, name), join(root, 'user'));
  if (hub) await joinMember(homes, { schema: 'member-join-input-v1', hubUrl: hub.base, code: hub.app.mesh.invite().code, device: { name, url: base, os: 'linux', version: '0.1.0' } }, { redactor: new SecretRedactor() });
  const device = { base, cookie: '', starts: 0, submissions: 0, cancellations: 0 } as Device;
  const fake = new FakeRuntime();
  const runtime: RuntimeAdapter = { id: 'codex', displayName: 'Fixture Codex', accountKinds: ['subscription'], riggingKinds: [], capabilities: fake.capabilities,
    listModels: () => fake.listModels(), materialiseRigging: () => fake.materialiseRigging(), startStretch: input => fake.startStretch(input),
    probe: async resolved => ({ auth: existsSync(join(resolved.home, 'auth.json')) ? 'ready' : 'missing', identity: { email: 'fixture@example.test' } }),
    beginLogin: async (_account, home) => {
      device.starts++; let state: 'pending' | 'done' | 'failed' = 'pending';
      device.complete = () => { if (state === 'pending') { writeDocument(join(home, 'auth.json'), FixtureAuthSchema, { schema: 'fixture-login-v1', signedIn: true }); state = 'done'; } };
      return { instructions: 'Complete the simulated provider login.', url: 'https://example.test/device', ...(deviceCode ? { userCode: 'FIXTURE' } : { submitCode: async () => { device.submissions++; device.complete!(); } }), poll: async () => state, cancel: async () => { device.cancellations++; state = 'failed'; } };
    } };
  device.app = new Application({ homes, timers: false, runtimes: () => new Map([['codex', runtime]]), ...(hub ? { hubFetch: async (...args: Parameters<typeof fetch>) => { if (offline) throw new Error('Simulated hub outage'); return fetch(...args); } } : {}) }); options.application = device.app; devices.push(device);
  if (!hub) {
    const row = device.app.hub.get('devices', device.app.device.deviceId, DeviceSchema)!;
    device.app.hub.put('devices', row.document.id, DeviceSchema, { ...row.document, name, url: base }, row.revision);
  }
  await device.app.conversations.ready;
  const response = await call(device, hub ? '/api/auth/login' : '/api/auth/setup', { schema: 'passphrase-input-v1', passphrase }); await body(response); device.cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  await device.app.presence.pulse(); return device;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jevellan-remote-login-')); mkdirSync(join(root, 'user')); offline = false; deviceCode = false; });
afterEach(async () => { offline = false; for (const device of devices.splice(0).reverse()) await device.app.close(); await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); })); rmSync(root, { recursive: true, force: true }); });

test.each(['hub-to-member', 'member-to-hub', 'member-to-member'])('%s login stays in its target home and reports target readiness', async direction => {
  const hub = await addDevice('Hub'); const first = await addDevice('First', hub); const second = direction === 'member-to-member' ? await addDevice('Second', hub) : undefined;
  const source = direction === 'hub-to-member' ? hub : first; const target = direction === 'member-to-hub' ? hub : second ?? first;
  const account = AccountViewSchema.parse(await body(await call(source, '/hub/accounts', { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Remote account' }), 201));
  const route = `/api/accounts/${account.account.id}/login?deviceId=${target.app.device.deviceId}`; const input = { schema: 'login-start-v1', clientRequestId: 'remote_start' };
  const login = LoginViewSchema.parse(await body(await call(source, route, input), 201)); expect(login.deviceId).toBe(target.app.device.deviceId); expect(target.starts).toBe(1); expect(source.starts).toBe(0);
  expect(LoginViewSchema.parse(await body(await call(source, route, input), 201)).id).toBe(login.id); expect(target.starts).toBe(1);
  const path = `/api/logins/${login.id}?deviceId=${target.app.device.deviceId}`;
  expect(LoginViewSchema.parse(await body(await call(source, path))).state).toBe('pending');
  const submitted = { schema: 'login-code-v1', code: 'fixture-callback' };
  expect(LoginViewSchema.parse(await body(await call(source, path, submitted))).state).toBe('done');
  expect(LoginViewSchema.parse(await body(await call(source, path, submitted))).state).toBe('done'); expect(target.submissions).toBe(1);
  const view = AccountViewSchema.parse(await body(await call(source, `/hub/accounts/${account.account.id}`)));
  expect(view.statuses.filter(status => status.auth === 'ready')).toEqual([expect.objectContaining({ deviceId: target.app.device.deviceId, auth: 'ready' })]); expect(view.statuses.filter(status => status.deviceId !== target.app.device.deviceId).every(status => status.auth === 'missing')).toBe(true); expect(view.account.secretRef).toBeUndefined();
  expect(existsSync(join(target.app.homes.account('codex', account.account.id), 'auth.json'))).toBe(true);
  expect(existsSync(join(source.app.homes.account('codex', account.account.id), 'auth.json'))).toBe(false);
});

test('a remote device-code login completes by polling and a second login can be cancelled remotely', async () => {
  deviceCode = true; const hub = await addDevice('Hub'); const target = await addDevice('Target', hub);
  const account = AccountViewSchema.parse(await body(await call(hub, '/hub/accounts', { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Device code' }), 201));
  const start = () => call(hub, `/api/accounts/${account.account.id}/login?deviceId=${target.app.device.deviceId}`, { schema: 'login-start-v1', clientRequestId: `start_${target.starts}` });
  const login = LoginViewSchema.parse(await body(await start(), 201)); expect(login.userCode).toBe('FIXTURE'); expect(login.acceptsCode).toBe(false); target.complete!();
  expect(LoginViewSchema.parse(await body(await call(hub, `/api/logins/${login.id}?deviceId=${target.app.device.deviceId}`))).state).toBe('done');
  const next = LoginViewSchema.parse(await body(await start(), 201));
  expect(LoginViewSchema.parse(await body(await call(hub, `/api/logins/${next.id}?deviceId=${target.app.device.deviceId}`, empty, 'DELETE'))).state).toBe('cancelled'); expect(target.cancellations).toBe(1);
});

test('remote login waits before admission during hub loss and rejects offline, removed or wrongly authenticated devices', async () => {
  const hub = await addDevice('Hub'); const target = await addDevice('Target', hub);
  const account = AccountViewSchema.parse(await body(await call(hub, '/hub/accounts', { schema: 'add-account-v1', runtime: 'codex', kind: 'subscription', label: 'Wait fixture' }), 201));
  const route = `/api/accounts/${account.account.id}/login?deviceId=${target.app.device.deviceId}`; const input = { schema: 'login-start-v1', clientRequestId: 'wait_start' };
  offline = true; expect(await body(await call(hub, route, input), 503)).toMatchObject({ code: 'hub-unavailable', retryable: true }); expect(target.starts).toBe(0); offline = false;
  const login = LoginViewSchema.parse(await body(await call(hub, route, input), 201)); expect(target.starts).toBe(1);
  const peer = `${target.base}/api/mesh/login/logins/${login.id}`;
  expect((await fetch(peer, { headers: { Cookie: hub.cookie } })).status).toBe(401);
  expect((await fetch(peer, { headers: { Origin: hub.base } })).status).toBe(403);
  expect((await fetch(`${target.base}/api/mesh/login/rigging`)).status).toBe(404);
  const targetToken = target.cookie.slice(target.cookie.indexOf('=') + 1);
  expect((await fetch(peer, { headers: { Authorization: `Bearer ${targetToken}`, 'X-Jevellan-Source-Device': hub.app.device.deviceId } })).status).toBe(401);
  const row = hub.app.hub.get('devices', target.app.device.deviceId, DeviceSchema)!;
  hub.app.hub.put('devices', row.document.id, DeviceSchema, { ...row.document, lastHeartbeatAt: new Date(0).toISOString() }, row.revision);
  expect(await body(await call(hub, route, input), 409)).toMatchObject({ message: expect.stringContaining('offline') });
  hub.app.devices.revoke(target.app.device.deviceId); expect((await call(hub, route, input)).status).toBe(409); expect(target.starts).toBe(1);
});
