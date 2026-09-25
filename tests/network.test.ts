import { afterEach, expect, test, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { DoctorControlSchema, Homes, doctorControlPath, readDocument } from '../packages/core/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import { closeListeners, detectTailscaleIpv4, listenOnInterfaces, tailscaleIpv4 } from '../apps/daemon/dist/network.js';

const servers: Server[] = []; const daemons: Awaited<ReturnType<typeof startDaemon>>[] = []; const roots: string[] = [];
afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.close())); await closeListeners(servers.splice(0)); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function homes() { const root = mkdtempSync(join(tmpdir(), 'jevellan-network-')); roots.push(root); mkdirSync(join(root, 'user')); return new Homes(join(root, 'home'), join(root, 'user')); }
test('Tailscale discovery accepts only one IPv4 address in its address range', () => {
  expect(tailscaleIpv4('100.64.0.1\n')).toBe('100.64.0.1'); expect(tailscaleIpv4('100.127.255.254')).toBe('100.127.255.254');
  for (const value of ['0.0.0.0', '127.0.0.1', '192.168.1.2', '100.63.1.1', '100.128.1.1', '100.64.0.256', '100.064.0.1', '100.64.0.1\n100.64.0.2', '::1']) expect(tailscaleIpv4(value)).toBeNull();
});
test('without Tailscale the daemon serves loopback, advertises its actual port and closes cleanly', async () => {
  const home = homes(); const daemon = await startDaemon(0, { homes: home, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(daemon);
  expect(daemon.addresses).toEqual([`http://127.0.0.1:${daemon.port}`]); expect(daemon.application.device.url).toBe(daemon.addresses[0]);
  expect((await fetch(`${daemon.addresses[0]}/api/health`)).status).toBe(200);
  expect(await (await fetch(`${daemon.addresses[0]}/api/auth`)).json()).toMatchObject({ configured: false, authenticated: false });
  await daemon.close(); expect(daemon.servers.every(server => !server.listening)).toBe(true);
  const reopened = await startDaemon(daemon.port, { homes: home, timers: false, runtimes: () => new Map(), tailscaleAddress: async () => null }); daemons.push(reopened); expect(reopened.port).toBe(daemon.port);
});
test('an occupied port is left running and a failed secondary bind releases only newly opened listeners', async () => {
  const existing = await listenOnInterfaces(() => createServer((_request, response) => response.end('Existing service')), 0, null); servers.push(...existing.servers);
  await expect(listenOnInterfaces(() => createServer(), existing.port, null)).rejects.toMatchObject({ code: 'EADDRINUSE' }); expect(await (await fetch(existing.addresses[0]!)).text()).toBe('Existing service');
  let selected = 0; let first: Server | undefined;
  await expect(listenOnInterfaces(() => {
    const server = createServer();
    if (!first) { first = server; server.once('listening', () => { selected = (server.address() as AddressInfo).port; }); }
    else vi.spyOn(server, 'listen').mockImplementation(() => { queueMicrotask(() => server.emit('error', Object.assign(new Error('Simulated unavailable interface'), { code: 'EADDRNOTAVAIL' }))); return server; });
    return server;
  }, 0, '100.64.0.1')).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
  expect(first?.listening).toBe(false); const reused = await listenOnInterfaces(() => createServer(), selected, null); servers.push(...reused.servers); expect(reused.port).toBe(selected);
});
test('the installed Tailscale address and loopback serve the same authenticated application', async context => {
  const address = await detectTailscaleIpv4(); if (!address) { context.skip(true, 'Tailscale IPv4 is unavailable on this machine.'); return; }
  const daemon = await startDaemon(0, { homes: homes(), timers: false, runtimes: () => new Map(), tailscaleAddress: async () => address }); daemons.push(daemon);
  expect(daemon.addresses).toEqual([`http://127.0.0.1:${daemon.port}`, `http://${address}:${daemon.port}`]); expect(daemon.application.device.url).toBe(daemon.addresses[1]);
  await daemon.application.auth.setup({ schema: 'passphrase-input-v1', passphrase: 'network-fixture-passphrase' });
  const response = await fetch(`${daemon.addresses[1]}/api/auth/login`, { method: 'POST', headers: { Origin: daemon.addresses[1]!, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'network-fixture-passphrase' }) });
  expect(response.status).toBe(200); const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(`${daemon.addresses[1]}/hub/devices/roster`, { headers: { Cookie: cookie } })).status).toBe(200); expect((await fetch(`${daemon.addresses[0]}/hub/devices/roster`, { headers: { Cookie: cookie } })).status).toBe(200);
  const control = readDocument(doctorControlPath(daemon.application.homes), DoctorControlSchema);
  expect((await fetch(`${daemon.addresses[1]}/api/local/doctor`, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'empty-request-v1' }) })).status).toBe(401);
});

test('the configured HTTPS proxy supports sign-in, authenticated settings and logout with secure cookies', async () => {
  const origin = 'https://fixture.tailtest.ts.net:10443', daemon = await startDaemon(0, { homes: homes(), timers: false, runtimes: () => new Map(), url: origin, tailscaleAddress: async () => null }); daemons.push(daemon);
  const headers = { Host: 'fixture.tailtest.ts.net:10443', Origin: origin, 'X-Forwarded-Host': 'fixture.tailtest.ts.net:10443', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json' };
  const response = await fetch(`${daemon.addresses[0]}/api/auth/setup`, { method: 'POST', headers, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'https-fixture-passphrase' }) });
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('; Secure');
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(`${daemon.addresses[0]}/hub/devices/roster`, { headers: { ...headers, Cookie: cookie } })).status).toBe(200);
  const logout = await fetch(`${daemon.addresses[0]}/api/auth/logout`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ schema: 'empty-request-v1' }) });
  expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('; Secure');
  const local = await fetch(`${daemon.addresses[0]}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'https-fixture-passphrase' }) });
  expect(local.status).toBe(200); expect(local.headers.get('set-cookie')).not.toContain('; Secure');
  for (const extra of [{ Origin: 'https://another.example' }, { 'X-Forwarded-Host': 'another.tailtest.ts.net:10443' }, { 'X-Forwarded-Proto': 'http' }, { 'X-Forwarded-Proto': 'https, http' }]) {
    expect((await fetch(`${daemon.addresses[0]}/api/auth/login`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: 'https-fixture-passphrase' }) })).status).toBe(403);
  }
});

test('HTTPS forwarding headers are refused on the direct Tailscale listener', async context => {
  const address = await detectTailscaleIpv4(); if (!address) { context.skip(true, 'Tailscale IPv4 is unavailable on this machine.'); return; }
  const origin = 'https://fixture.tailtest.ts.net', daemon = await startDaemon(0, { homes: homes(), timers: false, runtimes: () => new Map(), url: origin, tailscaleAddress: async () => address }); daemons.push(daemon);
  // Node fetch replaces Host; use the HTTP client to send the actual untrusted public host.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${daemon.addresses[1]}/api/auth`, { headers: { Host: 'fixture.tailtest.ts.net', 'X-Forwarded-Host': 'fixture.tailtest.ts.net', 'X-Forwarded-Proto': 'https' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject); request.end();
  });
  expect(status).toBe(403);
});
