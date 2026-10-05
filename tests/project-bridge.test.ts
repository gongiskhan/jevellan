// Thread and coordinator tool scopes through the actual stdio MCP command and the daemon's own bridge route (design 5.2.11):
// scope lists, cross-scope refusals, the one-report rule with identical retries (D19), field sentences, ended turns and expiry.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Homes, MemoryNoteSchema, projectToolNames } from '../packages/core/dist/index.js';
import { ProjectTools, type ProjectScope, type ProjectToolHandlers } from '../packages/projects/dist/index.js';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

let root: string; let homes: Homes; let app: Application; let server: Server; let base: string;
const clients: Client[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-project-bridge-')); mkdirSync(join(root, 'user')); homes = new Homes(join(root, 'data'), join(root, 'user'));
  app = new Application({ homes, timers: false, runtimes: () => new Map() }); server = createDaemon({ application: app });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await new Promise<void>((resolve) => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true });
});

/** A turn's tools registered on the daemon's shared registry, with stub handlers and a switch for "this turn is current". */
function issue(scope: ProjectScope) {
  const current = { value: true }; const calls: Array<[string, unknown]> = [];
  const note = MemoryNoteSchema.parse({ schema: 'memory-note-v1', title: `${scope.projectId} note`, permalink: `${scope.projectId}/note`, content: `Memory of ${scope.projectId}` });
  const handlers: ProjectToolHandlers = {
    isCurrent: () => current.value,
    call: async (_scope, name, input) => {
      calls.push([name, input]);
      if (name === 'jevellan_threads_list') return { schema: 'threads-list-result-v1', threads: [] };
      throw Object.assign(new Error('Not scripted.'), { status: 400 });
    },
    memory: () => ({ search: async () => ({ schema: 'memory-search-v1', notes: [note] }), read: async (permalink) => { if (permalink !== note.permalink) throw new Error('No note in this project.'); return note; } }),
  };
  const grant = app.bridges.issueTools(new ProjectTools(scope, handlers, app.redactor));
  return { ...grant, current, calls };
}
async function connect(token: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/jevellan.mjs', import.meta.url)), 'mcp-bridge'],
    env: { PATH: process.env.PATH ?? '', HOME: homes.userHome, JEVELLAN_STRETCH_TOKEN: token, JEVELLAN_DAEMON_URL: base }, stderr: 'pipe' });
  const client = new Client({ name: 'fixture', version: '1.0.0' }); clients.push(client); await client.connect(transport);
  return client;
}
type ToolReply = { isError?: boolean; content: Array<{ type: string; text: string }> };
const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> => await client.callTool({ name, arguments: args }) as ToolReply;
const result = (reply: ToolReply) => { expect(reply.isError).not.toBe(true); return JSON.parse(reply.content[0]!.text) as unknown; };
const refusal = (reply: ToolReply) => { expect(reply.isError).toBe(true); return reply.content[0]!.text; };

test('thread and coordinator scopes answer through the actual stdio MCP command with their own lists, one report per turn and scope refusals', async () => {
  const thread = issue({ kind: 'thread', projectId: 'proj_a', threadId: 'thread_a', turn: 3, isolation: 'worktree' });
  const coordinator = issue({ kind: 'coordinator', projectId: 'proj_b', turn: 1 });
  const [threadClient, coordinatorClient] = [await connect(thread.token), await connect(coordinator.token)];
  expect((await threadClient!.listTools()).tools.map((tool) => tool.name)).toEqual(['jevellan_thread_report', 'memory_search', 'memory_read']);
  const coordinatorTools = (await coordinatorClient!.listTools()).tools.map((tool) => tool.name);
  expect(coordinatorTools).toEqual(projectToolNames({ kind: 'coordinator' }));
  expect(coordinatorTools).not.toContain('jevellan_thread_report'); expect(coordinatorTools).toContain('jevellan_mail_send'); expect(coordinatorTools).not.toContain('jevellan_mail_inbox');

  // Memory reads stay in each scope's project.
  expect(JSON.stringify(result(await call(threadClient!, 'memory_search', { query: 'memory' })))).toContain('Memory of proj_a');
  expect(JSON.stringify(result(await call(coordinatorClient!, 'memory_search', { query: 'memory' })))).toContain('Memory of proj_b');

  // The report: invalid input is one sentence, the first valid report is accepted, an identical retry repeats, another is refused.
  expect(refusal(await call(threadClient!, 'jevellan_thread_report', { status: 'needs-decision', summary: 'Which store?' })))
    .toBe('question: A needs-decision report needs a question. Check the tool input.');
  const report = { status: 'done', summary: 'Added greeting.txt.', changedFiles: ['greeting.txt'] };
  expect(result(await call(threadClient!, 'jevellan_thread_report', report))).toEqual({ schema: 'thread-report-result-v1', turn: 3, status: 'done', accepted: true, repeated: false });
  expect(result(await call(threadClient!, 'jevellan_thread_report', report))).toEqual({ schema: 'thread-report-result-v1', turn: 3, status: 'done', accepted: true, repeated: true });
  expect(refusal(await call(threadClient!, 'jevellan_thread_report', { ...report, summary: 'Something else.' }))).toBe('This turn already reported. Put everything in one report.');
  expect(thread.tools.report).toMatchObject({ schema: 'thread-report-v1', turn: 3, status: 'done', summary: 'Added greeting.txt.', synthesized: false });

  // Cross-scope calls are refused; the coordinator's own tools reach its handler with parsed input.
  expect(refusal(await call(threadClient!, 'jevellan_threads_list', {}))).toBe('This turn cannot use that tool.');
  expect(refusal(await call(coordinatorClient!, 'jevellan_thread_report', report))).toBe('This turn cannot use that tool.');
  expect(result(await call(coordinatorClient!, 'jevellan_threads_list', {}))).toEqual({ schema: 'threads-list-result-v1', threads: [] });
  expect(coordinator.calls).toEqual([['jevellan_threads_list', { include: 'active' }]]); expect(thread.calls).toEqual([]);

  // Native memory hooks queue nothing for project scopes.
  const capture = await fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${thread.token}` },
    body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'memory-capture', event: 'Stop' }) });
  expect(await capture.json()).toEqual({ schema: 'bridge-result-v1', result: { queued: false, reason: 'disabled' } });

  // After the turn ends the token answers 401 with the ended-turn sentence; after close the registry no longer knows it.
  thread.current.value = false;
  expect(refusal(await call(threadClient!, 'memory_search', { query: 'memory' }))).toBe('This turn has ended. Report in your next turn.');
  await expect(threadClient!.listTools()).rejects.toThrow('This turn has ended. Report in your next turn.');
  await coordinator.close();
  expect(refusal(await call(coordinatorClient!, 'memory_search', { query: 'memory' }))).toBe('Invalid or expired stretch token.');
  const expired = await fetch(`${base}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${coordinator.token}` },
    body: JSON.stringify({ schema: 'bridge-request-v1', operation: 'list' }) });
  expect(expired.status).toBe(401);
  await thread.close();
}, 30_000);
