import { expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Homes, ProjectSchema } from '@jevellan/core';
import { AgentWatchResultSchema } from '@jevellan/agent-mcp';
import { Application, createDaemon } from '../apps/daemon/dist/index.js';

test('the real stdio command proxies an isolated HTTP daemon, streams formatted progress and cancels only the listener', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'jevellan-agent-stdio-')); mkdirSync(join(root, 'user'));
  const app = new Application({ homes: new Homes(join(root, 'user', '.jevellan'), join(root, 'user')), timers: false, runtimes: () => new Map() });
  await app.started;
  const server = createDaemon({ application: app });
  const external = new Client({ name: 'fixture-stdio-client', version: '1' });
  let stderr = '';
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app.hub.put('projects', 'fixture_project', ProjectSchema, { schema: 'project-v1', id: 'fixture_project', name: 'Fixture project', paths: {}, branchPolicy: 'external', memory: { mode: 'device', dir: '.jevellan/memory' }, context: { state: 'none' } }, 0);
    const owner = await app.auth.setup({ schema: 'passphrase-input-v1', passphrase: 'isolated-stdio-fixture-passphrase' });
    const created = await app.agentAccess.create({ schema: 'agent-access-create-v1', clientRequestId: 'stdio_connection', label: 'Stdio fixture', projectIds: ['fixture_project'] }, owner);
    const args = [resolve('bin/jevellan.mjs'), 'mcp-server'];
    const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe', env: {
      HOME: join(root, 'user'), JEVELLAN_MCP_URL: `${address}/mcp`, JEVELLAN_MCP_TOKEN: created.token!,
    } });
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    await external.connect(transport);
    expect(JSON.stringify(args)).not.toContain(created.token!);
    expect((await external.listTools()).tools.some(tool => tool.name === 'jevellan_watch')).toBe(true);
    const discovered = await external.callTool({ name: 'jevellan_discover', arguments: {} }); expect(discovered.isError).not.toBe(true);
    expect(JSON.stringify(discovered)).toContain('fixture_project'); expect(JSON.stringify(discovered)).not.toContain(created.token!);
    const guide = (await external.readResource({ uri: 'jevellan://guide' })).contents[0];
    expect(guide && 'text' in guide ? guide.text : '').toContain('cursor');
    const ledger = app.projectWork.coordinatorLedger('fixture_project');
    ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: 'Formatted output from the actual daemon.' } });
    const messages: string[] = []; const progressCursors: string[] = [];
    const watched = await external.callTool({ name: 'jevellan_watch', arguments: { target: { kind: 'project', projectId: 'fixture_project' }, limit: 2, streamMs: 2000 } }, undefined,
      { onprogress: progress => {
        messages.push(progress.message ?? '');
        const meta = (progress as { _meta?: Record<string, unknown> })._meta;
        const streamed = AgentWatchResultSchema.safeParse(meta?.['jevellan/output']); if (streamed.success) progressCursors.push(streamed.data.cursor);
        if (messages.length === 1) ledger.append({ type: 'coordinator-text', data: { schema: 'coordinator-text-v1', text: ' A second live chunk.' } });
      } });
    expect(watched.isError).not.toBe(true);
    const result = AgentWatchResultSchema.parse((watched.structuredContent as { data: unknown }).data);
    expect(result.markdown).toContain('Formatted output from the actual daemon.'); expect(messages.join('\n')).toContain(' A second live chunk.'); expect(progressCursors).toHaveLength(2);
    expect(result.events.map(row => row.id)).toEqual([1, 2]); expect(progressCursors.at(-1)).toBe(result.cursor);
    const control = vi.spyOn(app.projectWork, 'postMessage'); const stop = vi.spyOn(app.projectWork, 'stopCoordinator');
    const controller = new AbortController();
    const waiting = external.callTool({ name: 'jevellan_watch', arguments: { target: result.target, cursor: result.cursor, waitMs: 30_000 } }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(waiting).rejects.toThrow();
    expect(control).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(ledger.events().at(-1)?.id).toBe(2);
    expect(stderr).not.toContain(created.token!); expect(stderr).not.toContain('JEVELLAN_MCP_TOKEN');
  } finally {
    await external.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true });
  }
});
