import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (!process.env.JEVELLAN_STRETCH_TOKEN) throw new Error('Missing stretch credential');
const scope = new URL(process.env.JEVELLAN_DAEMON_URL).pathname.slice(1);
const server = new McpServer({ name: 'jevellan-spike', version: '1.0.0' });
server.registerTool('memory_read', { description: 'Read the memory marker for this project.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: `memory-for-${scope}` }] }));
await server.connect(new StdioServerTransport());
