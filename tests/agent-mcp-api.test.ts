import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Homes, ProjectSchema, ThreadIndexSchema, ThreadReportSchema, ThreadStateChangeSchema } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../packages/runtime-contract/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';
import { AgentApiAdapter, publicAgentOutputData } from '../apps/daemon/dist/agent-api.js';
import { AgentWatchResultSchema, emptyAgentJournal, reconcileAgentJournal } from '@jevellan/agent-mcp';

let root: string; let app: Application; let server: Server; let base: string; let cookie: string;
const clients: Client[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-agent-mcp-api-')); mkdirSync(join(root, 'user'));
  app = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), timers: false, runtimes: () => new Map([['fake', new FakeRuntime([])]]) });
  await app.started;
  server = createDaemon({ application: app }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ schema: 'passphrase-input-v1', passphrase: `fixture-${randomUUID()}` }) }); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  for (const id of ['allowed', 'denied']) app.hub.put('projects', id, ProjectSchema, { schema: 'project-v1', id, name: id, paths: {}, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
});
afterEach(async () => { await Promise.allSettled(clients.splice(0).map(client => client.close())); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true }); });
const owner = (path: string, method = 'GET', value?: unknown) => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: base, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
async function connection(projectIds?: string[]) {
  return await (await owner('/api/agent-access', 'POST', { schema: 'agent-access-create-v1', label: 'Other coding agent', clientRequestId: `connect_${randomUUID()}`, ...(projectIds ? { projectIds } : {}) })).json() as { token: string; connection: { id: string } };
}
async function client(token: string) {
  const result = new Client({ name: 'fixture-agent-client', version: '1' }); clients.push(result);
  await result.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }) as Transport); return result;
}

test('owner UI creates once, never returns saved tokens, and refuses bearer management and foreign origins', async () => {
  expect((await fetch(`${base}/api/agent-access`)).status).toBe(401);
  const input = { schema: 'agent-access-create-v1', label: 'Fixture connection', clientRequestId: 'recover_create' };
  const initial = await owner('/api/agent-access', 'POST', input); expect(initial.status).toBe(201); const created = await initial.json() as { token: string; connection: { id: string } };
  const repeat = await owner('/api/agent-access', 'POST', input); expect(repeat.status).toBe(200); expect(await repeat.json()).toMatchObject({ created: false, connection: { id: created.connection.id } });
  expect(await (await owner('/api/agent-access')).text()).not.toContain(created.token);
  expect((await fetch(`${base}/api/agent-access`, { headers: { Authorization: `Bearer ${created.token}` } })).status).toBe(401);
  expect((await fetch(`${base}/api/agent-access`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(403);
  expect((await fetch(`${base}/mcp`, { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await fetch(`${base}/mcp`, { headers: { Authorization: 'Bearer unrelated_worker_capability' } })).status).toBe(401);
});
test('SDK Streamable HTTP client discovers a closed broad catalog, resources and provider/auto descriptions', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const tools = await external.listTools(); const names = tools.tools.map(tool => tool.name);
  expect(names).toContain('jevellan_thread_start'); expect(names).toContain('jevellan_job_start'); expect(names).toContain('jevellan_watch'); expect(names).toContain('jevellan_coordinator_override');
  expect(names.some(name => /(?:credential|daemon|login|attach|http_proxy)/.test(name))).toBe(false);
  const start = tools.tools.find(tool => tool.name === 'jevellan_thread_start')!; expect(start.description).toContain('automatic'); expect(start.inputSchema.properties).toHaveProperty('providerId'); expect(start.inputSchema.properties).toHaveProperty('accountId');
  const discovery = await external.callTool({ name: 'jevellan_discover', arguments: {} }); expect(discovery.isError).not.toBe(true);
  const serialized = JSON.stringify(discovery); expect(serialized).not.toContain(created.token); expect(serialized).not.toContain('secretRef'); expect(serialized).toContain('allowed'); expect(serialized).not.toContain('denied');
  expect((await external.listResources()).resources.some(resource => resource.uri === 'jevellan://guide')).toBe(true);
  const contents = (await external.readResource({ uri: 'jevellan://projects' })).contents;
  expect(contents.some(content => 'text' in content && typeof content.text === 'string' && content.text.includes('allowed'))).toBe(true);
});
test('project scope guards list, reads, writes, output watches and direct peer relay', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const listed = await external.callTool({ name: 'jevellan_projects_list', arguments: {} }); expect(JSON.stringify(listed)).not.toContain('denied');
  for (const [name, arguments_] of [
    ['jevellan_project_read', { projectId: 'denied' }],
    ['jevellan_coordinator_send', { projectId: 'denied', clientMessageId: 'foreign_message', text: 'Change this project' }],
    ['jevellan_notebook_write', { projectId: 'denied', expectedRevision: 0, content: 'Foreign update' }],
    ['jevellan_watch', { target: { kind: 'project', projectId: 'denied' } }],
  ] as const) expect((await external.callTool({ name, arguments: arguments_ })).isError).toBe(true);
  expect((await app.projectHub.notebook('denied'))).toBeNull(); expect(app.projectWork.coordinators.busy('denied')).toBe(false);
  const denied = await fetch(`${base}/api/agent-peer`, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'agent-peer-request-v1', kind: 'call', operation: 'notebook_write', arguments: { projectId: 'denied', expectedRevision: 0, content: 'Foreign update' } }) }); expect(denied.status).toBe(403);
});
test('watch replays durably, groups adjacent tools and revocation ends bounded waits', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const ledger = app.projectWork.coordinatorLedger('allowed');
  ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Working on this request.' } });
  const watched = await external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'allowed' }, waitMs: 0 } });
  expect(watched.isError).not.toBe(true); const body = watched.structuredContent as { data: { cursor: string; after: number; markdown: string } }; expect(body.data.markdown).toContain('Working on this request.');
  const empty = await external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'allowed' }, cursor: body.data.cursor } }); expect((empty.structuredContent as { data: { events: unknown[] } }).data.events).toEqual([]);
  const files = readdirSync(app.homes.at('agent-output')); expect(files).toHaveLength(1); expect(readFileSync(app.homes.at('agent-output', files[0]!), 'utf8')).not.toContain(created.token);
  const waiting = external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'allowed' }, cursor: body.data.cursor, waitMs: 30_000 } });
  await new Promise(resolve => setTimeout(resolve, 100)); expect((await owner(`/api/agent-access/${created.connection.id}/revoke`, 'POST', { schema: 'empty-request-v1' })).status).toBe(200);
  const stopped = await waiting; expect(stopped.isError).toBe(true); expect(JSON.stringify(stopped)).toContain('revoked');
  await expect(external.listTools()).rejects.toThrow();
});
test('an explicit forbidden project cannot start a job, and arbitrary adapter operations are absent', async () => {
  const created = await connection(['allowed']); const grant = await app.agentAccess.authenticateBearer(`Bearer ${created.token}`); const api = new AgentApiAdapter(app, grant!, `Bearer ${created.token}`);
  const launch = vi.spyOn(app.projectWork, 'createThread');
  await expect(api.call('thread_start', { projectId: 'denied', clientRequestId: 'job_denied', title: 'Forbidden', task: 'Edit', runtimeId: 'auto', modelId: 'auto', effort: 'auto' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 }); expect(launch).not.toHaveBeenCalled();
  await expect(api.call('credential', {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 404 });
});
test('tool starts pass explicit provider/account choices and leave automatic fields for Jev and normal guards', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const launch = vi.spyOn(app.projectWork, 'createThread').mockRejectedValue(Object.assign(new Error('Normal placement refused this fixture account.'), { status: 409 }));
  const refused = await external.callTool({ name: 'jevellan_thread_start', arguments: { projectId: 'allowed', clientRequestId: 'explicit_choices', title: 'Fixture job', task: 'Work', providerId: 'fake', accountId: 'selected_account', modelId: 'auto', effort: 'auto', isolation: 'auto' } });
  expect(refused.isError).toBe(true); expect(launch).toHaveBeenCalledWith('allowed', { schema: 'thread-create-request-v1', clientRequestId: 'explicit_choices', title: 'Fixture job', task: 'Work', runtimeId: 'fake', accountId: 'selected_account' });
  launch.mockClear();
  const conflict = await external.callTool({ name: 'jevellan_thread_start', arguments: { projectId: 'allowed', clientRequestId: 'conflicting_choices', title: 'Fixture job', task: 'Work', providerId: 'fake', runtimeId: 'other' } });
  expect(conflict.isError).toBe(true); expect(launch).not.toHaveBeenCalled();
});
test('external mail identifies the connection and reads without marking worker inboxes', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const input = { projectId: 'allowed', clientRequestId: 'send_external_mail', to: 'coordinator', subject: 'Progress update', body: 'Please tell me when the job has a link.' };
  const sent = await external.callTool({ name: 'jevellan_mail_send', arguments: input }); expect(sent.isError).not.toBe(true);
  const data = (sent.structuredContent as { data: { mail: { from: string; fromTitle?: string; readBy: string[] }; repeated: boolean } }).data;
  expect(data.mail.from).toBe(created.connection.id); expect(data.mail.fromTitle).toContain('Other coding agent'); expect(data.mail.readBy).toEqual([]); expect(data.repeated).toBe(false);
  const repeated = await external.callTool({ name: 'jevellan_mail_send', arguments: input }); expect((repeated.structuredContent as { data: { repeated: boolean } }).data.repeated).toBe(true);
  const listed = await external.callTool({ name: 'jevellan_mail_list', arguments: { projectId: 'allowed' } }); expect(listed.isError).not.toBe(true); expect(JSON.stringify(listed)).toContain('Progress update');
  expect((await app.agentAccess.mailList('allowed', undefined, `Bearer ${created.token}`)).mail[0]?.readBy).toEqual([]);
  const coordinatorEvents = app.projectWork.coordinatorLedger('allowed').events().filter(event => event.type === 'coordinator-event');
  expect(coordinatorEvents.filter(event => JSON.stringify(app.projectWork.coordinatorLedger('allowed').payload(event)).includes('Progress update'))).toHaveLength(1);
  expect((await external.callTool({ name: 'jevellan_mail_send', arguments: { ...input, projectId: 'denied', clientRequestId: 'forbidden_mail' } })).isError).toBe(true);
});
test('completed mail, names and lifecycle records retain ordinary text ending in a registered credential prefix', async () => {
  const fixtureSecret = ['e', 'mail-completed-fixture-credential'].join(''); app.redactor.add(fixtureSecret);
  const created = await connection(['allowed']); const external = await client(created.token);
  const subject = 'Progress update'; const body = 'Ready to serve';
  const sent = await external.callTool({ name: 'jevellan_mail_send', arguments: { projectId: 'allowed', clientRequestId: 'complete_content', to: 'coordinator', subject, body } });
  expect(sent.isError).not.toBe(true);
  expect(sent.structuredContent).toMatchObject({ data: { mail: { subject, body } } });
  const listed = await external.callTool({ name: 'jevellan_mail_list', arguments: { projectId: 'allowed' } });
  expect(listed.structuredContent).toMatchObject({ data: { mail: [{ subject, body }] } });
  const discovery = await external.callTool({ name: 'jevellan_discover', arguments: {} });
  expect(discovery.structuredContent).toMatchObject({ data: { providers: [{ label: app.runtimes.get('fake')!.displayName }] } });
  const project = app.hub.get('projects', 'allowed', ProjectSchema)!;
  app.hub.put('projects', 'allowed', ProjectSchema, { ...project.document, name: 'Fixture name' }, project.revision);
  const named = await external.callTool({ name: 'jevellan_project_read', arguments: { projectId: 'allowed' } });
  expect(named.structuredContent).toMatchObject({ data: { project: { name: 'Fixture name' } } });
  const indexed = ThreadIndexSchema.parse({ schema: 'project-thread-index-v1', revision: 1, id: 'title_fixture', projectId: 'allowed', title: 'Release update', state: 'done',
    isolation: 'worktree', ownerDeviceId: app.device.deviceId, runtime: 'fake', modelLabel: 'Fixture', effort: 'medium', accountLabel: 'Fixture', turns: 1,
    createdAt: '2026-10-09T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z' });
  expect(publicAgentOutputData(app, indexed)).toMatchObject({ title: 'Release update' });
  const ledger = app.projectWork.coordinatorLedger('allowed');
  ledger.append({ type: 'notice', data: { schema: 'project-notice-v1', kind: 'info', text: 'Ready to serve' } });
  const watched = await external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'allowed' }, limit: 200 } });
  expect(watched.isError).not.toBe(true); const output = AgentWatchResultSchema.parse((watched.structuredContent as { data: unknown }).data);
  expect(JSON.stringify(output.events)).toContain(subject); expect(JSON.stringify(output.events)).toContain(body);
  expect(output.events.find(event => event.kind === 'notice')?.text).toBe('Ready to serve');
  const all = await app.agentAccess.mailList('allowed', undefined, `Bearer ${created.token}`);
  const records = reconcileAgentJournal(emptyAgentJournal(), { redactor: app.redactor, ledger: [
    { id: 1, type: 'mail', data: all.mail[0] },
    { id: 2, type: 'thread-report', data: ThreadReportSchema.parse({ schema: 'thread-report-v1', turn: 1, status: 'done', summary: subject, synthesized: false }) },
    { id: 3, type: 'thread-state', data: ThreadStateChangeSchema.parse({ schema: 'thread-state-v1', from: 'running', to: 'done', reason: body, changed: [] }) },
  ] });
  expect(records.events.map(event => event.kind)).toEqual(['mail', 'report', 'status']);
  expect(records.events[0]?.data).toMatchObject({ subject, body });
  expect(records.events[1]?.text).toBe(subject); expect(records.events[2]?.text).toBe(body);
  vi.spyOn(app.agentAccess, 'mailList').mockResolvedValue({ ...all, mail: all.mail.map(mail => ({ ...mail, body: `Complete ${fixtureSecret} value` })) });
  const secret = await external.callTool({ name: 'jevellan_mail_list', arguments: { projectId: 'allowed' } });
  expect(JSON.stringify(secret)).not.toContain(fixtureSecret); expect(JSON.stringify(secret)).toContain('[redacted]');
});
test('coordinator override preserves unrelated limits and explicit auto clears saved provider/account/model choices', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  const first = await external.callTool({ name: 'jevellan_coordinator_override', arguments: { projectId: 'allowed', clientRequestId: 'select_coordinator', revision: 0, providerId: 'fake', accountId: 'fixture_account', modelId: 'fixture_model', effort: 'high' } });
  expect(first.isError).not.toBe(true);
  const selected = await app.projectWork.settingsView('allowed'); expect(selected.settings.coordinator).toEqual({ runtimeId: 'fake', accountId: 'fixture_account', modelId: 'fixture_model', effort: 'high' });
  const cleared = await external.callTool({ name: 'jevellan_coordinator_override', arguments: { projectId: 'allowed', clientRequestId: 'auto_coordinator', revision: selected.settings.revision, providerId: 'auto', accountId: 'auto', modelId: 'auto', effort: 'auto' } }); expect(cleared.isError).not.toBe(true);
  const automatic = await app.projectWork.settingsView('allowed'); expect(automatic.settings.coordinator).toEqual({ runtimeId: null, accountId: null, modelId: null, effort: 'medium' });
  expect(automatic.settings.maxRunningThreads).toBe(selected.settings.maxRunningThreads); expect(automatic.settings.defaultIsolation).toBe(selected.settings.defaultIsolation);
  expect((await external.callTool({ name: 'jevellan_coordinator_override', arguments: { projectId: 'allowed', clientRequestId: 'stale_coordinator', revision: selected.settings.revision, effort: 'max' } })).isError).toBe(true);
  expect((await app.projectWork.settingsView('allowed')).settings.coordinator.effort).toBe('medium');
});
test('ordinary service errors are redacted before MCP sends formatted failure text', async () => {
  const created = await connection(['allowed']); const external = await client(created.token);
  vi.spyOn(app.projectWork, 'postMessage').mockRejectedValue(new Error(`Simulated provider failure ${created.token}`));
  const failed = await external.callTool({ name: 'jevellan_coordinator_send', arguments: { projectId: 'allowed', clientMessageId: 'failure_redaction', text: 'Work' } });
  expect(failed.isError).toBe(true); expect(JSON.stringify(failed)).not.toContain(created.token); expect(JSON.stringify(failed)).toContain('[redacted]');
});
