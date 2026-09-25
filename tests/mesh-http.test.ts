import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConversationIndexSchema, DeviceSchema, DeviceSwitchSchema, Homes, JoinInvitationSchema, MemberJoinPlanSchema, SecretRedactor, readDocument, type Heartbeat, type JoinedDevice } from '../packages/core/dist/index.js';
import { MemberHubClient, MemberUiAuth, HubUnavailable, HubProtocolError, joinHub, joinMember, memberConnection, verifySharedSession } from '../packages/mesh/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let app: Application; let server: Server; let base: string; let cookie: string; let passphrase: string; let redactor: SecretRedactor;
const empty = { schema: 'empty-request-v1' };
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-mesh-http-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  server = createDaemon({ application: app }); await listen(server); base = origin(server);
  const device = app.hub.get('devices', app.device.deviceId, DeviceSchema)!;
  app.hub.put('devices', app.device.deviceId, DeviceSchema, { ...device.document, url: base }, device.revision);
  passphrase = `fixture-${randomUUID()}`; redactor = new SecretRedactor();
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase }) });
  expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true }); });
async function listen(value: Server) { await new Promise<void>((resolve, reject) => { value.once('error', reject); value.listen(0, '127.0.0.1', () => { value.off('error', reject); resolve(); }); }); }
const origin = (value: Server) => `http://127.0.0.1:${(value.address() as AddressInfo).port}`;
function ui(path: string, value?: unknown) {
  return fetch(`${base}${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: base, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
function device(path: string, token: string, value?: unknown) {
  return fetch(`${base}/hub/mesh/${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
function heartbeat(deviceId: string): Heartbeat { return { schema: 'heartbeat-v1', deviceId, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } }; }
async function joinRequest(id = 'member') {
  const response = await ui('/hub/devices/invitations', empty); expect(response.status).toBe(200);
  const invite = JoinInvitationSchema.parse(await response.json());
  return { schema: 'join-device-v1', code: invite.code, requestId: `request_${id}`, device: { id, name: id, url: 'http://127.0.0.1:9773', os: 'linux', version: '0.1.0' } };
}
function client(joined: JoinedDevice, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  return new MemberHubClient({ hubUrl: base, hubName: 'Fixture hub', deviceId: joined.membership.device.id, token: () => joined.membership.token, redactor, ...options });
}
async function member(id = 'member') {
  const input = await joinRequest(id);
  const joined = await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, input);
  return { input, joined, connection: client(joined) };
}

function ownerIndex(ownerDeviceId: string) {
  app.hub.put('conversations', 'remote', ConversationIndexSchema, { schema: 'conversation-index-v1', id: 'remote', title: 'Remote history', projectId: 'project', ownerDeviceId, state: 'idle', updatedAt: new Date().toISOString() }, 0);
}
test('peer sessions bind source sign-in and target ownership without accepting the source cookie as a target login', async () => {
  const owner = await member('owner'); const viewer = await member('viewer'); ownerIndex('owner');
  const token = await viewer.connection.login({ schema: 'passphrase-input-v1', passphrase });
  const auth = new MemberUiAuth(owner.connection, () => owner.joined.authentication);
  const input = { schema: 'peer-session-input-v1', sourceDeviceId: 'viewer', conversationId: 'remote', token };
  expect(await auth.verify(token)).toBeNull(); expect(await auth.verifyPeer(input)).toBe(true);
  expect(await auth.verifyPeer({ ...input, sourceDeviceId: 'owner' })).toBe(false);
  await expect(viewer.connection.peerSession(input)).rejects.toMatchObject({ status: 409 });
  app.hubAuth.logout(token, 'viewer'); expect(await auth.verifyPeer(input)).toBe(false); expect(await auth.verifyPeer(input, true)).toBe(false);
});

test.each(['owner', 'viewer'])('peer streams reject a revoked %s device', async revoked => {
  const owner = await member('owner'); await member('viewer'); ownerIndex('owner');
  const auth = new MemberUiAuth(owner.connection, () => owner.joined.authentication);
  const input = { schema: 'peer-session-input-v1', sourceDeviceId: 'viewer', conversationId: 'remote', token: app.hubAuth.issue('viewer') };
  expect(await auth.verifyPeer(input)).toBe(true); app.devices.revoke(revoked);
  await expect(auth.verifyPeer(input)).rejects.toMatchObject({ status: 401 }); expect(await auth.verifyPeer(input, true)).toBe(false);
});

test('an admitted peer stream can survive a hub outage while new requests wait and revocation closes it on recovery', async () => {
  const owner = await member('owner'); await member('viewer'); ownerIndex('owner'); let offline = false;
  const connection = client(owner.joined, { fetch: async (...args) => { if (offline) throw new Error('Simulated hub outage.'); return fetch(...args); } });
  const auth = new MemberUiAuth(connection, () => owner.joined.authentication);
  const input = { schema: 'peer-session-input-v1', sourceDeviceId: 'viewer', conversationId: 'remote', token: app.hubAuth.issue('viewer') };
  expect(await auth.verifyPeer(input)).toBe(true); offline = true;
  await expect(auth.verifyPeer(input)).rejects.toBeInstanceOf(HubUnavailable); expect(await auth.verifyPeer(input, true)).toBe(true);
  app.hubAuth.logout(input.token, 'viewer'); offline = false; expect(await auth.verifyPeer(input, true)).toBe(false);
});

test('real HTTP join returns the shared signing material once per idempotent member and keeps normal responses redacted', async () => {
  const { input, joined, connection } = await member();
  expect(joined.authentication).toEqual(app.hubAuth.signingMaterial());
  expect((await joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor }, input)).membership.token).toBe(joined.membership.token);
  expect((await connection.devices()).currentDeviceId).toBe('member');
  expect((await connection.heartbeat(heartbeat('member'))).status).toBe('online');
  const publicResponse = await ui('/hub/devices/roster'); const body = await publicResponse.text();
  expect(body).not.toContain(joined.membership.token); expect(body).not.toContain(joined.authentication.key); expect(body).not.toContain(input.code);
  expect(publicResponse.headers.get('cache-control')).toBe('no-store');
  expect(redactor.text(`${joined.membership.token} ${joined.authentication.key}`)).toBe('[redacted] [redacted]');
  expect(JSON.stringify(app.hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all())).not.toContain(joined.authentication.key);
});

test('member operations require bearer authentication and reject browser origins, forged identity and wrong versions', async () => {
  const { joined } = await member();
  expect((await fetch(`${base}/hub/mesh/devices`, { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await device('devices', 'invalid')).status).toBe(401);
  expect((await fetch(`${base}/hub/mesh/devices`, { headers: { Origin: base, Authorization: `Bearer ${joined.membership.token}` } })).status).toBe(403);
  expect((await device('heartbeat', joined.membership.token, heartbeat(app.device.deviceId))).status).toBe(403);
  expect((await device('heartbeat', joined.membership.token, { ...heartbeat('member'), schema: 'heartbeat-v99' })).status).toBe(400);
  expect((await device('unknown', joined.membership.token)).status).toBe(404);
  expect((await fetch(`${base}/hub/devices/invitations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(empty) })).status).toBe(401);
});

test('remote UI sign-in binds to the member and logout revocation remains authoritative after reconstructing its auth object', async () => {
  const { joined, connection } = await member(); const auth = new MemberUiAuth(connection, () => joined.authentication);
  expect(() => auth.setup()).toThrow('managed by the hub');
  await expect(auth.login({ schema: 'passphrase-input-v1', passphrase: 'wrong fixture password' })).rejects.toMatchObject({ status: 401 });
  const token = await auth.login({ schema: 'passphrase-input-v1', passphrase });
  expect(app.hubAuth.verify(token)).toBeNull(); expect((await auth.verify(token))?.deviceId).toBe('member');
  expect(verifySharedSession(joined.authentication, token, 'another')).toBeNull();
  expect((await auth.state(token)).authenticated).toBe(true);
  await auth.logout(token);
  expect(verifySharedSession(joined.authentication, token, 'member')).not.toBeNull();
  expect(await new MemberUiAuth(connection, () => joined.authentication).verify(token)).toBeNull();
  const hubToken = cookie.slice(cookie.indexOf('=') + 1); expect(await auth.verify(hubToken)).toBeNull();
});

test('revoking a device while sign-in is deriving the passphrase prevents the response from issuing access', async () => {
  const { connection } = await member(); const original = app.hubAuth.login.bind(app.hubAuth);
  let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(app.hubAuth, 'login').mockImplementation(async (...args) => { begin(); await gate; return original(...args); });
  const pending = connection.login({ schema: 'passphrase-input-v1', passphrase });
  await started; app.devices.revoke('member'); finish();
  await expect(pending).rejects.toMatchObject({ status: 401 });
});

test('switching exchanges a target-bound grant for its own cookie and preserves the local route without another login', async () => {
  const { joined, connection } = await member(); await connection.heartbeat(heartbeat('member'));
  app.devices.heartbeat(app.device.deviceId, heartbeat(app.device.deviceId));
  const toMember = DeviceSwitchSchema.parse(await (await ui('/api/devices/switch', { schema: 'device-switch-input-v1', targetDeviceId: 'member', route: '/conversations/example?view=changes' })).json());
  const auth = new MemberUiAuth(connection, () => joined.authentication);
  const switched = await auth.consumeSwitch({ schema: 'consume-switch-v1', token: toMember.token });
  expect(switched.receipt.route).toBe('/conversations/example?view=changes'); expect((await auth.verify(switched.token))?.deviceId).toBe('member');
  await expect(auth.consumeSwitch({ schema: 'consume-switch-v1', token: toMember.token })).rejects.toMatchObject({ status: 401 });
  const toHub = await connection.issueSwitch({ schema: 'device-switch-input-v1', targetDeviceId: app.device.deviceId, route: '/settings/devices?from=member' });
  const response = await fetch(`${base}/switch?token=${toHub.token}`, { redirect: 'manual' });
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/settings/devices?from=member');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('cache-control')).toBe('no-store');
  const hubCookie = response.headers.get('set-cookie')!; expect(hubCookie).toContain('HttpOnly; SameSite=Strict');
  expect(app.hubAuth.verify(hubCookie.split(';')[0]!.slice('jevellan_session='.length))?.deviceId).toBe(app.device.deviceId);
  expect((await fetch(`${base}/switch?token=${toHub.token}`, { redirect: 'manual' })).status).toBe(401);
});

test('hub outages leave existing signed sessions unaccepted until the hub responds again', async () => {
  const { joined } = await member(); let offline = false;
  const connection = client(joined, { fetch: async (...args) => { if (offline) throw new Error('fixture connection refused'); return fetch(...args); } });
  const auth = new MemberUiAuth(connection, () => joined.authentication);
  const token = await auth.login({ schema: 'passphrase-input-v1', passphrase }); offline = true;
  expect(verifySharedSession(joined.authentication, token, 'member')).not.toBeNull();
  await expect(auth.verify(token)).rejects.toBeInstanceOf(HubUnavailable);
  await expect(connection.heartbeat(heartbeat('member'))).rejects.toThrow("Can't reach the hub (Fixture hub). This will continue when it's back.");
  await expect(auth.login({ schema: 'passphrase-input-v1', passphrase })).rejects.toBeInstanceOf(HubUnavailable);
  offline = false; expect((await auth.verify(token))?.deviceId).toBe('member');
});

test('the client refuses redirects, oversized bodies, malformed schemas and responses for another device', async () => {
  const { joined } = await member();
  for (const response of [
    new Response(null, { status: 307, headers: { Location: 'http://127.0.0.1:1/' } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({ schema: 'device-roster-v1', currentDeviceId: 'wrong', devices: [] }), { headers: { 'Content-Type': 'application/json' } }),
  ]) await expect(client(joined, { fetch: async () => response }).devices()).rejects.toBeInstanceOf(HubProtocolError);
  const wrong = { ...joined, membership: { ...joined.membership, device: { ...joined.membership.device, id: 'wrong' } } };
  await expect(joinHub({ hubUrl: base, hubName: 'Fixture hub', redactor, fetch: async () => new Response(JSON.stringify(wrong), { headers: { 'Content-Type': 'application/json' } }) }, await joinRequest('another'))).rejects.toBeInstanceOf(HubProtocolError);
});

test('a real HTTP response that never completes reaches the deadline without hanging the member', async () => {
  const { joined } = await member(); const slow = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); });
  await listen(slow);
  try {
    const connection = new MemberHubClient({ hubUrl: origin(slow), hubName: 'Slow fixture', deviceId: 'member', token: () => joined.membership.token, redactor, timeoutMs: 50 });
    await expect(connection.devices()).rejects.toBeInstanceOf(HubUnavailable);
  } finally { slow.closeAllConnections(); await new Promise<void>(resolve => slow.close(() => resolve())); }
});

test('join attempts are bounded and no code is consumed by an unauthenticated invitation request', async () => {
  for (let n = 0; n < 10; n++) {
    const response = await fetch(`${base}/hub/mesh/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'join-device-v1', code: '00000000', requestId: 'request_member', device: { id: 'member', name: 'Member', url: 'http://127.0.0.1:9773', os: 'linux', version: '0.1.0' } }) });
    expect(response.status).toBe(401);
  }
  expect((await fetch(`${base}/hub/mesh/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(empty) })).status).toBe(429);
  expect(app.devices.list()).toHaveLength(1);
});

test('member join writes private authentication files, reopens without a hub database and resumes after a lost response', async () => {
  const prepared = await joinRequest(); const homes = new Homes(join(root, 'member'), join(root, 'user'));
  const { name, url, os, version } = prepared.device; const device = { name, url, os, version };
  const input = { schema: 'member-join-input-v1', hubUrl: base, code: prepared.code, device };
  let loseResponse = true;
  const options = { redactor, fetch: (async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/join') && loseResponse) { loseResponse = false; await response.body?.cancel(); throw new Error('fixture response lost'); }
    return response;
  }) as typeof fetch };
  await expect(joinMember(homes, input, options)).rejects.toBeInstanceOf(HubUnavailable);
  expect(existsSync(homes.at('device.json'))).toBe(false);
  const plan = readDocument(homes.at('join-pending.json'), MemberJoinPlanSchema);
  expect(readFileSync(homes.at('join-pending.json'), 'utf8')).not.toContain(input.code);
  const registered = app.hub.get('devices', plan.device.id, DeviceSchema)!.document;
  const result = await joinMember(homes, input, options); expect(result.device.deviceId).toBe(registered.id);
  expect(existsSync(homes.at('join-pending.json'))).toBe(false); expect(existsSync(homes.at('hub'))).toBe(false);
  for (const name of ['device.token', 'ui-auth.json', 'hub-device.json', 'device.json']) expect(statSync(homes.at(name)).mode & 0o777).toBe(0o600);
  const opened = memberConnection(homes, { redactor });
  expect((await opened.client.devices()).currentDeviceId).toBe(plan.device.id);
  const session = await opened.auth.login({ schema: 'passphrase-input-v1', passphrase }); expect((await opened.auth.verify(session))?.deviceId).toBe(plan.device.id);
  expect((await joinMember(homes, input, { redactor })).device.deviceId).toBe(plan.device.id);
  expect(app.devices.list()).toHaveLength(2);
  chmodSync(homes.at('device.token'), 0o644); expect(() => memberConnection(homes, { redactor })).toThrow('private regular files');
});

test('a crash after saving a member token recovers the remaining files through authenticated hub access', async () => {
  const prepared = await joinRequest(); const homes = new Homes(join(root, 'member'), join(root, 'user'));
  const { name, url, os, version } = prepared.device; const device = { name, url, os, version };
  const input = { schema: 'member-join-input-v1', hubUrl: base, code: prepared.code, device };
  const completed = await joinMember(homes, input, { redactor });
  const tokenBefore = readFileSync(homes.at('device.token'), 'utf8');
  unlinkSync(homes.at('device.json')); unlinkSync(homes.at('ui-auth.json')); unlinkSync(homes.at('hub-device.json'));
  writeFileSync(homes.at('join-pending.json'), JSON.stringify({ schema: 'member-join-plan-v1', hubUrl: base, requestId: 'persisted_request', device: { id: completed.device.deviceId, ...device } }), { mode: 0o600 });
  const retry = await joinMember(homes, { ...input, code: '00000000' }, { redactor });
  expect(retry.device).toEqual(completed.device); expect(readFileSync(homes.at('device.token'), 'utf8')).toBe(tokenBefore);
  expect((await memberConnection(homes, { redactor }).client.devices()).devices).toHaveLength(2);
});

test('joining refuses a live daemon home and preserves an interrupted join when different settings are supplied', async () => {
  const prepared = await joinRequest(); const { name, url, os, version } = prepared.device; const device = { name, url, os, version };
  const input = { schema: 'member-join-input-v1', hubUrl: base, code: prepared.code, device };
  await expect(joinMember(app.homes, input, { redactor })).rejects.toThrow('already owns');
  const homes = new Homes(join(root, 'member'), join(root, 'user'));
  await expect(joinMember(homes, input, { redactor, fetch: async () => { throw new Error('offline'); } })).rejects.toBeInstanceOf(HubUnavailable);
  const original = readFileSync(homes.at('join-pending.json'), 'utf8');
  await expect(joinMember(homes, { ...input, device: { ...device, name: 'Changed' } }, { redactor })).rejects.toThrow('different join is pending');
  expect(readFileSync(homes.at('join-pending.json'), 'utf8')).toBe(original);
  expect(existsSync(homes.at('device.token'))).toBe(false);
});
