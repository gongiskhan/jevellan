import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DeviceSchema, Homes, ProjectSchema, SecretRedactor } from '../packages/core/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { joinMember } from '../packages/mesh/dist/index.js';

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function serve(options: Parameters<typeof createDaemon>[0]) {
  const server = createDaemon(options); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  resources.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }); return server;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-agent-mesh-')); resources.push(() => rm(root, { recursive: true, force: true }));
  const makeHomes = (name: string) => { const path = join(root, name); mkdirSync(path); return new Homes(join(path, '.jevellan'), path); };
  const hub = new Application({ homes: makeHomes('hub'), timers: false, runtimes: () => new Map() }); resources.push(() => hub.close()); await hub.started;
  const hubServer = await serve({ application: hub }); const hubUrl = origin(hubServer);
  const device = hub.hub.get('devices', hub.device.deviceId, DeviceSchema)!; hub.hub.put('devices', hub.device.deviceId, DeviceSchema, { ...device.document, url: hubUrl }, device.revision);
  const passphrase = `fixture-${randomUUID()}`; const session = await hub.auth.setup({ schema: 'passphrase-input-v1', passphrase });
  const memberOptions: Parameters<typeof createDaemon>[0] = {}; const memberServer = await serve(memberOptions); const memberUrl = origin(memberServer); const homes = makeHomes('member');
  await joinMember(homes, { schema: 'member-join-input-v1', hubUrl, code: hub.mesh.invite().code, device: { name: 'Other device', url: memberUrl, os: process.platform, version: '0.1.0' } }, { redactor: new SecretRedactor() });
  const member = new Application({ homes, timers: false, runtimes: () => new Map() }); resources.push(() => member.close()); memberOptions.application = member; member.bindDaemonUrl(memberUrl); await member.started;
  await member.member!.heartbeat({ schema: 'heartbeat-v1', deviceId: member.device.deviceId, at: new Date().toISOString(), version: '0.1.0', runningConversations: [], projects: [], externalSessions: [], load: { cpuPct: 0, memFreeMb: 1024 } });
  hub.hub.put('projects', 'project', ProjectSchema, { schema: 'project-v1', id: 'project', name: 'Fixture project', paths: {}, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  return { hub, member, hubUrl, memberUrl, passphrase, session };
}
test('member UI token issuance uses hub vault and owner authentication while revocation is immediate across devices', { timeout: 30_000 }, async () => {
  const f = await fixture(); const memberSession = await f.member.auth.login({ schema: 'passphrase-input-v1', passphrase: f.passphrase }, 'fixture');
  const headers = { Cookie: `jevellan_session=${memberSession}`, Origin: f.memberUrl, 'Content-Type': 'application/json' };
  const input = { schema: 'agent-access-create-v1', clientRequestId: 'member_connection', label: 'Remote agent', projectIds: ['project'] };
  const response = await fetch(`${f.memberUrl}/api/agent-access`, { method: 'POST', headers, body: JSON.stringify(input) }); expect(response.status).toBe(201);
  const result = await response.json() as { token: string; connection: { id: string } };
  expect(await f.hub.agentAccess.authenticateBearer(`Bearer ${result.token}`)).toMatchObject({ connectionId: result.connection.id });
  expect(await f.member.agentAccess.authenticateBearer(`Bearer ${result.token}`)).toMatchObject({ projectIds: ['project'] });
  const list = await fetch(`${f.memberUrl}/api/agent-access`, { headers: { Cookie: headers.Cookie } }); expect(await list.text()).not.toContain(result.token);
  const repeated = await fetch(`${f.memberUrl}/api/agent-access`, { method: 'POST', headers, body: JSON.stringify(input) }); expect(await repeated.json()).toMatchObject({ created: false });
  await f.hub.agentAccess.revoke(result.connection.id, f.session);
  expect(await f.member.agentAccess.authenticateBearer(`Bearer ${result.token}`)).toBeNull(); expect(await f.member.agentAccess.isActive(result.connection.id)).toBe(false);
  await f.member.auth.logout(memberSession);
  await expect(f.member.agentAccess.create({ ...input, clientRequestId: 'logged_out' }, memberSession)).rejects.toMatchObject({ status: 401 });
});
test('a hub MCP client follows a member coordinator through the scoped peer protocol without native session or token leakage', { timeout: 30_000 }, async () => {
  const f = await fixture(); await f.member.projectHub.assignCoordinator('project', f.member.device.deviceId, 0);
  f.member.projectWork.coordinatorLedger('project').append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Message from the other device.' } });
  const result = await f.hub.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId: 'external_client', label: 'Outside agent', projectIds: ['project'] }, f.session);
  const external = new Client({ name: 'fixture-external', version: '1' }); resources.push(() => external.close());
  await external.connect(new StreamableHTTPClientTransport(new URL(`${f.hubUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${result.token}` } } }) as Transport);
  const watched = await external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'project' } } });
  expect(watched.isError).not.toBe(true); expect(JSON.stringify(watched)).toContain('Message from the other device.'); expect(JSON.stringify(watched)).not.toContain(result.token);
  const posted = vi.spyOn(f.member.projectWork, 'postMessage');
  const sent = await external.callTool({ name: 'jevellan_coordinator_send', arguments: { projectId: 'project', clientMessageId: 'from_external', text: 'Continue this work.' } });
  expect(sent.isError).not.toBe(true); expect(posted).toHaveBeenCalledWith('project', { schema: 'coordinator-message-request-v1', clientMessageId: 'from_external', text: 'Continue this work.' });
  await f.hub.agentAccess.revoke(result.connection.id, f.session);
  await expect(external.listTools()).rejects.toThrow();
});
test('managed apps and isolated memory use the connected device by default and route an explicit device within project scope', { timeout: 30_000 }, async () => {
  const f = await fixture();
  const result = await f.hub.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId: 'resource_client', label: 'Resource agent', projectIds: ['project'] }, f.session);
  const external = new Client({ name: 'fixture-resources', version: '1' }); resources.push(() => external.close());
  await external.connect(new StreamableHTTPClientTransport(new URL(`${f.hubUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${result.token}` } } }) as Transport);
  const localApps = vi.spyOn(f.hub.projectWork.apps, 'list'); const remoteApps = vi.spyOn(f.member.projectWork.apps, 'list');
  const local = await external.callTool({ name: 'jevellan_apps_list', arguments: { projectId: 'project' } });
  expect(local.isError).not.toBe(true); expect(localApps).toHaveBeenCalledWith('project'); expect(remoteApps).not.toHaveBeenCalled();
  const remote = await external.callTool({ name: 'jevellan_apps_list', arguments: { projectId: 'project', deviceId: f.member.device.deviceId } });
  expect(remote.isError).not.toBe(true); expect(remote.structuredContent).toMatchObject({ data: { schema: 'project-apps-v1', apps: [] } }); expect(remoteApps).toHaveBeenCalledWith('project');
  const memory = vi.spyOn(f.member.conversations, 'memory').mockRejectedValue(new Error('Simulated isolated memory is unavailable.'));
  const stop = vi.spyOn(f.member.projectWork.apps, 'stop').mockRejectedValue(new Error('Simulated app is not running.'));
  for (const [name, args] of [
    ['jevellan_memory_search', { query: 'fixture' }],
    ['jevellan_memory_read', { permalink: 'fixture-note' }],
    ['jevellan_app_stop', { appId: 'fixture-app' }],
  ] as const) {
    const routed = await external.callTool({ name, arguments: { projectId: 'project', deviceId: f.member.device.deviceId, ...args } });
    expect(routed.isError).toBe(true); expect(JSON.stringify(routed)).toContain('Simulated');
  }
  expect(memory).toHaveBeenCalledTimes(2); expect(memory).toHaveBeenCalledWith('project'); expect(stop).toHaveBeenCalledWith('project', 'fixture-app');
  const unavailable = await external.callTool({ name: 'jevellan_apps_list', arguments: { projectId: 'project', deviceId: 'unknown-device' } });
  expect(unavailable.isError).toBe(true); expect(JSON.stringify(unavailable)).toContain('unavailable');
  const denied = await external.callTool({ name: 'jevellan_memory_search', arguments: { projectId: 'outside-scope', deviceId: f.member.device.deviceId, query: 'fixture' } });
  expect(denied.isError).toBe(true); expect(memory).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([remote, unavailable, denied])).not.toContain(result.token);
});
