import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ErrorDocumentSchema } from '@jevellan/core';
import { AgentTargetSchema, createAgentMcpServer } from '@jevellan/agent-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Application } from './application.js';
import { AgentApiAdapter, AgentPeerRequestSchema, AgentPeerResultSchema, publicAgentData } from './agent-api.js';
import { requireOrigin } from './api.js';
import { json, requestBody } from './http.js';

type Origins = { allowedOrigins?: readonly string[]; proxyOrigin?: string };
function refuse(app: Application, response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  const candidate = error as { status?: unknown; message?: unknown };
  const status = typeof candidate?.status === 'number' && candidate.status >= 400 && candidate.status < 600 ? candidate.status : 400;
  if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="Jevellan MCP"');
  json(response, app.redactor.document(ErrorDocumentSchema.parse({ schema: 'error-v1', code: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'request-failed',
    message: error instanceof z.ZodError ? 'Check the submitted fields.' : typeof candidate.message === 'string' ? candidate.message : 'The agent request could not complete.' })), status);
}
/** Stateless Streamable HTTP: each MCP request is authenticated, and bounded watches recheck expiry/revocation while waiting. */
export async function handleAgentMcp(app: Application, request: IncomingMessage, response: ServerResponse, options: Origins): Promise<void> {
  let close: (() => Promise<void>) | undefined;
  try {
    requireOrigin(request, options.allowedOrigins ?? [], options.proxyOrigin);
    const authorization = request.headers.authorization; const grant = await app.agentAccess.authenticateBearer(authorization);
    if (!grant || !authorization) throw Object.assign(new Error('Connect with an agent token created in Settings → Agents.'), { status: 401 });
    const server = createAgentMcpServer(new AgentApiAdapter(app, grant, authorization));
    const transport = new StreamableHTTPServerTransport({});
    close = async () => { await transport.close(); await server.close(); };
    response.once('close', () => { void close?.().catch(() => undefined); });
    // SDK's Node wrapper declares optional callbacks as explicit undefined; its runtime transport implements this interface.
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, request.method === 'POST' ? await requestBody(request) : undefined);
  } catch (error) { await close?.().catch(() => undefined); refuse(app, response, error); }
}

/** A closed, bearer-authenticated operation relay; the receiving owner rechecks the grant and never forwards it again. */
export async function handleAgentPeer(app: Application, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw Object.assign(new Error('Use the agent connection for this request.'), { status: 403 });
    if (request.method !== 'POST') throw Object.assign(new Error('This operation does not support that method.'), { status: 405 });
    const authorization = request.headers.authorization; const grant = await app.agentAccess.authenticateBearer(authorization);
    if (!grant || !authorization) throw Object.assign(new Error('This agent connection is unavailable.'), { status: 401 });
    const input = AgentPeerRequestSchema.parse(await requestBody(request)); const adapter = new AgentApiAdapter(app, grant, authorization, true);
    const controller = new AbortController(); response.once('close', () => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    const data = input.kind === 'call' ? await adapter.call(input.operation, input.arguments, signal) : await adapter.events(AgentTargetSchema.parse(input.target), input.after, input.limit, signal);
    json(response, AgentPeerResultSchema.parse({ schema: 'agent-peer-result-v1', data: publicAgentData(app, data) }));
  } catch (error) { refuse(app, response, error); }
}
