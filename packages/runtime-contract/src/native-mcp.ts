import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Credentials arrive only in the child's environment, never native config files or command arguments.
const Input = z.strictObject({ schema: z.literal('native-mcp-launch-v1'), command: z.string().optional(), args: z.array(z.string()),
  env: z.record(z.string(), z.string()), url: z.url().optional(), transport: z.enum(['http', 'sse']).optional(), headers: z.record(z.string(), z.string()).optional() });
async function main(): Promise<void> {
  const key = process.argv[2]; if (!key || !/^JEVELLAN_NATIVE_MCP_[a-f0-9]{16}$/u.test(key)) throw new Error('Invalid native MCP environment reference.');
  const input = Input.parse(JSON.parse(process.env[key] ?? ''));
  const inherited = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR']);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && inherited.has(entry[0])));
  if (input.command) {
    const child = spawn(input.command, input.args, { env: { ...env, ...input.env }, stdio: ['inherit', 'inherit', 'ignore'] });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal); });
    child.on('error', () => { process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; }); return;
  }
  if (!input.url) throw new Error('A native MCP needs a supported transport.');
  const client = new Client({ name: 'jevellan-native-transport', version: '1.0.0' });
  const options = { requestInit: input.headers ? { headers: input.headers } : {} };
  await client.connect((input.transport === 'sse' ? new SSEClientTransport(new URL(input.url), options) : new StreamableHTTPClientTransport(new URL(input.url), options)) as Transport);
  const server = new Server({ name: 'jevellan-native-transport', version: '1.0.0' }, { capabilities: client.getServerCapabilities() ?? {} });
  server.fallbackRequestHandler = request => client.request({ method: request.method, ...(request.params ? { params: request.params } : {}) }, ResultSchema);
  server.fallbackNotificationHandler = notification => client.notification(notification);
  server.onclose = () => { void client.close(); };
  server.onerror = () => {}; client.onerror = () => {};
  await server.connect(new StdioServerTransport());
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { void Promise.all([server.close(), client.close()]); });
}
void main().catch(() => { process.stderr.write('Native MCP transport is unavailable.\n'); process.exitCode = 1; });
