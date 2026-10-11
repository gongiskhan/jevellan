import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { afterEach, expect, test } from 'vitest';
import { nativePreToolUse } from '../packages/runtime-contract/dist/index.js';
import type { NativeLaunchSetup } from '../packages/core/dist/index.js';
import { codexMcpServers } from '../runtimes/codex/dist/configuration.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
test('stdio native MCP receives only its explicit secrets, without inherited Jevellan or provider tokens', async () => {
  const key = 'JEVELLAN_NATIVE_MCP_0123456789abcdef';
  const script = 'process.stdout.write(JSON.stringify({own:process.env.FIXTURE_TOKEN==="private-fixture", provider:!!process.env.CLAUDE_CODE_OAUTH_TOKEN, bridge:!!process.env.JEVELLAN_STRETCH_TOKEN, argv:process.argv.slice(1)}))';
  const input = { schema: 'native-mcp-launch-v1', command: process.execPath, args: ['-e', script], env: { FIXTURE_TOKEN: 'private-fixture' } };
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../packages/runtime-contract/dist/native-mcp.js', import.meta.url)), key], { env: { PATH: process.env.PATH, HOME: tmpdir(), CLAUDE_CODE_OAUTH_TOKEN: 'fixture-provider', JEVELLAN_STRETCH_TOKEN: 'fixture-bridge', [key]: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += String(bytes); }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error('The fixture transport failed.')));
  });
  expect(JSON.parse(result)).toEqual({ own: true, provider: false, bridge: false, argv: [] });
});
test('HTTP native MCP discovers and calls tools with ephemeral header authentication', async () => {
  let authorized = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer private-fixture') { response.writeHead(401).end(); return; }
    authorized++;
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part as Buffer));
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (body.id === undefined) { response.writeHead(202).end(); return; }
    const result = body.method === 'initialize' ? { protocolVersion: body.params?.protocolVersion, serverInfo: { name: 'fixture-http', version: '1' }, capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'say-hello', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'Hello from the fixture.' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
  const key = 'JEVELLAN_NATIVE_MCP_0123456789abcdef', input = { schema: 'native-mcp-launch-v1', args: [], env: {}, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer private-fixture' } };
  const settings = codexMcpServers({ native: { command: process.execPath, args: [fileURLToPath(new URL('../packages/runtime-contract/dist/native-mcp.js', import.meta.url)), key] } });
  const configured = settings.native!, inherited: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: tmpdir(), [key]: JSON.stringify(input), UNRELATED_PRIVATE_TOKEN: 'must-not-forward' };
  const forwarded = Object.fromEntries(['PATH', 'HOME', ...configured.env_vars].flatMap(name => inherited[name] === undefined ? [] : [[name, inherited[name]!]]));
  const transport = new StdioClientTransport({ command: configured.command, args: configured.args, env: forwarded, stderr: 'pipe' });
  expect(JSON.stringify(settings)).not.toContain('private-fixture'); expect(forwarded).not.toHaveProperty('UNRELATED_PRIVATE_TOKEN');
  const client = new Client({ name: 'fixture', version: '1' });
  try {
    await client.connect(transport); expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['say-hello']);
    expect(await client.callTool({ name: 'say-hello', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'Hello from the fixture.' }] });
    expect(authorized).toBeGreaterThanOrEqual(4);
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const protectedHooks = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') || process.platform === 'linux' && existsSync('/usr/bin/bwrap');
test('SSE native MCP preserves authenticated tool discovery through the stdio proxy', async () => {
  const remote = new McpServer({ name: 'fixture-sse', version: '1' }); remote.registerTool('say-hello', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'Hello over SSE.' }] }));
  let transport: SSEServerTransport | undefined;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer private-fixture') { response.writeHead(401).end(); return; }
    if (request.method === 'GET' && request.url === '/sse') { transport = new SSEServerTransport('/messages', response); void remote.connect(transport).catch(() => response.end()); }
    else if (request.method === 'POST' && transport) { void transport.handlePostMessage(request, response).catch(() => response.end()); }
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as AddressInfo).port;
  const key = 'JEVELLAN_NATIVE_MCP_0123456789abcdef', input = { schema: 'native-mcp-launch-v1', args: [], env: {}, transport: 'sse', url: `http://127.0.0.1:${port}/sse`, headers: { Authorization: 'Bearer private-fixture' } };
  const client = new Client({ name: 'fixture', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../packages/runtime-contract/dist/native-mcp.js', import.meta.url)), key], env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), [key]: JSON.stringify(input) }, stderr: 'pipe' }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['say-hello']);
    expect(await client.callTool({ name: 'say-hello', arguments: {} })).toMatchObject({ content: [{ text: 'Hello over SSE.' }] });
  } finally { await client.close(); await remote.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.skipIf(!protectedHooks)('native hooks can deny and add context, but cannot write native homes or a coordinator checkout', async () => {
  root = mkdtempSync(join(tmpdir(), 'jevellan-native-hook-')); const user = join(root, 'user'), home = join(root, 'account'), cwd = join(root, 'project');
  for (const dir of [join(user, '.claude'), home, cwd]) mkdirSync(dir, { recursive: true });
  const nativeFile = join(user, '.claude', 'CLAUDE.md'), projectFile = join(cwd, 'code.txt'); writeFileSync(nativeFile, 'Original'); writeFileSync(projectFile, 'Original');
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const setup = (command: string): NativeLaunchSetup => ({ schema: 'native-launch-setup-v1', instructions: '', settings: {}, plugins: [], userHome: user, hooks: [{ matcher: 'Read', commands: [command] }] });
  const options = { home, cwd, writable: false, env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-provider' } };
  expect(await nativePreToolUse(setup('exit 2'), { tool_name: 'Read' }, options)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  const output = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', additionalContext: 'Use the project rules.' } });
  const result = await nativePreToolUse(setup(`printf changed > ${quote(nativeFile)}; printf changed > ${quote(projectFile)}; printf %s ${quote(output)}`), { tool_name: 'Read' }, options);
  expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Use the project rules.\n' } });
  expect(readFileSync(nativeFile, 'utf8')).toBe('Original'); expect(readFileSync(projectFile, 'utf8')).toBe('Original');
  expect(await nativePreToolUse(setup('exit 2'), { tool_name: 'Write' }, options)).toEqual({});
});
