import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DeviceSchema, Homes, deviceOrigin, localDeviceRoute, type Heartbeat, type JoinDeviceInput } from '../packages/core/dist/index.js';
import { DeviceRegistry, HubDatabase, devicePresence } from '../packages/mesh/dist/index.js';

let root: string; let homes: Homes; let hub: HubDatabase; let registry: DeviceRegistry; let now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-mesh-')); mkdirSync(join(root, 'user'));
  homes = new Homes(join(root, 'user', '.jevellan'), join(root, 'user')); hub = new HubDatabase(homes, 'hub');
  now = Date.parse('2026-09-24T12:00:00Z');
  hub.put('devices', 'hub', DeviceSchema, { schema: 'device-v1', id: 'hub', name: 'Hub', role: 'hub', url: 'http://127.0.0.1:9771', os: 'darwin', version: '0.1.0', joinedAt: new Date(now).toISOString() }, 0);
  registry = new DeviceRegistry(hub, 'hub', () => now);
});
afterEach(async () => { hub.close(); await rm(root, { recursive: true, force: true }); });
function request(id = 'member', code = registry.invite().code): JoinDeviceInput {
  return { schema: 'join-device-v1', code, requestId: `request_${id}`, device: { id, name: id, url: 'http://127.0.0.1:9773', os: 'linux', version: '0.1.0' } };
}
function heartbeat(deviceId = 'member', at = new Date(now).toISOString()): Heartbeat {
  return { schema: 'heartbeat-v1', deviceId, at, version: '0.2.0', runningConversations: ['conversation'], projects: [], externalSessions: [], load: { cpuPct: 15, memFreeMb: 1024 } };
}

test('joining consumes one expiring code, returns a stable retry credential, and survives reopening', () => {
  const input = request(); const joined = registry.join(input);
  expect(joined.device.role).toBe('member'); expect(joined.hub.id).toBe('hub');
  expect(registry.authenticate(joined.token).id).toBe('member');
  expect(registry.join(input)).toEqual(joined);
  expect(() => registry.join({ ...input, requestId: 'another_request' })).toThrow('already been used');
  expect(() => registry.join({ ...input, device: { ...input.device, url: 'http://127.0.0.1:9880' } })).toThrow('already been used');
  const rows = JSON.stringify(hub.db.prepare('SELECT document FROM documents UNION ALL SELECT document FROM secrets').all());
  expect(rows).not.toContain(joined.token); expect(rows).not.toContain(input.code);
  expect(hub.redactor.text(`${joined.token} ${input.code}`)).toBe('[redacted] [redacted]');
  hub.close(); hub = new HubDatabase(homes, 'hub'); registry = new DeviceRegistry(hub, 'hub', () => now);
  expect(registry.join(input)).toEqual(joined); expect(registry.authenticate(joined.token).id).toBe('member');
});

test('join expiration is exact, unknown codes fail, and existing device identities cannot be replaced', () => {
  const input = request(); now += 600_000;
  expect(() => registry.join(input)).toThrow('invalid or expired');
  expect(() => registry.join({ ...input, code: '00000000' })).toThrow('invalid or expired');
  const first = registry.join(request()); const duplicate = request('member');
  expect(() => registry.join(duplicate)).toThrow('already registered');
  expect(registry.authenticate(first.token)).toEqual(first.device);
  expect(() => registry.join(request('hub'))).toThrow('already registered');
  expect(() => registry.join({ ...request('another'), schema: 'join-device-v99' })).toThrow();
});

test('registration rolls back the member, encrypted token and consumption together on a failed database write', () => {
  const input = request();
  hub.db.exec("CREATE TEMP TRIGGER fail_registration BEFORE INSERT ON documents WHEN NEW.namespace='device-authorizations' BEGIN SELECT RAISE(ABORT, 'registration fixture interruption'); END");
  expect(() => registry.join(input)).toThrow('registration fixture interruption');
  expect(registry.list().map((view) => view.device.id)).toEqual(['hub']);
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(0);
  hub.db.exec('DROP TRIGGER fail_registration');
  expect(registry.join(input).device.id).toBe('member');
});

test('a second database connection sees consumed codes and cannot create another member with one', () => {
  const input = request(); const secondHub = new HubDatabase(homes, 'hub');
  try {
    const second = new DeviceRegistry(secondHub, 'hub', () => now);
    const joined = registry.join(input);
    expect(second.join(input).token).toBe(joined.token);
    expect(() => second.join(request('another', input.code))).toThrow('already been used');
    expect(second.list().map((view) => view.device.id)).toEqual(['hub', 'member']);
  } finally { secondHub.close(); }
});

test('nested write failure can be handled without losing outer writes, while outer failure rolls back all children', () => {
  hub.transaction(() => {
    registry.join(request('first'));
    expect(() => hub.transaction(() => { registry.join(request('discarded')); throw new Error('inner interruption'); })).toThrow('inner interruption');
    registry.join(request('second'));
  });
  expect(registry.list().map((view) => view.device.id)).toEqual(['first', 'hub', 'second']);
  expect(() => hub.transaction(() => { registry.join(request('outer_discarded')); throw new Error('outer interruption'); })).toThrow('outer interruption');
  expect(registry.list().map((view) => view.device.id)).toEqual(['first', 'hub', 'second']);
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(2);
});

test('revocation invalidates authentication, join retries and outstanding switches without deleting device history', () => {
  const input = request(); const joined = registry.join(input); registry.heartbeat('member', heartbeat());
  const issued = registry.issueSwitch('hub', { schema: 'device-switch-input-v1', targetDeviceId: 'member', route: '/' });
  registry.revoke('member'); registry.revoke('member');
  expect(() => registry.authenticate(joined.token)).toThrow('authentication failed');
  expect(() => registry.join(input)).toThrow('no longer authorized');
  expect(() => registry.heartbeat('member', heartbeat())).toThrow('no longer authorized');
  expect(() => registry.consumeSwitch('member', issued.token)).toThrow('no longer authorized');
  expect(registry.view('member')).toMatchObject({ revoked: true, status: 'offline', heartbeat: { runningConversations: ['conversation'] } });
  expect(hub.db.prepare('SELECT count(*) AS total FROM secrets').get()?.total).toBe(0);
  expect(() => registry.revoke('hub')).toThrow('cannot revoke itself');
  expect(() => registry.authenticate(randomBytes(32).toString('base64url'))).toThrow('authentication failed');
  expect(() => registry.authenticate('malformed')).toThrow('authentication failed');
});

test('heartbeat freshness uses receipt time, retains reported activity and cannot be written for a different device', () => {
  registry.join(request()); expect(registry.view('member').status).toBe('offline');
  const future = heartbeat('member', '2099-01-01T00:00:00Z');
  expect(registry.heartbeat('member', future)).toMatchObject({ status: 'online', device: { version: '0.2.0', lastHeartbeatAt: new Date(now).toISOString() }, heartbeat: { at: future.at } });
  expect(() => registry.heartbeat('member', heartbeat('hub'))).toThrow('another device');
  expect(registry.view('hub').heartbeat).toBeNull();
  now += 90_000; expect(registry.view('member').status).toBe('stale');
  now += 510_000; expect(registry.view('member').status).toBe('offline');
  registry.heartbeat('member', { ...heartbeat(), runningConversations: [], externalSessions: [] });
  expect(registry.view('member')).toMatchObject({ status: 'online', heartbeat: { runningConversations: [] } });
});

test('heartbeat metadata and the freshness timestamp roll back together', () => {
  registry.join(request()); registry.heartbeat('member', heartbeat()); const previous = registry.view('member');
  now += 10_000;
  hub.db.exec("CREATE TEMP TRIGGER fail_heartbeat BEFORE UPDATE ON documents WHEN NEW.namespace='devices' AND NEW.id='member' BEGIN SELECT RAISE(ABORT, 'heartbeat fixture interruption'); END");
  expect(() => registry.heartbeat('member', { ...heartbeat(), runningConversations: [] })).toThrow('heartbeat fixture interruption');
  expect(registry.view('member')).toEqual(previous);
});

test('freshness boundaries use the brief and missing, malformed or future timestamps never imply online', () => {
  const at = (age: number) => new Date(now - age).toISOString();
  expect(devicePresence(at(89_999), now)).toBe('online');
  expect(devicePresence(at(90_000), now)).toBe('stale');
  expect(devicePresence(at(599_999), now)).toBe('stale');
  expect(devicePresence(at(600_000), now)).toBe('offline');
  for (const value of [null, undefined, 'bad date', at(-1)]) expect(devicePresence(value, now)).toBe('offline');
});

test('switching preserves the route and consumes one target-bound token, including across restart', () => {
  registry.join(request()); registry.heartbeat('member', heartbeat());
  const issued = registry.issueSwitch('hub', { schema: 'device-switch-input-v1', targetDeviceId: 'member', route: '/conversations/example?view=changes#receipt' });
  expect(issued.targetUrl).toBe('http://127.0.0.1:9773');
  expect(() => registry.consumeSwitch('hub', issued.token)).toThrow('invalid or expired');
  expect(JSON.stringify(hub.db.prepare('SELECT document FROM documents').all())).not.toContain(issued.token);
  hub.close(); hub = new HubDatabase(homes, 'hub'); registry = new DeviceRegistry(hub, 'hub', () => now);
  now += 59_999;
  expect(registry.consumeSwitch('member', issued.token)).toEqual({ schema: 'device-switch-receipt-v1', sourceDeviceId: 'hub', targetDeviceId: 'member', route: '/conversations/example?view=changes#receipt' });
  expect(() => registry.consumeSwitch('member', issued.token)).toThrow('invalid or expired');
});

test('switches expire at sixty seconds, refuse offline targets and reject revoked sources', () => {
  registry.join(request()); const input = { schema: 'device-switch-input-v1', targetDeviceId: 'member', route: '/' };
  expect(() => registry.issueSwitch('hub', input)).toThrow('offline');
  registry.heartbeat('member', heartbeat()); const issued = registry.issueSwitch('hub', input);
  now += 60_000; expect(() => registry.consumeSwitch('member', issued.token)).toThrow('invalid or expired');
  registry.heartbeat('hub', heartbeat('hub'));
  const back = registry.issueSwitch('member', { ...input, targetDeviceId: 'hub' });
  registry.revoke('member'); expect(() => registry.consumeSwitch('hub', back.token)).toThrow('no longer authorized');
});

test('device URLs retain scheme and port distinctions and normalize paths without accepting credentialed origins', () => {
  expect(deviceOrigin('https://DEV.example.:9443/a?q=1#x')).toBe('https://dev.example:9443');
  expect(deviceOrigin('https://dev.example:9443')).not.toBe(deviceOrigin('https://dev.example:9771'));
  expect(deviceOrigin('http://100.64.0.1:9771/a')).toBe('http://100.64.0.1:9771');
  expect(deviceOrigin('http://127.0.0.1:9771')).toBe('http://127.0.0.1:9771');
  for (const url of ['https://user:secret@dev.example', 'ftp://dev.example', 'http://dev.example', 'http://100.128.0.1', 'invalid']) expect(deviceOrigin(url)).toBeNull();
});

test('device routes preserve local navigation and cannot redirect to another origin', () => {
  expect(localDeviceRoute('/conversations/example?x=1#step')).toBe('/conversations/example?x=1#step');
  expect(localDeviceRoute('/settings/../settings/devices')).toBe('/settings/devices');
  for (const route of ['//elsewhere.example', '/\\elsewhere.example', 'https://elsewhere.example', 'no-slash', '/%2Felsewhere.example', '/%5celsewhere.example', '/\r\nLocation:elsewhere', '/%0d%0a', '/\0', '/\x7f']) expect(localDeviceRoute(route)).toBeNull();
  registry.join(request()); registry.heartbeat('member', heartbeat());
  expect(() => registry.issueSwitch('hub', { schema: 'device-switch-input-v1', targetDeviceId: 'member', route: '//elsewhere.example' })).toThrow();
});
