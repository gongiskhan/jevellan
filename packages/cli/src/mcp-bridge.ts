import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeRequestSchema, BridgeResultSchema, BridgeToolsSchema, ErrorDocumentSchema, SecretRedactor, VERSION } from '@jevellan/core';

/** A stdio proxy only: the daemon owns scope, validation and memory access. */
export async function serveMcpBridge(): Promise<void> {
  const token = process.env.JEVELLAN_STRETCH_TOKEN;
  const address = process.env.JEVELLAN_DAEMON_URL;
  if (!token || !address) throw new Error('The Jevellan bridge requires a scoped launch environment.');
  const base = new URL(address);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('The Jevellan bridge must connect to its local owner daemon.');
  const endpoint = new URL('/api/bridge', base);
  const redactor = new SecretRedactor(); redactor.add(token);
  const forward = async (raw: unknown, signal: AbortSignal) => {
    const request = BridgeRequestSchema.parse(raw);
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = ErrorDocumentSchema.safeParse(data);
      throw new Error(error.success ? redactor.text(error.data.message) : 'The owner daemon refused this tool request.');
    }
    return data;
  };
  // Dynamic tool lists follow the owner’s permissions, including repair turns.
  const server = new Server({ name: 'jevellan', version: VERSION }, { capabilities: { tools: {} } });
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const response = BridgeToolsSchema.parse(await forward({ schema: 'bridge-request-v1', operation: 'list' }, extra.signal));
    return { tools: response.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const response = BridgeResultSchema.parse(await forward({ schema: 'bridge-request-v1', operation: 'call', name: request.params.name, arguments: request.params.arguments ?? {} }, extra.signal));
      return { content: [{ type: 'text' as const, text: JSON.stringify(response.result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: redactor.text(error instanceof Error ? error.message : 'The tool request failed.') }] };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once('end', () => { void server.close(); });
}
