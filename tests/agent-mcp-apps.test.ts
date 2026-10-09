import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Homes, ProjectSchema, ThreadSchema, type ProjectApp } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { AgentApiAdapter } from '../apps/daemon/dist/agent-api.js';

let root: string; let directory: string; let foreign: string; let app: Application; let server: Server; let base: string; let cookie: string;
const clients: Client[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-agent-app-boundary-'));
  directory = join(root, 'allowed'); foreign = join(root, 'denied');
  for (const path of [directory, foreign, join(root, 'user')]) mkdirSync(path);
  writeFileSync(join(directory, 'index.html'), '<script src="/app.js"></script>Allowed static app');
  writeFileSync(join(directory, 'app.js'), 'console.log("allowed")');
  writeFileSync(join(foreign, 'index.html'), 'Foreign project');
  writeFileSync(join(foreign, 'private.json'), '{"project":"denied"}');
  symlinkSync(join(foreign, 'private.json'), join(directory, 'escape.json'));
  symlinkSync(foreign, join(directory, 'escape-directory'));
  app = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), timers: false, runtimes: () => new Map([['fake', new FakeRuntime([])]]) });
  await app.started;
  server = createDaemon({ application: app });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) });
  cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  for (const [id, path] of [['allowed', directory], ['denied', foreign]] as const) app.hub.put('projects', id, ProjectSchema,
    { schema: 'project-v1', id, name: id, paths: { [app.device.deviceId]: path }, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
  const at = new Date().toISOString();
  app.projectWork.store.create(ThreadSchema.parse({ schema: 'project-thread-v1', id: 'app_thread', projectId: 'allowed', title: 'Serve app', task: 'Serve the registered static app',
    createdAt: at, createdBy: 'owner', state: 'idle', isolation: 'main', gitPolicy: 'external', ownerDeviceId: app.device.deviceId, coordinatorDeviceId: app.device.deviceId,
    cwd: directory, baseBranch: 'main', baseCommit: 'fixture', turns: 0, turnAllowance: 5, queuedMessages: [], verificationAttempts: 0,
    placement: { schema: 'placement-v1', questionSet: 'p-v1', source: 'fixed', fixed: [], isolation: 'main', runtime: 'fake', modelId: 'fixture_model', model: 'fixture-model',
      effortRequested: 'medium', effortEffective: 'medium', deviceId: app.device.deviceId, accountId: 'fixture_account', eligibleModels: ['fixture_model'], excludedModels: [],
      eligibleDevices: [app.device.deviceId], excludedDevices: [], jevCalls: [], decidedAt: at } }), { modelLabel: 'Fixture model', accountLabel: 'Fixture account' });
});
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await app.close(); await rm(root, { recursive: true, force: true });
});
async function connection(allProjects: boolean) {
  const response = await fetch(`${base}/api/agent-access`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'agent-access-create-v1', label: 'App fixture agent', clientRequestId: `connect_${randomUUID()}`, ...(allProjects ? {} : { projectIds: ['allowed'] }) }) });
  expect(response.status).toBe(201); return await response.json() as { token: string };
}
async function client(token: string) {
  const result = new Client({ name: 'fixture-app-client', version: '1' }); clients.push(result);
  await result.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as Transport);
  return result;
}
const starts = { projectId: 'allowed', threadId: 'app_thread', clientRequestId: 'start_app' };
const cases = [false, true].flatMap(allProjects => (['sdk', 'adapter', 'peer'] as const).map(route => ({ allProjects, route })));

test.each(cases)('external app start refuses executable inputs before launching ($route, all projects: $allProjects)', async ({ allProjects, route }) => {
  const { token } = await connection(allProjects); const external = route === 'sdk' ? await client(token) : undefined;
  const grant = await app.agentAccess.authenticateBearer(`Bearer ${token}`);
  const api = new AgentApiAdapter(app, grant!, `Bearer ${token}`);
  const launch = vi.spyOn(app.projectWork.apps, 'start');
  const marker = join(foreign, 'outside-project-marker.txt');
  const script = `import {writeFileSync} from 'node:fs'; import {createServer} from 'node:http'; writeFileSync(${JSON.stringify(marker)}, 'unexpected external write'); createServer((req,res)=>res.end('ready')).listen(Number(process.env.PORT),process.env.HOST);`;
  for (const executable of [
    { kind: 'command', command: process.execPath, args: ['--input-type=module', '-e', script] },
    { kind: 'static', command: process.execPath },
    { kind: 'static', args: [] },
  ]) {
    const arguments_ = { ...starts, ...executable }; let refused = false;
    if (route === 'sdk') refused = (await external!.callTool({ name: 'jevellan_app_start', arguments: arguments_ })).isError === true;
    else if (route === 'adapter') { try { await api.call('app_start', arguments_, AbortSignal.timeout(10_000)); } catch { refused = true; } }
    else {
      const response = await fetch(`${base}/api/agent-peer`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema: 'agent-peer-request-v1', kind: 'call', operation: 'app_start', arguments: arguments_ }) });
      refused = !response.ok; await response.body?.cancel();
    }
    expect(existsSync(marker), 'External app input must not write outside its project.').toBe(false);
    expect(refused, 'Executable app arguments must be rejected on every external route.').toBe(true);
    expect(launch).not.toHaveBeenCalled();
  }
  expect(app.projectWork.apps.list('allowed')).toEqual([]);
});

test.each([false, true])('external static app start returns a working reusable URL and enforces file boundaries (all projects: %s)', async allProjects => {
  const { token } = await connection(allProjects); const external = await client(token);
  const offered = (await external.listTools()).tools.find(tool => tool.name === 'jevellan_app_start')!;
  expect(offered.inputSchema.properties).not.toHaveProperty('command'); expect(offered.inputSchema.properties).not.toHaveProperty('args');
  const launched = await external.callTool({ name: 'jevellan_app_start', arguments: starts });
  expect(launched.isError).not.toBe(true);
  const served = (launched.structuredContent as { data: ProjectApp }).data;
  expect(served).toMatchObject({ projectId: 'allowed', threadId: 'app_thread', kind: 'static', state: 'running' });
  expect(await (await fetch(served.url)).text()).toContain('Allowed static app');
  expect(await (await fetch(served.url + 'app.js')).text()).toContain('console.log("allowed")');
  const repeated = await external.callTool({ name: 'jevellan_app_start', arguments: { ...starts, kind: 'static' } });
  expect(repeated.isError).not.toBe(true); expect((repeated.structuredContent as { data: ProjectApp }).data).toEqual(served);
  for (const outside of [foreign, '../denied', 'escape-directory']) {
    expect((await external.callTool({ name: 'jevellan_app_start', arguments: { ...starts, directory: outside } })).isError).toBe(true);
  }
  expect((await fetch(served.url + 'escape.json')).status).toBe(404);
  const listed = await external.callTool({ name: 'jevellan_apps_list', arguments: { projectId: 'allowed' } });
  expect(listed.isError).not.toBe(true); expect((listed.structuredContent as { data: { apps: ProjectApp[] } }).data.apps).toEqual([served]);
  const stopped = await external.callTool({ name: 'jevellan_app_stop', arguments: { projectId: 'allowed', appId: served.id } });
  expect(stopped.isError).not.toBe(true); expect((stopped.structuredContent as { data: ProjectApp }).data.state).toBe('stopped');
  await expect(fetch(served.url)).rejects.toThrow();
});
