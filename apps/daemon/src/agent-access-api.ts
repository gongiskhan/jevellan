import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentAccessCapabilitiesSchema, AgentAccessCreateSchema, AgentAccessListSchema, EmptySchema, IdSchema } from '@jevellan/core';
import type { Application } from './application.js';
import { json, requestBody } from './http.js';

/** Called only after the existing signed owner session and origin checks. */
export async function handleAgentAccessApi(app: Application, request: IncomingMessage, response: ServerResponse, url: URL, ownerSession: string): Promise<boolean> {
  const method = request.method ?? 'GET'; const path = url.pathname;
  const mcpUrl = `${app.device.url.replace(/\/$/, '')}/mcp`;
  if (path === '/api/agent-access') {
    if (method === 'GET') { json(response, app.redactor.document(AgentAccessListSchema.parse({ schema: 'agent-access-list-v1', connections: await app.agentAccess.list(ownerSession), mcpUrl }))); return true; }
    if (method === 'POST') {
      const result = await app.agentAccess.create(AgentAccessCreateSchema.parse(await requestBody(request)), ownerSession);
      // Returning the freshly minted token is necessary to connect the external agent; no saved token can be retrieved later.
      json(response, { ...result, connection: app.redactor.document(result.connection) }, result.created ? 201 : 200); return true;
    }
    throw Object.assign(new Error('This operation does not support that method.'), { status: 405 });
  }
  if (path === '/api/agent-access/capabilities' && method === 'GET') {
    json(response, AgentAccessCapabilitiesSchema.parse({ schema: 'agent-access-capabilities-v1', mcpUrl, authentication: 'bearer', tokenShownOnce: true,
      stdioCommand: 'jevellan mcp-server', environment: { url: 'JEVELLAN_MCP_URL', token: 'JEVELLAN_MCP_TOKEN' },
      supports: ['projects', 'conversations', 'threads', 'coordinators', 'messages', 'decisions', 'notebooks', 'mail', 'pull-requests', 'apps', 'resumable-output'] })); return true;
  }
  const revoke = path.match(/^\/api\/agent-access\/([A-Za-z0-9_-]+)\/revoke$/);
  if (revoke && method === 'POST') { EmptySchema.parse(await requestBody(request)); json(response, app.redactor.document(await app.agentAccess.revoke(IdSchema.parse(revoke[1]), ownerSession))); return true; }
  return false;
}
