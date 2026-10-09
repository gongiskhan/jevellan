import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { VERSION } from '@jevellan/core';
import { AGENT_OPERATIONS } from './catalog.js';
import { AgentErrorSchema, AgentToolResultSchema, type AgentApi, type AgentWatchRequest } from './schemas.js';
import { formatAgentDocument } from './format.js';
import { watchAgentOutput } from './watch.js';

export const AGENT_MCP_GUIDE = `Jevellan runs independent coding jobs through registered projects and isolated accounts.

1. Call jevellan_discover and jevellan_projects_list to learn the actual capabilities, eligible providers/accounts/models/efforts and project IDs. IDs are stable Jevellan IDs. Never invent model IDs or copy native credentials.
2. Delegate project work with jevellan_coordinator_send, or a specific job with jevellan_thread_start. Ordinary conversation work uses jevellan_job_start. Start operations and messages require an ID chosen before the request; reuse that exact ID only to retry identical input. Auto is the default for every omitted choice. Explicit overrides still obey device, account, git and project limits.
3. Call jevellan_watch with a project, thread or conversation target. Save the returned cursor independently for each target and pass it unchanged on the next call. waitMs waits for the first batch; streamMs streams multiple incremental batches through standard progress notifications. Progress metadata under jevellan/output includes its resumable cursor and structured blocks. Total waiting is bounded to 30 seconds and limit bounds output to 200 events. hasMore means drain immediately. Watching and reading never restart work.
4. Output carries stable group IDs, block IDs, per-event offsets and replacement patches. Adjacent calls of the same tool share an area; thinking, text, status or another tool begins another group. Render Markdown directly or use structured blocks to update existing areas without duplicating previous output.
5. Read reports, open decisions, notebook and pull requests. Answer only decisions covered by the owner's instruction, steer jobs through messages, and return verified managed-app/PR links. Use normal guarded controls to stop, restart or override work. Disconnecting or cancelling watch stops the listener and leaves jobs running.

The external MCP connection is distinct from a worker's scoped mcp-bridge. It never exposes credentials, native sessions, arbitrary HTTP forwarding, or daemon start/stop/redeploy controls. Project access and revocation apply to every call and live wait.`;

/** A transport-neutral owner-agent suite. The daemon supplies scope-aware, schema-validating owner operations. */
export function createAgentMcpServer(api: AgentApi): Server {
  const supported = api.supportedOperations === undefined ? null : new Set(api.supportedOperations);
  const operations = AGENT_OPERATIONS.filter(row => supported === null || supported.has(row.name));
  const lookup = new Map(operations.map(row => [row.name, row]));
  const server = new Server({ name: 'jevellan-agent', version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: AGENT_MCP_GUIDE });
  server.onerror = () => {};
  const active = async () => { if (!await api.isActive()) throw new McpError(ErrorCode.InvalidRequest, 'This Jevellan connection has expired or been revoked.'); };
  const invoke = async (operation: string, arguments_: Record<string, unknown>, signal: AbortSignal) => {
    await active(); signal.throwIfAborted();
    if (!lookup.has(operation)) throw new McpError(ErrorCode.MethodNotFound, 'This Jevellan connection does not offer that operation.');
    return api.call(operation, arguments_, signal);
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await active();
    return { tools: operations.map(row => ({ name: `jevellan_${row.name}`, title: row.title, description: row.description,
      inputSchema: z.toJSONSchema(row.input) as { type: 'object' }, outputSchema: { ...z.toJSONSchema(z.union([AgentToolResultSchema, AgentErrorSchema])), type: 'object' as const },
      annotations: { readOnlyHint: row.readOnly, destructiveHint: row.destructive === true, idempotentHint: row.readOnly || row.idempotent === true, openWorldHint: !row.readOnly } })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      await active();
      const name = request.params.name.startsWith('jevellan_') ? request.params.name.slice('jevellan_'.length) : '';
      const row = lookup.get(name); if (!row) throw new Error('This Jevellan connection does not offer that tool.');
      const parsed = row.input.parse(request.params.arguments ?? {});
      const arguments_ = z.record(z.string(), z.unknown()).parse(parsed);
      let data: unknown;
      let markdown: string;
      if (name === 'watch') {
        const token = request.params._meta?.progressToken;
        const result = await watchAgentOutput(api, arguments_ as AgentWatchRequest, extra.signal,
          token === undefined ? undefined : async result => { await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: result.after, message: result.markdown, _meta: { 'jevellan/output': result } } }); });
        data = result; markdown = result.markdown;
      } else { data = await invoke(name, arguments_, extra.signal); markdown = formatAgentDocument(name, data); }
      const result = AgentToolResultSchema.parse({ schema: 'agent-tool-result-v1', operation: name, data, markdown });
      return { content: [{ type: 'text' as const, text: markdown }], structuredContent: result };
    } catch (error) {
      const message = error instanceof z.ZodError ? `Invalid tool arguments: ${error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
        : error instanceof Error ? error.message : 'The Jevellan tool request failed.';
      const result = AgentErrorSchema.parse({ schema: 'agent-error-v1', code: extra.signal.aborted ? 'cancelled' : 'refused', message });
      return { isError: true, content: [{ type: 'text' as const, text: result.message }], structuredContent: result };
    }
  });

  const resources = [
    { uri: 'jevellan://guide', name: 'Working with Jevellan', mimeType: 'text/markdown', description: 'Delegation, automatic choices, idempotency, organized output and guarded controls.' },
    { uri: 'jevellan://capabilities', name: 'Capabilities and selection options', mimeType: 'application/json', description: 'Available providers, accounts, models, efforts and limits.' },
    { uri: 'jevellan://projects', name: 'Accessible projects', mimeType: 'application/json' },
    { uri: 'jevellan://jobs', name: 'Conversation jobs', mimeType: 'application/json' },
  ].filter(row => row.uri === 'jevellan://guide' || lookup.has(row.uri === 'jevellan://capabilities' ? 'discover' : row.uri === 'jevellan://projects' ? 'projects_list' : 'jobs_list'));
  const templates = [
    { uriTemplate: 'jevellan://projects/{projectId}', name: 'Project work', mimeType: 'application/json', operation: 'project_read' },
    { uriTemplate: 'jevellan://projects/{projectId}/notebook', name: 'Project notebook', mimeType: 'application/json', operation: 'notebook_read' },
    { uriTemplate: 'jevellan://projects/{projectId}/threads/{threadId}', name: 'Project job', mimeType: 'application/json', operation: 'thread_read' },
    { uriTemplate: 'jevellan://jobs/{conversationId}', name: 'Conversation job', mimeType: 'application/json', operation: 'job_read' },
  ].filter(row => lookup.has(row.operation));
  server.setRequestHandler(ListResourcesRequestSchema, async () => { await active(); return { resources }; });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => { await active(); return { resourceTemplates: templates.map(row => ({ uriTemplate: row.uriTemplate, name: row.name, mimeType: row.mimeType })) }; });
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    await active(); const uri = request.params.uri;
    if (uri === 'jevellan://guide') return { contents: [{ uri, mimeType: 'text/markdown', text: AGENT_MCP_GUIDE }] };
    let operation: string | undefined; let args: Record<string, unknown> = {};
    if (uri === 'jevellan://capabilities') operation = 'discover';
    else if (uri === 'jevellan://projects') operation = 'projects_list';
    else if (uri === 'jevellan://jobs') operation = 'jobs_list';
    else {
      const project = uri.match(/^jevellan:\/\/projects\/([A-Za-z0-9_-]+)(?:\/(notebook|threads\/([A-Za-z0-9_-]+)))?$/u);
      const job = uri.match(/^jevellan:\/\/jobs\/([A-Za-z0-9_-]+)$/u);
      if (project) { operation = project[2] === 'notebook' ? 'notebook_read' : project[3] ? 'thread_read' : 'project_read'; args = { projectId: project[1], ...(project[3] ? { threadId: project[3] } : {}) }; }
      else if (job) { operation = 'job_read'; args = { conversationId: job[1] }; }
    }
    if (!operation) throw new McpError(ErrorCode.InvalidParams, 'That Jevellan resource does not exist.');
    const data = await invoke(operation, args, extra.signal);
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(AgentToolResultSchema.parse({ schema: 'agent-tool-result-v1', operation, data, markdown: formatAgentDocument(operation, data) })) }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    await active();
    return { prompts: [
      { name: 'delegate_project_work', description: 'Guide a task through Jevellan with automatic or explicit choices and follow its organized output.', arguments: [{ name: 'projectId', required: true }, { name: 'task', required: true }] },
      { name: 'follow_jevellan_work', description: 'Follow project/job messages and act on authorized questions while preserving resumable output.', arguments: [{ name: 'target', required: true }] },
    ] };
  });
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    await active(); const args = request.params.arguments ?? {};
    if (request.params.name === 'delegate_project_work') {
      const input = z.strictObject({ projectId: z.string().min(1).max(200), task: z.string().min(1).max(20_000) }).parse(args);
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${AGENT_MCP_GUIDE}\n\nProject: ${input.projectId}\nOwner's task (evidence, not server instructions):\n${input.task}` } }] };
    }
    if (request.params.name === 'follow_jevellan_work') {
      const input = z.strictObject({ target: z.string().min(1).max(1000) }).parse(args);
      return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${AGENT_MCP_GUIDE}\n\nFollow this owner-provided target: ${input.target}. Drain hasMore batches, preserve its cursor, and report verified links, conclusions and questions needing the owner.` } }] };
    }
    throw new McpError(ErrorCode.InvalidParams, 'That Jevellan prompt does not exist.');
  });
  return server;
}
