import { afterEach, expect, test } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OWNER_TOOLS } from '../packages/core/dist/index.js';
import { projectFixture, type ProjectFixture } from './helpers/project-fixture.js';

let f: ProjectFixture | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close().catch(() => undefined); client = undefined; await f?.close(); f = undefined; });
async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'bin', 'jevellan.mjs'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, cwd: f!.checkout, stderr: 'ignore' });
  client = new Client({ name: 'contract', version: '1.0.0' }); await client.connect(transport); return client;
}

test('the forwarder lists exactly the twelve tools with their descriptions and forwards calls to the tool route', async () => {
  f = await projectFixture({ control: true });
  const mcp = await connect({ JEVELLAN_HOME: f.homes.root });
  const listed = (await mcp.listTools()).tools;
  expect(listed.map(tool => tool.name)).toEqual(['status', 'activity', 'ask_coordinator', 'work', 'goals', 'jobs', 'thread', 'respond', 'override', 'jev', 'config', 'login']);
  for (const tool of OWNER_TOOLS) expect(listed.find(row => row.name === tool.name)?.description).toBe(tool.description);
  expect((listed.find(row => row.name === "work")!.inputSchema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(['list', 'add', 'reorder', 'cancel', 'inspect']);
  expect((listed.find(row => row.name === 'ask_coordinator')!.inputSchema as unknown as { properties: { mode: { enum: string[] } } }).properties.mode.enum).toEqual(['ask', 'tell', 'restart']);
  expect(mcp.getServerCapabilities()?.experimental).toBeUndefined();
  const status = await mcp.callTool({ name: 'status', arguments: {} });
  expect(status.isError).toBeFalsy();
  expect((status.content as Array<{ text: string }>)[0]!.text).toContain('Nothing waiting on you.');
  const refused = await mcp.callTool({ name: 'work', arguments: { action: 'cancel', task: 'T9' } });
  expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: `T9 is not a task or thread of ${f.project.name}.` }] });
  const log = f.app.ownerTools.callerLog();
  expect(log.map(entry => [entry.tool, entry.action, entry.access, entry.ok])).toEqual([['status', 'status', 'read', true], ['work', 'cancel', 'write', false]]);
  expect(log.every(entry => entry.caller.startsWith('session:'))).toBe(true);
});

test('with a role set the forwarder registers zero tools; in the bridge it declares the channel', async () => {
  f = await projectFixture({ control: true });
  const guarded = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_ROLE: 'thread', JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: 'project' });
  expect((await guarded.listTools()).tools).toEqual([]);
  expect(guarded.getServerCapabilities()?.experimental).toBeUndefined();
  await guarded.close(); client = undefined;
  const bridge = await connect({ JEVELLAN_HOME: f.homes.root, JEVELLAN_BRIDGE: '1', JEVELLAN_PROJECT: f.project.name });
  expect(bridge.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
  expect((await bridge.listTools()).tools).toHaveLength(12);
  await bridge.callTool({ name: 'status', arguments: {} });
  expect(f.app.ownerTools.callerLog().at(-1)?.caller).toBe(`bridge:${f.project.name.replace(/[^A-Za-z0-9._-]/gu, '_')}`);
});

test('a forwarder without a running service says so in one sentence', async () => {
  f = await projectFixture();
  const mcp = await connect({ JEVELLAN_HOME: join(f.root, 'nowhere') });
  const result = await mcp.callTool({ name: 'status', arguments: {} });
  expect(result).toMatchObject({ isError: true, content: [{ text: 'Jevellan is not running on this device (no installation control file).' }] });
});
