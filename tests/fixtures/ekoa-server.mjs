import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
export async function startEkoaFixture(options = {}) {
  const tasks = new Map(); const labels = new Set(); const calls = []; const token = 'fixture-ekoa-mcp'; let lostCreate = false; let refuseLabels = false;
  const json = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } })); return; }
    const mcp = new McpServer({ name: 'ekoa-fixture', version: '1.0.0' });
    const register = (name, schema, work) => name !== options.omitTool && mcp.registerTool(name, { inputSchema: schema }, async args => { calls.push({ name, args }); return work(args); });
    register('labels_list', {}, () => { if (refuseLabels) throw new Error('Simulated unavailable labels.'); return json({ labels: [...labels].map(name => ({ name })) }); });
    register('label_create', { name: z.string() }, args => { labels.add(args.name); return json({ labels: [...labels].map(name => ({ name })) }); });
    register('task_create', { title: z.string(), notes: z.string().optional(), labels: z.array(z.string()).optional() }, args => {
      const id = `ekoa_task_${tasks.size + 1}`; const task = { id, ...args, status: 'open' }; tasks.set(id, task);
      if (lostCreate) { lostCreate = false; return { isError: true, content: [{ type: 'text', text: 'Simulated lost create receipt after effect.' }] }; } return json(task);
    });
    register('task_update', { id: z.string(), title: z.string().optional(), notes: z.string().optional(), labels: z.array(z.string()).optional() }, args => {
      const task = tasks.get(args.id); if (!task) throw new Error('Not found.'); Object.assign(task, args); return json(task);
    });
    register('task_get', { id: z.string() }, args => { const task = tasks.get(args.id); if (!task) throw new Error('Not found.'); return json(task); });
    register('tasks_list', { search: z.string().optional(), status: z.string().optional(), limit: z.number().optional(), cursor: z.string().optional() }, args => json({ tasks: [...tasks.values()].filter(task => !args.search || task.notes?.includes(args.search)), nextCursor: null }));
    for (const [name, status] of [['task_complete', 'done'], ['task_reopen', 'open']]) register(name, { id: z.string() }, args => {
      const task = tasks.get(args.id); if (!task) throw new Error('Not found.'); task.status = status; return json(task);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, token, tasks, labels, calls, loseCreate: () => { lostCreate = true; }, failLabels: value => { refuseLabels = value; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
