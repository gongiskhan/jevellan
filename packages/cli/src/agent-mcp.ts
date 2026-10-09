import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, CallToolResultSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SecretRedactor, VERSION } from '@jevellan/core';

const environment = z.strictObject({ schema: z.literal('agent-mcp-environment-v1'), url: z.string().url(), token: z.string().min(32).max(4096) });

export function agentMcpEnvironment(env: NodeJS.ProcessEnv): { url: URL; token: string } {
  const value = environment.safeParse({ schema: 'agent-mcp-environment-v1', url: env.JEVELLAN_MCP_URL, token: env.JEVELLAN_MCP_TOKEN });
  if (!value.success) throw new Error('Set JEVELLAN_MCP_URL and JEVELLAN_MCP_TOKEN using a connection created in Settings → Agents.');
  const url = new URL(value.data.url);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('JEVELLAN_MCP_URL must be the HTTPS /mcp endpoint, or a loopback HTTP /mcp endpoint.');
  }
  return { url, token: value.data.token };
}

/** A remote owner-agent client. It never inherits a worker's scoped token or opens any native agent home. */
export async function serveAgentMcp(): Promise<void> {
  const { url, token } = agentMcpEnvironment(process.env);
  const redactor = new SecretRedactor(); redactor.add(token);
  const client = new Client({ name: 'jevellan-stdio', version: VERSION });
  client.onerror = () => {};
  const http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  // SDK HTTP classes explicitly include undefined in optional fields; their runtime implements the shared transport contract.
  try { await client.connect(http as Transport); }
  catch (error) { await client.close().catch(() => undefined); throw new Error(redactor.text(error instanceof Error ? error.message : 'Could not connect to Jevellan.')); }
  const capabilities = client.getServerCapabilities();
  const server = new Server({ name: 'jevellan-agent', version: VERSION }, { capabilities: {
    ...(capabilities?.tools ? { tools: {} } : {}), ...(capabilities?.resources ? { resources: {} } : {}), ...(capabilities?.prompts ? { prompts: {} } : {}),
  }, ...(client.getInstructions() === undefined ? {} : { instructions: client.getInstructions()! }) });
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => client.listTools(request.params, { signal: extra.signal }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const progressToken = request.params._meta?.progressToken;
      const response = await client.callTool(request.params, CallToolResultSchema, { signal: extra.signal, timeout: 45_000, maxTotalTimeout: 45_000,
        ...(progressToken === undefined ? {} : { onprogress: progress => { void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => undefined); } }) });
      return CallToolResultSchema.parse(redactor.document(response));
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: redactor.text(error instanceof Error ? error.message : 'The Jevellan tool request failed.') }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => client.listResources(request.params, { signal: extra.signal }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => client.listResourceTemplates(request.params, { signal: extra.signal }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => client.readResource(request.params, { signal: extra.signal }));
  server.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => client.listPrompts(request.params, { signal: extra.signal }));
  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => client.getPrompt(request.params, { signal: extra.signal }));
  const close = () => { void Promise.allSettled([server.close(), client.close()]); };
  process.stdin.once('end', close);
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await server.connect(new StdioServerTransport());
}
