import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Homes, MemoryNoteSchema, MemoryProposalSchema, StretchSchema, bridgeTools, projectMemoryHooks, projectToolNames, type Action, type BridgeTool, type IntegrationRunner } from '../packages/core/dist/index.js';
import { ConversationLedger, ConversationWork, type BridgeScopeTools, type ProjectMemory } from '../packages/conversations/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let homes: Homes; let app: Application; let server: Server; let base: string;
const clients: Client[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-bridge-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  app = new Application({ homes, timers: false, runtimes: () => new Map() }); server = createDaemon({ application: app });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await new Promise<void>((resolve) => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true });
});
function scoped(id: string, memoryWrite = false, action: Action = memoryWrite ? 'implement' : 'review', integration?: IntegrationRunner) {
  const work = new ConversationWork(new ConversationLedger(homes, id, { redactor: app.hub.redactor }));
  work.create({ title: id, projectId: id, ownerDeviceId: 'device' }); work.message(`Request for ${id}`, 'message'); work.baseCommit('base');
  const view = work.load();
  work.start(StretchSchema.parse({ schema: 'stretch-v2', n: 1, workId: view.conversation.work!.id, action, modelId: 'model', runtime: 'fake', model: 'fixture', effortRequested: 'high', effortEffective: 'high', accountId: 'acc_fixture', deviceId: 'device', decisionId: 'decision', startedAt: new Date().toISOString(), status: 'running', usage: { inputTokens: 0, outputTokens: 0, costSource: 'unknown' } }), view.conversation.generation);
  const note = MemoryNoteSchema.parse({ schema: 'memory-note-v1', title: `${id} memory`, permalink: `${id}/note`, content: `Memory belonging to ${id}` });
  const memory: ProjectMemory = { search: vi.fn(async () => ({ schema: 'memory-search-v1' as const, notes: [note] })), read: vi.fn(async (permalink) => { if (permalink !== note.permalink) throw new Error('No note in this project.'); return note; }), write: vi.fn(async () => note), edit: vi.fn(async () => note), assertOwnership: vi.fn() };
  const grant = app.bridges.issue({ work, stretch: 1, memoryWrite, memory, memoryCapture: () => true, ...(integration ? { integration } : {}) });
  return { ...grant, work, note, memory };
}
const call = (token: string, name: BridgeTool, args: unknown) => app.bridges.request(token, { schema: 'bridge-request-v1', operation: 'call', name, arguments: args });
function handoff(action = 'review') { return { schema: 'handoff-v2', stretch: 1, action, status: 'done', summary: 'Report with its full result.', evidence: [], findings: [], blockers: [], failedApproaches: [], proposedNext: null, changedFiles: [], result: { type: 'answer', content: '# Full result\nPreserve all details.' } }; }

test('tracked Git commands belong only to integration and stop at handoff or repair', async () => {
  const integration = vi.fn<IntegrationRunner>(async () => ({ schema: 'integration-status-v1', status: 'clean', conflicts: [] }));
  const ordinary = scoped('ordinary', true, 'implement', integration);
  const command = { schema: 'integration-command-v1', command: 'start' };
  expect(ordinary.tools.list().tools.some((tool) => tool.name === 'jevellan_integrate')).toBe(false);
  await expect(call(ordinary.token, 'jevellan_integrate', command)).rejects.toThrow('cannot use');
  expect(integration).not.toHaveBeenCalled();
  const active = scoped('integrating', true, 'integrate', integration);
  expect(await call(active.token, 'jevellan_integrate', command)).toMatchObject({ result: { status: 'clean' } });
  expect(integration).toHaveBeenCalledExactlyOnceWith('start');
  await call(active.token, 'jevellan_handoff', handoff('integrate'));
  await expect(call(active.token, 'jevellan_integrate', command)).rejects.toThrow('already handed off');
  const repairing = scoped('repairing', true, 'integrate', integration); await repairing.tools.repair();
  expect(repairing.tools.list().tools.some((tool) => tool.name === 'jevellan_integrate')).toBe(false);
  await expect(call(repairing.token, 'jevellan_integrate', command)).rejects.toThrow('cannot use');
  expect(integration).toHaveBeenCalledOnce();
});

test('read-only tools queue an idempotent memory proposal without changing project memory', async () => {
  const scope = scoped('reader'); const names = scope.tools.list().tools.map((tool) => tool.name);
  expect(names).toContain('memory_propose'); expect(names).not.toContain('memory_write'); expect(names).not.toContain('memory_edit');
  await expect(call(scope.token, 'memory_write', { title: 'No', content: 'No' })).rejects.toThrow('cannot use');
  const proposal = { title: 'Durable finding', content: 'The project uses globals.', reason: 'Avoid repeating a discovery.' };
  const first = await call(scope.token, 'memory_propose', proposal); expect(await call(scope.token, 'memory_propose', proposal)).toEqual(first);
  expect(scope.memory.write).not.toHaveBeenCalled(); expect(scope.memory.assertOwnership).not.toHaveBeenCalled();
  expect(scope.work.ledger.events().filter((event) => event.type === 'memory-queued')).toHaveLength(1);
});

test('memory writes require checkout ownership, and repair removes the bridge permission too', async () => {
  const scope = scoped('writer', true);
  vi.mocked(scope.memory.assertOwnership).mockRejectedValueOnce(new Error('Owned by another work.'));
  await expect(call(scope.token, 'memory_write', { title: 'Rule', content: 'Do this.' })).rejects.toThrow('another work');
  expect(scope.memory.write).not.toHaveBeenCalled();
  await call(scope.token, 'memory_write', { title: 'Rule', content: 'Do this.' }); expect(scope.memory.write).toHaveBeenCalledOnce();
  await scope.tools.repair(); expect(scope.tools.list().tools.map((tool) => tool.name)).not.toContain('memory_write');
  await expect(call(scope.token, 'memory_write', { title: 'Bad repair', content: 'No changes.' })).rejects.toThrow('cannot use');
  await expect(call(scope.token, 'memory_propose', { title: 'Bad repair', content: 'No changes.', reason: 'No' })).rejects.toThrow('cannot use');
  await call(scope.token, 'jevellan_handoff', handoff('implement'));
});

test('handoff inline content becomes a blob, retries keep the receipt, and later mutations are refused', async () => {
  const scope = scoped('handoff'); const payload = handoff();
  const first = await call(scope.token, 'jevellan_handoff', payload);
  const second = await call(scope.token, 'jevellan_handoff', payload);
  expect(first).toMatchObject({ result: { repeated: false } }); expect(second).toMatchObject({ result: { repeated: true } });
  const recorded = scope.work.ledger.handoffs()[0]!;
  expect(scope.work.ledger.readBlob(recorded.result!.ref)).toBe(payload.result.content);
  expect(scope.work.ledger.events().filter((event) => event.type === 'handoff')).toHaveLength(1);
  await expect(call(scope.token, 'jevellan_handoff', { ...payload, summary: 'Different second handoff.' })).rejects.toThrow('already handed off');
  await expect(call(scope.token, 'jevellan_finding', { claim: 'Late', pointer: 'src/test.ts' })).rejects.toThrow('already handed off');
});

test('scope fixes the conversation, stretch and project, and expiry invalidates every route', async () => {
  const a = scoped('project_a'); const b = scoped('project_b');
  expect(await call(a.token, 'memory_search', { query: 'memory' })).toMatchObject({ result: { notes: [{ content: 'Memory belonging to project_a' }] } });
  expect(await call(b.token, 'memory_search', { query: 'memory' })).toMatchObject({ result: { notes: [{ content: 'Memory belonging to project_b' }] } });
  await expect(call(a.token, 'memory_read', { permalink: 'project_b/note' })).rejects.toThrow('this project');
  await expect(call(a.token, 'jevellan_handoff', { ...handoff(), stretch: 2 })).rejects.toThrow('Use stretch 1 in jevellan_handoff.');
  expect(a.work.ledger.handoffs()).toHaveLength(0);
  await call(a.token, 'jevellan_handoff', handoff());
  expect(a.work.ledger.handoffs()[0]?.stretch).toBe(1);
  await expect(call(a.token, 'jevellan_conversation_read', { pointer: '../project_b/summary.json' })).rejects.toThrow('does not exist');
  await a.close(); await expect(call(a.token, 'memory_search', { query: 'memory' })).rejects.toMatchObject({ status: 401 });
  await expect(call('invalid', 'memory_search', { query: 'memory' })).rejects.toMatchObject({ status: 401 });
  expect(b.tools.list().tools.length).toBeGreaterThan(0);
});

test('other scopes share the registry, token rules and route, and stretch tokens cannot reach project tools', async () => {
  const stretch = scoped('stretch_scope');
  expect(stretch.tools.list().tools.map((tool) => tool.name)).not.toContain('jevellan_thread_report');
  await expect(call(stretch.token, 'jevellan_thread_report', { status: 'done', summary: 'Done.' })).rejects.toMatchObject({ status: 403, message: 'This step cannot use that tool.' });
  const calls: Array<[BridgeTool, unknown]> = []; let closed = 0;
  const tools: BridgeScopeTools = {
    list: () => bridgeTools(projectToolNames({ kind: 'thread', isolation: 'worktree' })),
    call: async (name, args) => { calls.push([name, args]); return { schema: 'bridge-result-v1', result: { schema: 'thread-report-result-v1', turn: 1, status: 'done', accepted: true, repeated: false } }; },
    capture: async () => ({ schema: 'bridge-result-v1', result: { queued: false, reason: 'disabled' } }),
    close: async () => { closed++; },
  };
  const grant = app.bridges.issueTools(tools); expect(grant.tools).toBe(tools);
  expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(app.bridges.redactor.text(`token ${grant.token}`)).not.toContain(grant.token);
  const post = (body: unknown) => fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.token}` }, body: JSON.stringify(body) });
  const listed = await post({ schema: 'bridge-request-v1', operation: 'list' });
  expect(listed.status).toBe(200); expect((await listed.json() as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read']);
  const reported = await post({ schema: 'bridge-request-v1', operation: 'call', name: 'jevellan_thread_report', arguments: { status: 'done', summary: 'Done.' } });
  expect(await reported.json()).toMatchObject({ result: { schema: 'thread-report-result-v1', accepted: true } });
  expect(calls).toEqual([['jevellan_thread_report', { status: 'done', summary: 'Done.' }]]);
  expect(await (await post({ schema: 'bridge-request-v1', operation: 'memory-capture', event: 'Stop' })).json()).toMatchObject({ result: { queued: false, reason: 'disabled' } });
  await grant.close(); expect(closed).toBe(1);
  const expired = await post({ schema: 'bridge-request-v1', operation: 'list' });
  expect(expired.status).toBe(401); expect(await expired.json()).toMatchObject({ message: 'Invalid or expired stretch token.' });
  expect(stretch.tools.list().tools.length).toBeGreaterThan(0);
});

test('scope shutdown drains an already-started write and rejects queued writes before ownership can be released', async () => {
  const scope = scoped('drain', true); let release!: () => void; let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(scope.memory.write).mockImplementation(async () => { started(); await pending; return scope.note; });
  const first = call(scope.token, 'memory_write', { title: 'One', content: 'One' }); await active;
  const second = call(scope.token, 'memory_write', { title: 'Two', content: 'Two' }).catch((error: unknown) => error);
  let closed = false; const closing = scope.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); release(); await first; await closing;
  expect(await second).toMatchObject({ status: 401 }); expect(scope.memory.write).toHaveBeenCalledOnce();
});

test('tool arguments are validated and credentials are redacted before any durable handoff content', async () => {
  const scope = scoped('private'); const secret = ['fixture', 'redaction', 'secret'].join('-'); app.hub.redactor.add(secret);
  await expect(call(scope.token, 'jevellan_handoff', { ...handoff(), status: 'invented' })).rejects.toThrow();
  expect(scope.work.ledger.handoffs()).toHaveLength(0);
  await call(scope.token, 'jevellan_handoff', { ...handoff(), result: { type: 'answer', content: `Never record ${secret}.` } });
  const recorded = scope.work.ledger.handoffs()[0]!;
  expect(scope.work.ledger.readBlob(recorded.result!.ref)).toBe('Never record [redacted].');
});

test('the actual stdio MCP command forwards two isolated scopes over authenticated HTTP', async () => {
  const scopes = [scoped('stdio_a'), scoped('stdio_b')];
  for (const scope of scopes) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/jevellan.mjs', import.meta.url)), 'mcp-bridge'], env: { PATH: process.env.PATH ?? '', HOME: homes.userHome, JEVELLAN_STRETCH_TOKEN: scope.token, JEVELLAN_DAEMON_URL: base }, stderr: 'pipe' });
    const client = new Client({ name: 'fixture', version: '1.0.0' }); clients.push(client); await client.connect(transport);
  }
  const lists = await Promise.all(clients.map((client) => client.listTools()));
  for (const list of lists) { expect(list.tools.map((tool) => tool.name)).toContain('jevellan_handoff'); expect(list.tools.map((tool) => tool.name)).not.toContain('memory_write'); }
  const replies = await Promise.all(clients.map((client) => client.callTool({ name: 'memory_search', arguments: { query: 'memory' } })));
  expect(replies[0]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('Memory belonging to stdio_a') }] });
  expect(replies[1]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('Memory belonging to stdio_b') }] });
  const receipt = await clients[0]!.callTool({ name: 'jevellan_handoff', arguments: handoff() }); expect(receipt.isError).not.toBe(true);
  expect(scopes[0]!.work.ledger.handoffs()).toHaveLength(1); expect(scopes[1]!.work.ledger.handoffs()).toHaveLength(0);
  await scopes[1]!.close(); const expired = await clients[1]!.callTool({ name: 'memory_search', arguments: { query: 'memory' } }); expect(expired.isError).toBe(true);
  expect((await fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'list' }) })).status).toBe(401);
}, 20_000);

const capture = (token: string, event = 'Stop') => app.bridges.request(token, { schema: 'bridge-request-v1', operation: 'memory-capture', event });
const proposals = (scope: ReturnType<typeof scoped>) => scope.work.ledger.events().filter((event) => event.type === 'memory-queued').map((event) => MemoryProposalSchema.parse(scope.work.ledger.data(event)));

test('concurrent lifecycle events queue one scoped metadata checkpoint, including after handoff', async () => {
  const a = scoped('hooks_a'); const b = scoped('hooks_b', true);
  await call(a.token, 'jevellan_handoff', handoff());
  const receipts = await Promise.all(['PreCompact', 'Stop', 'SessionEnd', 'Stop'].map((event) => capture(a.token, event)));
  expect(receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0]))).toBe(true);
  await capture(b.token);
  expect(proposals(a)).toHaveLength(1); expect(proposals(b)).toHaveLength(1);
  expect(proposals(a)[0]).toMatchObject({ source: 'hook', projectId: 'hooks_a', conversationId: 'hooks_a', stretch: 1 });
  expect(proposals(a)[0]!.content).toContain('not a completion or verification receipt');
  expect(proposals(b)[0]!.content).not.toContain('hooks_a');
  for (const scope of [a, b]) { expect(scope.memory.write).not.toHaveBeenCalled(); expect(scope.memory.assertOwnership).not.toHaveBeenCalled(); }
  expect(a.tools.list().tools.map((tool) => tool.name)).not.toContain('memory-capture');
});

test('capture obeys live runtime toggles, repair and expiry, and leaves answer-only replies unchanged', async () => {
  const answer = scoped('answer', false, 'reply'); expect(await capture(answer.token)).toMatchObject({ result: { queued: false, reason: 'answer-only' } }); expect(proposals(answer)).toEqual([]);
  const remember = scoped('remember', true, 'reply'); await capture(remember.token); expect(proposals(remember)).toHaveLength(1);
  const scope = scoped('disabled'); let enabled = false; scope.tools.scope.memoryCapture = () => enabled;
  expect(await capture(scope.token)).toMatchObject({ result: { queued: false, reason: 'disabled' } }); expect(proposals(scope)).toEqual([]);
  enabled = true; await scope.tools.repair(); expect(await capture(scope.token)).toMatchObject({ result: { queued: false, reason: 'repair' } });
  await scope.close(); await expect(capture(scope.token)).rejects.toMatchObject({ status: 401 }); expect(proposals(scope)).toEqual([]);
  await expect(capture(remember.token, 'SessionStart')).rejects.toThrow();
  await expect(app.bridges.request(remember.token, { schema: 'bridge-request-v1', operation: 'memory-capture', event: 'Stop', projectId: 'other' })).rejects.toThrow();
});

function runHook(command: string, payload: string, env: Record<string, string>) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile('/bin/sh', ['-c', command], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: homes.userHome, ...env }, timeout: 5000 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    child.stdin!.on('error', () => undefined); child.stdin!.end(payload);
  });
}

test('the installed hook command ignores transcripts and native identity, quotes paths and never adds recall', async () => {
  const scope = scoped('native_payload');
  const folder = join(root, "hook ' $(touch injected) `touch backtick`"); mkdirSync(folder);
  const entry = join(folder, 'entry.mjs'); symlinkSync(fileURLToPath(new URL('../bin/jevellan.mjs', import.meta.url)), entry);
  const config = projectMemoryHooks(process.execPath, entry); expect(Object.keys(config.hooks)).toEqual(['PreCompact', 'Stop', 'SessionEnd']);
  const command = config.hooks.Stop![0]!.hooks[0]!.command;
  const payload = { hook_event_name: 'Stop', cwd: '/wrong/project', session_id: 'native-private-id', transcript_path: '/private/must-not-open.jsonl', prompt: 'PRIVATE PROMPT', tool_input: 'PRIVATE COMMAND', last_assistant_message: 'PRIVATE RESPONSE', model: 'untrusted-model' };
  const result = await runHook(command, JSON.stringify(payload), { JEVELLAN_STRETCH_TOKEN: scope.token, JEVELLAN_DAEMON_URL: base });
  expect(result).toEqual({ stdout: '{}\n', stderr: '' }); expect(proposals(scope)).toHaveLength(1);
  const saved = JSON.stringify(proposals(scope));
  for (const value of Object.values(payload)) if (value !== 'Stop') expect(saved).not.toContain(value);
  expect(saved).not.toContain(scope.token); expect(saved).toContain('native_payload');
  expect(existsSync(join(root, 'injected'))).toBe(false); expect(existsSync(join(root, 'backtick'))).toBe(false);
  expect(readdirSync(homes.userHome)).toEqual([]);
}, 10_000);

test('missing scope, malformed or oversized input and rejected tokens fail without blocking or exposing input', async () => {
  const scope = scoped('bad_input'); const command = projectMemoryHooks().hooks.Stop![0]!.hooks[0]!.command;
  expect(await runHook(command, '{"hook_event_name":"Stop"}', {})).toEqual({ stdout: '{}\n', stderr: '' });
  const env = { JEVELLAN_STRETCH_TOKEN: scope.token, JEVELLAN_DAEMON_URL: base };
  for (const payload of ['private malformed input', JSON.stringify({ hook_event_name: 'Stop', prompt: 'x'.repeat(66_000) })]) {
    expect(await runHook(command, payload, env)).toEqual({ stdout: '{}\n', stderr: 'Project memory capture was not queued.\n' });
  }
  await scope.close(); expect(await runHook(command, '{"hook_event_name":"Stop"}', env)).toEqual({ stdout: '{}\n', stderr: 'Project memory capture was not queued.\n' });
  expect(proposals(scope)).toEqual([]);
}, 15_000);

test('an unresponsive queue is abandoned within the native shutdown hook deadline', async () => {
  const scope = scoped('slow_queue'); let received = false;
  const slow = createServer(() => { received = true; }); await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const started = performance.now();
  try {
    const result = await runHook(projectMemoryHooks().hooks.SessionEnd![0]!.hooks[0]!.command, '{"hook_event_name":"SessionEnd"}', { JEVELLAN_STRETCH_TOKEN: scope.token, JEVELLAN_DAEMON_URL: `http://127.0.0.1:${(slow.address() as AddressInfo).port}` });
    expect(received).toBe(true); expect(result).toEqual({ stdout: '{}\n', stderr: 'Project memory capture was not queued.\n' }); expect(performance.now() - started).toBeLessThan(3000);
    expect(proposals(scope)).toEqual([]);
  } finally { await new Promise<void>((resolve) => { slow.close(() => resolve()); slow.closeAllConnections(); }); }
}, 10_000);
